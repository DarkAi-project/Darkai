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
  } catch (e) {
    console.error('JWT error:', e);
    return null;
  }
}
function cleanBase64Image(inputImage) {
  if (!inputImage || typeof inputImage !== 'string') {
    return null;
  }
  // إزالة data:image/png;base64, أو data:image/jpeg;base64,
  if (inputImage.includes(',')) {
    return inputImage.split(',')[1];
  }
  return inputImage;
}
export default async function handler(req, res) {
  // ==========================================
  // CORS
  // ==========================================
  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );
  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );
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
  // ==========================================
  // Authentication
  // ==========================================
  const user = getUserFromToken(req);
  if (!user) {
    return res.status(401).json({
      error: 'لازم تسجلي دخول'
    });
  }
  // ==========================================
  // Database
  // ==========================================
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({
      error: 'إعدادات قاعدة البيانات ناقصة'
    });
  }
  const sql = neon(dbUrl);
  // تكلفة الصورة
  const IMAGE_COST = 1;
  let creditsDeducted = false;
  try {
    // ==========================================
    // قراءة البيانات
    // ==========================================
    const {
      prompt,
      inputImage,
      strength = 0.7
    } = req.body || {};
    if (
      !prompt ||
      typeof prompt !== 'string' ||
      !prompt.trim()
    ) {
      return res.status(400).json({
        error: 'لازم ترسل وصف نصي للصورة'
      });
    }
    // ==========================================
    // خصم Credit بشكل آمن
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
        error:
          'رصيدك من النقاط خلص، اشحني رصيد جديد لتقدري تولدي صور'
      });
    }
    creditsDeducted = true;
    const remainingCredits =
      deducted[0].credits;
    // ==========================================
    // Cloudflare Environment Variables
    // ==========================================
    const cfAccountId =
      process.env.CLOUDFLARE_ACCOUNT_ID;
    const cfToken =
      process.env.CLOUDFLARE_API_TOKEN;
    if (!cfAccountId || !cfToken) {
      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;
      creditsDeducted = false;
      return res.status(500).json({
        error:
          'إعدادات Cloudflare ناقصة على السيرفر'
      });
    }
    // ==========================================
    // تحديد Text-to-Image أو Image-to-Image
    // ==========================================
    const isImg2Img =
      typeof inputImage === 'string' &&
      inputImage.length > 100;
    // ==========================================
    // Cloudflare Model
    // ==========================================
    // DreamShaper 8 LCM
    // يدعم Text-to-Image و Image-to-Image
    const modelPath =
      '@cf/lykon/dreamshaper-8-lcm';
    const cfUrl =
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${modelPath}`;
    // ==========================================
    // Request Body
    // ==========================================
    const requestBody = {
      prompt: prompt.trim()
    };
    // ==========================================
    // Image-to-Image
    // ==========================================
    if (isImg2Img) {
      const cleanedBase64 =
        cleanBase64Image(inputImage);
      if (!cleanedBase64) {
        await sql`
          UPDATE users
          SET credits = credits + ${IMAGE_COST}
          WHERE id = ${user.userId}
        `;
        creditsDeducted = false;
        return res.status(400).json({
          error: 'الصورة المرسلة غير صالحة'
        });
      }
      /*
       * Cloudflare DreamShaper
       * يقبل image_b64
       */
      requestBody.image_b64 =
        cleanedBase64;
      /*
       * قوة التغيير:
       *
       * 0.2 = يحافظ على الأصل كثيرًا
       * 0.4 = تغيير خفيف
       * 0.6 = تغيير متوسط
       * 0.7 = تغيير واضح
       * 0.8 = تغيير قوي
       * 1.0 = تغيير شديد
       */
      let safeStrength =
        Number(strength);
      if (Number.isNaN(safeStrength)) {
        safeStrength = 0.7;
      }
      safeStrength =
        Math.min(
          1,
          Math.max(
            0,
            safeStrength
          )
        );
      requestBody.strength =
        safeStrength;
    }
    // ==========================================
    // إرسال الطلب إلى Cloudflare
    // ==========================================
    console.log(
      'Dark AI image request:',
      {
        userId: user.userId,
        img2img: isImg2Img,
        model: modelPath,
        strength: requestBody.strength || null
      }
    );
    const imgRes = await fetch(
      cfUrl,
      {
        method: 'POST',
        headers: {
          Authorization:
            `Bearer ${cfToken}`,
          'Content-Type':
            'application/json'
        },
        body: JSON.stringify(
          requestBody
        )
      }
    );
    // ==========================================
    // قراءة Content-Type
    // ==========================================
    const contentType =
      imgRes.headers.get(
        'content-type'
      ) || '';
    // ==========================================
    // Cloudflare Error
    // ==========================================
    if (!imgRes.ok) {
      let errorData = {};
      try {
        errorData =
          await imgRes.json();
      } catch (e) {
        errorData = {};
      }
      console.error(
        'Cloudflare API Error:',
        errorData
      );
      const cloudflareMessage =
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
      return res.status(500).json({
        error: cloudflareMessage
      });
    }
    // ==========================================
    // JSON Response
    // ==========================================
    if (
      contentType.includes(
        'application/json'
      )
    ) {
      const data =
        await imgRes.json();
      console.log(
        'Cloudflare JSON response received'
      );
      /*
       * Cloudflare ممكن يرجع الصورة
       * داخل result.image أو image
       */
      let imageBase64 =
        data?.result?.image ||
        data?.image;
      if (
        imageBase64 &&
        typeof imageBase64 === 'string'
      ) {
        // إزالة prefix إذا وجد
        if (
          imageBase64.includes(',')
        ) {
          imageBase64 =
            imageBase64.split(',')[1];
        }
        const imageBuffer =
          Buffer.from(
            imageBase64,
            'base64'
          );
        if (
          !imageBuffer ||
          imageBuffer.length === 0
        ) {
          throw new Error(
            'Cloudflare returned empty image'
          );
        }
        // ==========================================
        // رفع إلى Vercel Blob
        // ==========================================
        const filename =
          `generated/${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}.png`;
        const blob =
          await put(
            filename,
            imageBuffer,
            {
              access: 'public',
              contentType:
                'image/png',
              token:
                process.env.BLOB_READ_WRITE_TOKEN ||
                process.env.public_READ_WRITE_TOKEN
            }
          );
        return res.status(200).json({
          imageUrl: blob.url,
          mimeType: 'image/png',
          text: '',
          remainingCredits
        });
      }
      // إذا Cloudflare رجع JSON بدون صورة
      console.error(
        'Cloudflare response:',
        data
      );
      throw new Error(
        data?.errors?.[0]?.message ||
        data?.result?.error ||
        'Cloudflare لم يرجع صورة'
      );
    }
    // ==========================================
    // Raw Image Response
    // ==========================================
    const arrayBuffer =
      await imgRes.arrayBuffer();
    if (
      !arrayBuffer ||
      arrayBuffer.byteLength === 0
    ) {
      throw new Error(
        'الصورة الناتجة فارغة'
      );
    }
    const imageBuffer =
      Buffer.from(arrayBuffer);
    // ==========================================
    // MIME Type
    // ==========================================
    let mimeType =
      'image/png';
    if (
      contentType.includes(
        'image/jpeg'
      )
    ) {
      mimeType =
        'image/jpeg';
    }
    if (
      contentType.includes(
        'image/webp'
      )
    ) {
      mimeType =
        'image/webp';
    }
    // ==========================================
    // Extension
    // ==========================================
    let ext = 'png';
    if (
      mimeType === 'image/jpeg'
    ) {
      ext = 'jpg';
    }
    if (
      mimeType === 'image/webp'
    ) {
      ext = 'webp';
    }
    // ==========================================
    // Vercel Blob Filename
    // ==========================================
    const filename =
      `generated/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
    // ==========================================
    // Upload
    // ==========================================
    const blob =
      await put(
        filename,
        imageBuffer,
        {
          access: 'public',
          contentType:
            mimeType,
          token:
            process.env.BLOB_READ_WRITE_TOKEN ||
            process.env.public_READ_WRITE_TOKEN
        }
      );
    // ==========================================
    // Success
    // ==========================================
    console.log(
      'Dark AI image generated successfully'
    );
    return res.status(200).json({
      imageUrl: blob.url,
      mimeType,
      text: '',
      remainingCredits
    });
  } catch (err) {
    console.error(
      'Dark AI server error:',
      err
    );
    // ==========================================
    // Refund
    // ==========================================
    if (creditsDeducted) {
      try {
        await sql`
          UPDATE users
          SET credits = credits + ${IMAGE_COST}
          WHERE id = ${user.userId}
        `;
        console.log(
          'Credit refunded successfully'
        );
      } catch (refundErr) {
        console.error(
          'Refund error:',
          refundErr
        );
      }
    }
    return res.status(500).json({
      error:
        'حدث خطأ أثناء توليد الصورة. جرب مرة ثانية.'
    });
  }
}
