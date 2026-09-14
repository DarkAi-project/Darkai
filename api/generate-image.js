import { put } from '@vercel/blob';

import { put } from '@vercel/blob';
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  const user = getUserFromToken(req);
  if (!user) {
    return res.status(401).json({ error: 'لازم تسجلي دخول' });
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: 'إعدادات السيرفر ناقصة' });
  }
  const sql = neon(dbUrl);

  const IMAGE_COST = 1;

  try {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'لازم ترسل وصف نصي للصورة' });
    }

    // خصم النقاط أولاً (بشكل آمن، ما بيخصم إذا الرصيد أقل من التكلفة)
    const deducted = await sql`
      UPDATE users SET credits = credits - ${IMAGE_COST}
      WHERE id = ${user.userId} AND credits >= ${IMAGE_COST}
      RETURNING credits
    `;
    if (deducted.length === 0) {
      return res.status(402).json({ error: 'رصيدك من النقاط خلص، اشحني رصيد جديد لتقدري تولدي صور' });
    }
    let remainingCredits = deducted[0].credits;

    const hfToken = process.env.HF_TOKEN;
    if (!hfToken) {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
      return res.status(500).json({ error: 'مفتاح Hugging Face غير مُعرَّف على السيرفر' });
    }

    const modelUrl = 'https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-3-medium-diffusers';

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
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
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
    const mimeType = contentType.includes('image/') ? contentType : 'image/png';

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
      return res.status(500).json({ error: 'ما قدر يولد الصورة، جرب وصف مختلف.' });
    }

    // رفع الصورة لـ Vercel Blob بدل إرجاعها كـ base64
    const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
    const filename = `generated/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const blob = await put(filename, Buffer.from(arrayBuffer), {
      access: 'public',
      contentType: mimeType,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    return res.status(200).json({ imageUrl: blob.url, mimeType, text: '', remainingCredits });

  } catch (err) {
    console.error('Server error:', err);
    try {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
    } catch (refundErr) {
      console.error('Refund error:', refundErr);
    }
    return res.status(500).json({ error: 'حدث خطأ غير متوقع على السيرفر' });
  }
}
