const MODEL = 'gemini-3.8-flash-lite-tts';
const requestsByIp = new Map();

function overLimit(ip) {
  const now = Date.now();
  const recent = (requestsByIp.get(ip) || []).filter(timestamp => now - timestamp < 60_000);
  if (recent.length >= 20) {
    requestsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  requestsByIp.set(ip, recent);
  return false;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'AI speech is not configured' });

  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  if (overLimit(ip)) return res.status(429).json({ error: 'Please slow down and try again shortly' });

  const text = String(req.body?.text || '').trim();
  if (!text || text.length > 1800) return res.status(400).json({ error: 'Text must be between 1 and 1800 characters' });

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        model: MODEL,
        input: [{
          type: 'user_input',
          content: [{
            type: 'text',
            text,
            annotations: [{
              type: 'speech_metadata',
              style: 'Speak clearly at a measured, natural pace with crisp enunciation. Use a warm, calm, confident conversational tone and brief pauses between ideas.'
            }]
          }]
        }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: 'Kore' }] }
      })
    });

    if (!response.ok) return res.status(502).json({ error: 'Speech generation is temporarily unavailable' });
    const data = await response.json();
    const audio = (data.steps || []).flatMap(step => step.content || []).find(part => part.type === 'audio' && part.data);
    if (!audio?.data) return res.status(502).json({ error: 'Speech generation returned no audio' });

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(audio.data, 'base64'));
  } catch (_) {
    return res.status(500).json({ error: 'Could not generate speech' });
  }
};
