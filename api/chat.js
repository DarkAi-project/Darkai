// ==========================================
// التاريخ والوقت الحالي الحقيقي (من السيرفر)
// عشان الذكاء الاصطناعي يعرف دايمًا وين هو
// بالزمن، مش يعتمد على تاريخ تدريبه القديم
// ==========================================
function getCurrentDateContext() {
  const now = new Date();

  const jordanFormatter = new Intl.DateTimeFormat('ar-JO', {
    timeZone: 'Asia/Amman',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const formatted = jordanFormatter.format(now);

  return `معلومة مهمة جداً: التاريخ والوقت الحالي الفعلي الآن هو: ${formatted} (بتوقيت الأردن). اعتمدي هذا التاريخ دائماً كمرجع حقيقي ودقيق عند الإجابة عن أي سؤال متعلق بالتاريخ، السنة، الوقت، أو أي حدث "حالي" أو "حديث"، حتى لو كانت معلوماتك التدريبية تشير إلى تاريخ مختلف أو أقدم. لا تفترضي أبداً أن السنة الحالية هي غير ما هو مذكور هنا.`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'لازم ترسل messages كمصفوفة فيها رسالة وحدة عالأقل' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح Gemini غير مُعرَّف على السيرفر (GEMINI_API_KEY)' });
    }

    const contents = messages.map(m => {
      const parts = [];
      if (m.content) {
        parts.push({ text: m.content });
      }
      if (m.attachments && Array.isArray(m.attachments)) {
        m.attachments.forEach(att => {
          if (att && att.data && att.mimeType) {
            parts.push({ inlineData: { mimeType: att.mimeType, data: att.data } });
          }
        });
      }
      if (parts.length === 0) {
        parts.push({ text: '' });
      }
      return {
        role: m.role === 'user' ? 'user' : 'model',
        parts
      };
    });

    const systemPrompt = "انت Dark AI، مساعد ذكي تم تصميمك من قبل Qandah AI Agency. اذا سالك المستخدم من انت او من صممك او عرفني عن نفسك، اجب بوضوح انك Dark AI وانك من تصميم Qandah AI Agency، ثم اذكر باختصار ابرز ما تستطيع مساعدته فيه (كتابة، تلخيص، افكار، شرح، خطط عمل، تحليل صور ومستندات، وغيرها). اذا ارسل المستخدم صورة او ملف PDF او مستند، حلله ووصفه بدقة واجب عن اي سؤال متعلق فيه. في باقي الاسئلة، اجب دائما بالتفصيل والوضوح باللغة العربية، وقدم اجابات كاملة ومفيدة دون اختصار مبالغ فيه.\n\n" + getCurrentDateContext();

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

    const requestBody = JSON.stringify({
      contents,
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 4096
      }
    });

    // ==========================================
    // إعادة المحاولة التلقائية
    // بس للأخطاء المؤقتة (ازدحام/rate limit)
    // 503 = مزدحم مؤقتًا، 429 = طلبات كتيرة بوقت قصير
    // ==========================================
    const RETRYABLE_STATUS = [503, 429];
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 800; // نصف ثانية تقريبًا، بتزيد شوي كل محاولة

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    let geminiRes = null;
    let lastErrorData = {};

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      geminiRes = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody
      });

      if (geminiRes.ok) {
        break; // نجح، اطلعي من الحلقة
      }

      const isRetryable = RETRYABLE_STATUS.includes(geminiRes.status);
      const isLastAttempt = attempt === MAX_RETRIES;

      if (!isRetryable || isLastAttempt) {
        // خطأ نهائي (مش مؤقت) أو خلصت المحاولات
        lastErrorData = await geminiRes.json().catch(() => ({}));
        break;
      }

      // خطأ مؤقت وبعدنا عندنا محاولات: منستنى شوي ونعيد
      console.log(`Gemini busy (status ${geminiRes.status}), retrying... attempt ${attempt + 1}/${MAX_RETRIES}`);
      await sleep(RETRY_DELAY_MS * (attempt + 1)); // تأخير متزايد بسيط
    }

    if (!geminiRes.ok) {
      console.error('Cloudflare/Gemini Error after retries:', lastErrorData);
      const message =
        lastErrorData?.error?.message ||
        'الخدمة مزدحمة حاليًا، جربي بعد لحظات.';
      return res.status(geminiRes.status).json({ error: message });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            res.write(text);
          }
        } catch (e) {}
      }
    }

    res.end();

  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'حدث خطأ غير متوقع على السيرفر' });
    } else {
      res.end();
    }
  }
}
