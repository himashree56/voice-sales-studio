const STATUSES = ['Converted', 'Interested', 'Follow-up Required', 'Not Interested', 'Demo Requested', 'No Response'];
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'AI key is not configured' });
  try {
    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length > 100) return res.status(400).json({ error: 'Invalid conversation' });
    const transcript = messages.map(m => `${m.role === 'assistant' ? 'Assistant' : 'Customer'}: ${String(m.text || '').slice(0, 3000)}`).join('\n');
    const prompt = `Analyze this sales call transcript. Return only valid JSON with keys overview, needs, objections, next, status. status must be exactly one of: ${STATUSES.join(', ')}. Use No Response if the customer never spoke. Respect an explicit rejection as Not Interested.\n\n${transcript}`;
    const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 350, responseMimeType: 'application/json' } })
    });
    if (!upstream.ok) return res.status(502).json({ error: 'The AI service is temporarily unavailable' });
    const data = await upstream.json();
    const result = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    if (!STATUSES.includes(result.status)) result.status = 'No Response';
    for (const key of ['overview', 'needs', 'objections', 'next']) result[key] = String(result[key] || 'Not captured').slice(0, 500);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (_) {
    return res.status(500).json({ error: 'Could not summarize this call' });
  }
};
