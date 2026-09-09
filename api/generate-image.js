export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'لازم ترسل وصف نصي للصورة' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح Gemini غير مُعرَّف على السيرفر' });
    }

    const imageUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent?key=${apiKey}`;

    const imgRes = await fetch(imageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });

    const data = await imgRes.json();

    if (!imgRes.ok) {
      return res.status(imgRes.status).json({ error: data?.error?.message || 'خطأ أثناء توليد الصورة' });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    let imageData = null;
    let mimeType = null;
    let textReply = '';

    for (const part of parts) {
      if (part.inlineData) {
        imageData = part.inlineData.data;
        mimeType = part.inlineData.mimeType;
      } else if (part.text) {
        textReply += part.text;
      }
    }

    if (!imageData) {
      return res.status(500).json({ error: 'ما قدر يولد الصورة، جرب وصف مختلف.' });
    }

    return res.status(200).json({ image: imageData, mimeType, text: textReply });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع على السيرفر' });
  }
}
