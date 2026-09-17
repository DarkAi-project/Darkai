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
function cleanBase64Image(inputImage) {
  if (!inputImage || typeof inputImage !== 'string') {
    return null;
  }
  // إذا وصلت الصورة بالشكل:
  // data:image/png;base64,AAAA...
  // نشيل الـ prefix
  if (inputImage.includes(',')) {
    return inputImage.split(',')[1];
  }
  return inputImage;
}
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  // ==============================
  // 1. التحقق من تسجيل الدخول
  // ==============================
  const user = getUserFromToken(req);
  if (!user) {
    return res.status(401).json({
      error: 'لازم تسجلي دخول'
    });
  }
  // ==============================
  // 2. الاتصال بقاعدة البيانات
  // ==============================
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({
      error: 'إعدادات قاعدة البيانات ناقصة'
    });
  }
  const sql = neon(dbUrl);
  // تكلفة توليد الصورة
  const IMAGE_COST = 1;
  let creditsDeducted = false;
  try {
    // ==============================
    // 3. قراءة البيانات
    // ==============================
    const {
      prompt,
      inputImage,
      strength = 0.7,
      width = 768,
      height = 768
    } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({
        error: 'لازم ترسل وصف نصي للصورة'
      });
    }
    // ==============================
    // 4. خصم Credit بشكل آمن
    // ==============================
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
    const remainingCredits = deducted[0].credits;
    // ==============================
    // 5. Cloudflare settings
    // ==============================
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
    // ==============================
    // 6. تحديد نوع التوليد
    // ==============================
    const isImg2Img =
      typeof inputImage === 'string' &&
      inputImage.length > 100;
    /*
      Text → Image
      DreamShaper
      Image → Image
      Stable Diffusion v1.5 img2img
      Cloudflare يوثق stable-diffusion-v1-5-img2img
      كموديل مخصص للـ Image-to-Image.
    */
    const modelPath = isImg2Img
      ? '@cf/runwayml/stable-diffusion-v1-5-img2img'
      : '@cf/lykon/dreamshaper-8-lcm';
    const cfUrl =
      `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/ai/run/${modelPath}`;
    // ==============================
    // 7. تجهيز Request
    // ==============================
    const requestBody = {
      prompt: prompt.trim(),
      width: Number(width),
      height: Number(height)
    };
    // ==============================
    // 8. Image-to-Image
    // ==============================
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
        Cloudflare يقبل image_b64
        مباشرة في موديلات img2img.
      */
      requestBody.image_b64 = cleanedBase64;
      /*
        strength:
        0.2 - يحافظ على الصورة الأصلية بشكل كبير
        0.4 - تغيير متوسط
        0.6 - تغيير واضح
        0.8 - تغيير قوي
        1.0 - تغيير كبير جدًا
      */
      const safeStrength = Math.min(
        1,
        Math.max(
          0,
          Number(strength) || 0.7
        )
      );
      requestBody.strength = safeStrength;
      // إعدادات إضافية للجودة
      requestBody.num_steps = 20;
      requestBody.guidance = 7.5;
    }
    // ==============================
    // 9. إرسال الطلب إلى Cloudflare
    // ==============================
    const imgRes = await fetch(cfUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    // ==============================
    // 10. قراءة نوع الاستجابة
    // ==============================
    const contentType =
      imgRes.headers.get('content-type') || '';
    // ==============================
    // 11. التعامل مع أخطاء Cloudflare
    // ==============================
    if (!imgRes.ok) {
      let errorData = {};
      try {
        errorData = await imgRes.json();
      } catch (e) {
        errorData = {};
      }
      const cloudflareMessage =
        errorData?.errors?.[0]?.message ||
        errorData?.error ||
        'خطأ أثناء توليد الصورة من Cloudflare';
      // Refund
      await sql`
        UPDATE users
        SET credits = credits + ${IMAGE_COST}
        WHERE id = ${user.userId}
      `;
      creditsDeducted = false;
      console.error(
        'Cloudflare error:',
        errorData
      );
      return res.status(500).json({
        error: cloudflareMessage
      });
    }
    // ==============================
    // 12. Cloudflare أحيانًا يرجع JSON
    // ==============================
    if (
      contentType.includes('application/json')
    ) {
      const data = await imgRes.json();
      /*
        بعض موديلات Cloudflare قد ترجع
        النتيجة داخل object.
      */
      let imageBase64 =
        data?.result?.image ||
        data?.image;
      if (imageBase64) {
        const imageBuffer =
          Buffer.from(imageBase64, 'base64');
        if (
          !imageBuffer ||
          imageBuffer.length === 0
        ) {
          throw new Error(
            'Cloudflare returned empty image'
          );
        }
        const filename =
          `generated/${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}.png`;
        const blob = await put(
          filename,
          imageBuffer,
          {
            access: 'public',
            contentType: 'image/png',
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
      throw new Error(
        data?.errors?.[0]?.message ||
        'Cloudflare لم يرجع صورة'
      );
    }
    // ==============================
    // 13. قراءة الصورة الخام
    // ==============================
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
    // ==============================
    // 14. تحديد MIME Type
    // ==============================
    let mimeType = 'image/png';
    if (contentType.includes('jpeg')) {
      mimeType = 'image/jpeg';
    }
    if (contentType.includes('webp')) {
      mimeType = 'image/webp';
    }
    // ==============================
    // 15. تحديد الامتداد
    // ==============================
    let ext = 'png';
    if (mimeType === 'image/jpeg') {
      ext = 'jpg';
    }
    if (mimeType === 'image/webp') {
      ext = 'webp';
    }
    // ==============================
    // 16. رفع الصورة إلى Vercel Blob
    // ==============================
    const filename =
      `generated/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
    const blob = await put(
      filename,
      imageBuffer,
      {
        access: 'public',
        contentType: mimeType,
        token:
          process.env.BLOB_READ_WRITE_TOKEN ||
          process.env.public_READ_WRITE_TOKEN
      }
    );
    // ==============================
    // 17. نجاح العملية
    // ==============================
    return res.status(200).json({
      imageUrl: blob.url,
      mimeType,
      text: '',
      remainingCredits
    });
  } catch (err) {
    console.error(
      'Dark AI image generation error:',
      err
    );
    // ==============================
    // 18. Refund إذا حصل فشل
    // ==============================
    if (creditsDeducted) {
      try {
        await sql`
          UPDATE users
          SET credits = credits + ${IMAGE_COST}
          WHERE id = ${user.userId}
        `;
        creditsDeducted = false;
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
