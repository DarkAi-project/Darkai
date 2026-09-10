export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ isImageRequest: false, englishPrompt: '' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح Gemini غير مُعرَّف' });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const prompt = `You are an intent classifier. The user sent this message (could be Arabic or English): "${text}"

Determine if the user is asking to GENERATE, DRAW, CREATE, or MAKE an image/picture/drawing (not asking to analyze an uploaded image, just asking to create a new one).

Reply with ONLY valid JSON, nothing else, in this exact format:
{"isImageRequest": true or false, "englishPrompt": "short english description of the image if isImageRequest is true, otherwise empty string"}`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
      })
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(200).json({ isImageRequest: false, englishPrompt: '' });
    }

    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch(e) {
      parsed = { isImageRequest: false, englishPrompt: '' };
    }

    return res.status(200).json({
      isImageRequest: !!parsed.isImageRequest,
      englishPrompt: parsed.englishPrompt || ''
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(200).json({ isImageRequest: false, englishPrompt: '' });
  }
}
