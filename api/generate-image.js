import { put } from '@vercel/blob';
import { neon } from '@neondatabase/serverless';
import jwt from 'jsonwebtoken';

function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ')
    ? auth.slice(7)
    : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    console.error('JWT error:', error);
    return null;
  }
}

function getBase64Image(inputImage) {
  if (!inputImage || typeof inputImage !== 'string') {
    return null;
  }
  // يدعم:
  // data:image/png;base64,XXXX
  // data:image/jpeg;base64,XXXX
  // أو Base64 فقط
  if (inputImage.includes(',')) {
    return inputImage.split(',')[1];
  }
  return inputImage;
}

function getMimeType(inputImage) {
  if (
    typeof inputImage === 'string' &&
    inputImage.startsWith('data:')
  ) {
    const match =
      inputImage.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
    if (match) {
      return match[1];
    }
  }
  return 'image/png';
}

export default async function handler(req, res) {
  // ==========================================
  // CORS
  // ==========================================
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
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  // ==========================================
  // Authentication
  // ==========================================
  const user = getUserFromToken(req);
  if (!user) {
    return res.status(401).json({ error: 'لازم تسجلي دخول' });
  }

  // ==========================================
  // Database
  // ==========================================
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: 'إعدادات قاعدة البيانات ناقصة' });
  }
  const sql = neon(dbUrl);

  const IMAGE_COST = 1;
  let creditsDeducted = false;

  // ==========================================
  // Blob Token (public read/write token)
  // ==========================================
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!blobToken) {
    return res.status(500).json({
      error: 'إعدادات Vercel Blob ناقصة على السيرفر (BLOB_READ_WRITE_TOKEN)'
    });
  }

  try {
    // ==========================================
    // Request Data
    // ==========================================
    const { prompt, inputImage, strength = 0.7 } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'لازم ترسل وصف نصي للصورة' });
    }

    // ==========================================
    // Deduct Credit
    // ==========================================
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

    creditsDeducted = true;
    const remainingCredits = deducted[0].credits;

    // ==========================================
    // Cloudflare Settings
    // ==========================================
    const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const cfToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!cfAccountId || !cfToken) {
      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;
      creditsDeducted = false;
      return res.status(500).json({ error: 'إعدادات Cloudflare ناقصة على السيرفر' });
    }

    // ==========================================
    // Detect Image-to-Image
    // ==========================================
    const isImg2Img =
      typeof inputImage === 'string' && inputImage.length > 100;

    // ==========================================
    // Cloudflare Model
    // ==========================================
    const modelPath = '@cf/lykon/dreamshaper-8-lcm';
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${modelPath}`;

    // ==========================================
    // Base Request
    // ==========================================
    const requestBody = {
      prompt: prompt.trim(),
      num_steps: 20,
      guidance: 7.5
    };

    // ==========================================
    // IMAGE TO IMAGE
    // ==========================================
    if (isImg2Img) {
      const base64 = getBase64Image(inputImage);

      if (!base64) {
        await sql`
          UPDATE users
          SET credits = credits + ${IMAGE_COST}
          WHERE id = ${user.userId}
        `;
        creditsDeducted = false;
        return res.status(400).json({ error: 'الصورة المرسلة غير صالحة' });
      }

      let imageBuffer;
      try {
        imageBuffer = Buffer.from(base64, 'base64');
      } catch (error) {
        throw new Error('تعذر تحويل الصورة إلى بيانات');
      }

      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error('الصورة المرسلة فارغة');
      }

      /*
       * Cloudflare documents the "image"
       * parameter as an array of unsigned
       * 8-bit integers.
       *
       * لذلك نرسل Buffer -> Array
       */
      requestBody.image = Array.from(imageBuffer);

      /*
       * مهم:
       * لا نرسل image_b64 مع image
       * في نفس الطلب.
       */
      let safeStrength = Number(strength);
      if (Number.isNaN(safeStrength)) {
        safeStrength = 0.7;
      }
      safeStrength = Math.min(1, Math.max(0, safeStrength));
      requestBody.strength = safeStrength;

      console.log('Dark AI IMG2IMG:', {
        imageBytes: imageBuffer.length,
        strength: safeStrength
      });
    }

    // ==========================================
    // Cloudflare Request
    // ==========================================
    const imgRes = await fetch(cfUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    // ==========================================
    // Response Content Type
    // ==========================================
    const contentType = imgRes.headers.get('content-type') || '';

    // ==========================================
    // Cloudflare Error
    // ==========================================
    if (!imgRes.ok) {
      let errorData = {};
      try {
        errorData = await imgRes.json();
      } catch (error) {
        errorData = {};
      }

      console.error('Cloudflare Error:', errorData);

      const message =
        errorData?.errors?.[0]?.message ||
        errorData?.result?.error ||
        errorData?.error ||
        'خطأ أثناء توليد الصورة من Cloudflare';

      // Refund
      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;
      creditsDeducted = false;

      return res.status(500).json({ error: message });
    }

    // ==========================================
    // JSON Response
    // ==========================================
    if (contentType.includes('application/json')) {
      const data = await imgRes.json();
      console.log('Cloudflare JSON response received');

      let imageBase64 = data?.result?.image || data?.image;

      if (imageBase64 && typeof imageBase64 === 'string') {
        if (imageBase64.includes(',')) {
          imageBase64 = imageBase64.split(',')[1];
        }

        const imageBuffer = Buffer.from(imageBase64, 'base64');

        if (!imageBuffer || imageBuffer.length === 0) {
          throw new Error('الصورة الناتجة فارغة');
        }

        // ==========================================
        // Upload To Vercel Blob (Public)
        // ==========================================
        const filename = `generated/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}.png`;

        const blob = await put(filename, imageBuffer, {
          access: 'public',
          contentType: 'image/png',
          token: blobToken
        });

        return res.status(200).json({
          imageUrl: blob.url,
          mimeType: 'image/png',
          text: '',
          remainingCredits
        });
      }

      console.error('Unexpected Cloudflare JSON:', data);
      throw new Error(
        data?.errors?.[0]?.message ||
        data?.result?.error ||
        'Cloudflare لم يرجع صورة'
      );
    }

    // ==========================================
    // Raw Image Response
    // ==========================================
    const arrayBuffer = await imgRes.arrayBuffer();

    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('الصورة الناتجة فارغة');
    }

    const imageBuffer = Buffer.from(arrayBuffer);

    // ==========================================
    // MIME
    // ==========================================
    let mimeType = 'image/png';
    if (contentType.includes('image/jpeg')) {
      mimeType = 'image/jpeg';
    }
    if (contentType.includes('image/webp')) {
      mimeType = 'image/webp';
    }

    // ==========================================
    // Extension
    // ==========================================
    let ext = 'png';
    if (mimeType === 'image/jpeg') {
      ext = 'jpg';
    }
    if (mimeType === 'image/webp') {
      ext = 'webp';
    }

    // ==========================================
    // Upload (Public)
    // ==========================================
    const filename = `generated/${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;

    const blob = await put(filename, imageBuffer, {
      access: 'public',
      contentType: mimeType,
      token: blobToken
    });

    // ==========================================
    // SUCCESS
    // ==========================================
    console.log('Dark AI image generated successfully');

    return res.status(200).json({
      imageUrl: blob.url,
      mimeType,
      text: '',
      remainingCredits
    });
  } catch (error) {
    console.error('Dark AI image server error:', error);

    // ==========================================
    // REFUND
    // ==========================================
    if (creditsDeducted) {
      try {
        await sql`
          UPDATE users
          SET credits = credits + ${IMAGE_COST}
          WHERE id = ${user.userId}
        `;
        console.log('Credit refunded');
      } catch (refundError) {
        console.error('Refund error:', refundError);
      }
    }

    return res.status(500).json({
      error: error?.message || 'حدث خطأ أثناء توليد الصورة. جرب مرة ثانية.'
    });
  }
}
