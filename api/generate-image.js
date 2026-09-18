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
    const { prompt, inputImage } = req.body;
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

    const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const cfToken = process.env.CLOUDFLARE_API_TOKEN;
    if (!cfAccountId || !cfToken) {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
      return res.status(500).json({ error: 'إعدادات Cloudflare ناقصة على السيرفر' });
    }

    const isImg2Img = !!inputImage;
    const modelPath = isImg2Img
      ? '@cf/lykon/dreamshaper-8-lcm'
      : '@cf/stabilityai/stable-diffusion-xl-base-1.0';
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${modelPath}`;

    const requestBody = { prompt };
    if (isImg2Img) {
      const inputBuffer = Buffer.from(inputImage, 'base64');
      requestBody.image = Array.from(inputBuffer);
      requestBody.strength = 0.7;
    }

    const imgRes = await fetch(cfUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const contentType = imgRes.headers.get('content-type') || '';

    if (!imgRes.ok || contentType.includes('application/json')) {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
      const errData = await imgRes.json().catch(() => ({}));
      const message = errData?.errors?.[0]?.message || 'خطأ أثناء توليد الصورة';
      return res.status(imgRes.status || 500).json({ error: message });
    }

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
      token: process.env.public_READ_WRITE_TOKEN
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
