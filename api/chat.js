// api/chat.js
// نقطة الاتصال بين واجهة Dark AI ونموذج Gemini
// مفتاح الـ API بيضل سري هون بالسيرفر، ما بيوصله للمستخدم أبداً

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  // نسمح فقط بطلبات POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  try {
    const { messages } = req.body;
    // messages: مصفوفة فيها كل المحادثة، كل عنصر شكله { role: 'user' | 'ai', content: '...' }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'لازم ترسل messages كمصفوفة فيها رسالة وحدة عالأقل' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح Gemini غير مُعرَّف على السيرفر (GEMINI_API_KEY)' });
    }

    // نحوّل تاريخ المحادثة لصيغة Gemini
    // role: 'user' تضل user، و role: 'ai' تصير model
    const contents = messages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    }));

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash
:generateContent?key=${apiKey}`;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
        contents,
        systemInstruction: {
          parts: [{ text: 'أجب دائمًا بالتفصيل والوضوح باللغة العربية، وقدم إجابات كاملة ومفيدة دون اختصار مبالغ فيه.' }]
        },
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 2048
        }
      })
    });


    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Gemini API error:', data);
      return res.status(geminiRes.status).json({
        error: data?.error?.message || 'حدث خطأ أثناء التواصل مع Gemini'
      });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text
      || 'ما قدرت أطلع رد، جرب مرة ثانية.';

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع على السيرفر' });
  }
}
