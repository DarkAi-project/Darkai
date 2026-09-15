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

function cleanBase64(value) {
  if (!value || typeof value !== 'string') return null;

  // إذا وصلت الصورة بهذا الشكل:
  // data:image/png;base64,AAAA...
  // نشيل الـ header ونخلي الـ base64 فقط
  if (value.startsWith('data:')) {
    const commaIndex = value.indexOf(',');
    if (commaIndex !== -1) {
      return value.slice(commaIndex + 1);
    }
  }

  return value;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'الطريقة غير مسموحة'
    });
  }

  const user = getUserFromToken(req);

  if (!user) {
    return res.status(401).json({
      error: 'لازم تسجلي دخول'
    });
  }

  const dbUrl = process.env.DATABASE_URL;

  if (!dbUrl) {
    return res.status(500).json({
      error: 'إعدادات قاعدة البيانات ناقصة'
    });
  }

  const sql = neon(dbUrl);

  const IMAGE_COST = 1;

  try {
    const body = req.body || {};

    const prompt =
      typeof body.prompt === 'string'
        ? body.prompt.trim()
        : '';

    /*
      imageBase64 اختياري.

      إذا غير موجود:
      Text → Image

      إذا موجود:
      Image → Image
    */
    const imageBase64 = cleanBase64(
      body.imageBase64 ||
      body.image_b64 ||
      body.imageBase64Data ||
      null
    );

    if (!prompt) {
      return res.status(400).json({
        error: 'لازم ترسل وصف نصي للصورة'
      });
    }

    // تحديد نوع العملية
    const mode = imageBase64
      ? 'image-to-image'
      : 'text-to-image';

    console.log('Image generation:', {
      userId: user.userId,
      mode
    });

    // خصم Credit بشكل آمن
    const deducted = await sql`
      UPDATE users
      SET credits = credits - ${IMAGE_COST}
      WHERE id = ${user.userId}
        AND credits >= ${IMAGE_COST}
      RETURNING credits
    `;

    if (deducted.length === 0) {
      return res.status(402).json({
        error: 'رصيدك من النقاط خلص، اشحني رصيد جديد لتقدري تولدي صور'
      });
    }

    const remainingCredits = deducted[0].credits;

    const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const cfToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!cfAccountId || !cfToken) {
      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;

      return res.status(500).json({
        error: 'إعدادات Cloudflare ناقصة على السيرفر'
      });
    }

    /*
      نفس موديل Cloudflare الموجود عندك.

      SDXL يدعم:
      - Text → Image
      - Image → Image
    */
    const model =
      '@cf/stabilityai/stable-diffusion-xl-base-1.0';

    const cfUrl =
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${model}`;

    const input = {
      prompt,

      // إعدادات مناسبة كبداية
      num_steps: 20,
      guidance: 7.5,
      width: 1024,
      height: 1024
    };

    /*
      إذا أرسل المستخدم صورة:
      يتحول الطلب إلى Image → Image
    */
    if (imageBase64) {
      input.image_b64 = imageBase64;

      /*
        0.35 = يحافظ على الصورة الأصلية أكثر
        0.55 = توازن
        0.75 = تغيير أقوى

        نبدأ بـ 0.55
      */
      input.strength = 0.55;
    }

    console.log('Calling Cloudflare:', {
      model,
      mode,
      hasImage: Boolean(imageBase64)
    });

    const imgRes = await fetch(cfUrl, {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },

      body: JSON.stringify(input)
    });

    const contentType =
      imgRes.headers.get('content-type') || '';

    /*
      Cloudflare قد يرجع JSON عند حدوث خطأ.
    */
    if (!imgRes.ok || contentType.includes('application/json')) {
      const errData = await imgRes.json().catch(() => ({}));

      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;

      const message =
        errData?.errors?.[0]?.message ||
        errData?.error ||
        'حدث خطأ أثناء توليد الصورة';

      console.error('Cloudflare image error:', errData);

      return res.status(imgRes.ok ? 500 : imgRes.status).json({
        error: message
      });
    }

    const arrayBuffer = await imgRes.arrayBuffer();

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;

      return res.status(500).json({
        error: 'ما قدر يولد الصورة، جرب وصف مختلف.'
      });
    }

    const mimeType =
      contentType.includes('image/')
        ? contentType
        : 'image/png';

    const ext =
      mimeType.includes('jpeg')
        ? 'jpg'
        : mimeType.includes('webp')
          ? 'webp'
          : 'png';

    const filename =
      `generated/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;

    /*
      تخزين الصورة في Vercel Blob
    */
    const blob = await put(
      filename,
      Buffer.from(arrayBuffer),
      {
        access: 'public',
        contentType: mimeType,
        token: process.env.PUBLIC_BLOB_READ_WRITE_TOKEN
      }
    );

    console.log('Image generated successfully:', {
      mode,
      imageUrl: blob.url,
      remainingCredits
    });

    return res.status(200).json({
      imageUrl: blob.url,
      mimeType,
      mode,
      text: '',
      remainingCredits
    });

  } catch (err) {
    console.error('Server error:', err);

    /*
      إذا صار خطأ بعد خصم الـ Credit:
      نرجعه للمستخدم.
    */
    try {
      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;
    } catch (refundErr) {
      console.error('Refund error:', refundErr);
    }

    return res.status(500).json({
      error: 'حدث خطأ غير متوقع على السيرفر'
    });
  }
}
