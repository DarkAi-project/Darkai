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
      return res.status(200).json({ isImageRequest: false, englishPrompt: '' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(200).json({ isImageRequest: false, englishPrompt: '' });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const prompt = `Message: "${text}"

Is this message asking to GENERATE, DRAW, CREATE, DESIGN, or MAKE a new image/picture/drawing? (not analyzing an existing uploaded image)

Respond with ONLY this JSON format, no explanation, no markdown, no extra text:
{"isImageRequest": true, "englishPrompt": "a short english image description"}
or
{"isImageRequest": false, "englishPrompt": ""}`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 150 }
      })
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(200).json({ isImageRequest: false, englishPrompt: '' });
    }

    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    const match = raw.match(/\{[\s\S]*\}/);
    let parsed = { isImageRequest: false, englishPrompt: '' };
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch(e) {}
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
