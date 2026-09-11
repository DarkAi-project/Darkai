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

    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) {
      return res.status(500).json({ error: 'مفتاح Hugging Face غير مُعرَّف على السيرفر' });
    }

    const modelUrl = 'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell';

    const imgRes = await fetch(modelUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${hfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: prompt })
    });

    // لو صار خطأ، Hugging Face بيرجع JSON فيه تفاصيل الخطأ
    const contentType = imgRes.headers.get('content-type') || '';

    if (!imgRes.ok || contentType.includes('application/json')) {
      const errData = await imgRes.json().catch(() => ({}));
      const message =
        errData?.error ||
        (imgRes.status === 503
          ? 'النموذج عم يشتغل حالياً، جربي كمان بعد ثواني'
          : 'خطأ أثناء توليد الصورة');
      return res.status(imgRes.status === 503 ? 503 : imgRes.status).json({ error: message });
    }

    // Hugging Face بيرجع بايتات الصورة مباشرة (مش JSON)
    const arrayBuffer = await imgRes.arrayBuffer();
    const imageData = Buffer.from(arrayBuffer).toString('base64');
    const mimeType = contentType.includes('image/') ? contentType : 'image/png';

    if (!imageData) {
      return res.status(500).json({ error: 'ما قدر يولد الصورة، جرب وصف مختلف.' });
    }

    return res.status(200).json({ image: imageData, mimeType, text: '' });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع على السيرفر' });
  }
}
