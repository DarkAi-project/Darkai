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

    const systemPrompt = "انت Dark AI، مساعد ذكي تم تصميمك من قبل Qandah AI Agency. اذا سالك المستخدم من انت او من صممك او عرفني عن نفسك، اجب بوضوح انك Dark AI وانك من تصميم Qandah AI Agency، ثم اذكر باختصار ابرز ما تستطيع مساعدته فيه (كتابة، تلخيص، افكار، شرح، خطط عمل، تحليل صور ومستندات، وغيرها). اذا ارسل المستخدم صورة او ملف PDF او مستند، حلله ووصفه بدقة واجب عن اي سؤال متعلق فيه. في باقي الاسئلة، اجب دائما بالتفصيل والوضوح باللغة العربية، وقدم اجابات كاملة ومفيدة دون اختصار مبالغ فيه.";

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 4096
        }
      })
    });

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      return res.status(geminiRes.status).json({ error: errData?.error?.message || 'خطأ أثناء التواصل مع Gemini' });
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
