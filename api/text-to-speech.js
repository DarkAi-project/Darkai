import jwt from 'jsonwebtoken';

function getUserFromToken(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// ==========================================
// تحويل الصوت الخام (PCM) الراجع من Gemini
// إلى ملف WAV قابل للتشغيل مباشرة بالمتصفح
// ==========================================
function pcmToWav(pcmBuffer, sampleRate = 24000, numChannels = 1, bitDepth = 16) {
  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);
  const dataSize = pcmBuffer.length;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);

  return buffer;
}

// استخراج معدل العينة (sample rate) من mimeType الراجع من Gemini
// مثال: "audio/L16;codec=pcm;rate=24000"
function extractSampleRate(mimeType) {
  if (!mimeType) return 24000;
  const match = mimeType.match(/rate=(\d+)/);
  return match ? parseInt(match[1], 10) : 24000;
}

const ALLOWED_VOICES = [
  'Kore', 'Puck', 'Charon', 'Leda', 'Fenrir', 'Aoede',
  'Orus', 'Callirrhoe', 'Autonoe', 'Zephyr'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  const user = getUserFromToken(req);
  if (!user) {
    return res.status(401).json({ error: 'لازم تسجلي دخول' });
  }

  try {
    const { text, voiceName } = req.body || {};

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'لازم ترسل نص لتحويله لصوت' });
    }

    // حد أقصى لطول النص عشان ما تصير فاتورة ضخمة من طلب واحد غلط
    const safeText = text.trim().slice(0, 3000);

    const voice = ALLOWED_VOICES.includes(voiceName) ? voiceName : 'Kore';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح Gemini غير مُعرَّف على السيرفر' });
    }

    const ttsUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${apiKey}`;

    const ttsRes = await fetch(ttsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: safeText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice }
            }
          }
        }
      })
    });

    if (!ttsRes.ok) {
      const errData = await ttsRes.json().catch(() => ({}));
      console.error('Gemini TTS error:', errData);
      return res.status(ttsRes.status).json({
        error: errData?.error?.message || 'تعذر توليد الصوت من Gemini'
      });
    }

    const data = await ttsRes.json();
    const part = data?.candidates?.[0]?.content?.parts?.[0];
    const base64Pcm = part?.inlineData?.data;
    const mimeType = part?.inlineData?.mimeType || '';

    if (!base64Pcm) {
      console.error('Unexpected TTS response:', JSON.stringify(data).slice(0, 500));
      return res.status(500).json({ error: 'Gemini ما رجع صوت' });
    }

    const pcmBuffer = Buffer.from(base64Pcm, 'base64');
    const sampleRate = extractSampleRate(mimeType);
    const wavBuffer = pcmToWav(pcmBuffer, sampleRate);

    return res.status(200).json({
      audio: wavBuffer.toString('base64'),
      mimeType: 'audio/wav'
    });

  } catch (err) {
    console.error('TTS server error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء توليد الصوت' });
  }
}
