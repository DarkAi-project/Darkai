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

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
      return res.status(500).json({ error: 'مفتاح Gemini غير مُعرَّف على السيرفر' });
    }

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiKey}`;

    const imgRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
      })
    });

    const data = await imgRes.json();

    if (!imgRes.ok) {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
      return res.status(imgRes.status).json({ error: data?.error?.message || 'خطأ أثناء توليد الصورة' });
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    let base64Data = null;
    let mimeType = 'image/png';

    for (const part of parts) {
      if (part.inlineData) {
        base64Data = part.inlineData.data;
        mimeType = part.inlineData.mimeType || 'image/png';
        break;
      }
    }

    if (!base64Data) {
      await sql`UPDATE users SET credits = credits + ${IMAGE_COST} WHERE id = ${user.userId}`;
      return res.status(500).json({ error: 'ما قدر يولد الصورة، جرب وصف مختلف.' });
    }

    const arrayBuffer = Buffer.from(base64Data, 'base64');

    // رفع الصورة لـ Vercel Blob بدل إرجاعها كـ base64
    const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
    const filename = `generated/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const blob = await put(filename, arrayBuffer, {
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
