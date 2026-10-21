const SYSTEM = `You are a warm, concise SaaS sales assistant on a discovery call. Ask one question at a time. Understand the buyer's workflow, needs, budget, objections and timeline. Explain benefits in plain language without inventing product features, prices or guarantees. The demo product is a customizable workflow platform; if asked for specifics you do not know, say a specialist can confirm them. Respect a no, do not pressure, and aim for a relevant next step. Reply in the same language as the customer. Keep spoken replies to 1-3 sentences.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'AI key is not configured' });
  try {
    const { messages = [] } = req.body || {};
    if (!Array.isArray(messages) || messages.length > 50) return res.status(400).json({ error: 'Invalid conversation' });
    const turns = messages.filter((message, index) => !(index === 0 && message.role === 'assistant')).map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', text: String(message.text || '').slice(0, 3000) }));
    const contents = [];
    for (const turn of turns) {
      const previous = contents[contents.length - 1];
      if (previous?.role === turn.role) previous.parts[0].text += `\n${turn.text}`;
      else contents.push({ role: turn.role, parts: [{ text: turn.text }] });
    }
    const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + encodeURIComponent(process.env.GEMINI_API_KEY), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig: { temperature: 0.6, maxOutputTokens: 180 } })
    });
    if (!upstream.ok) return res.status(502).json({ error: 'The AI service is temporarily unavailable' });
    const data = await upstream.json();
    const reply = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim();
    if (!reply) return res.status(502).json({ error: 'The AI returned an empty response' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ reply });
  } catch (_) {
    return res.status(500).json({ error: 'Could not reach the AI service' });
  }
};
