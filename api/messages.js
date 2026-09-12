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

  try {
    const { conversationId, role, content, imageData, imageMimeType } = req.body;

    if (!conversationId || !role) {
      return res.status(400).json({ error: 'بيانات ناقصة' });
    }

    const owns = await sql`
      SELECT id FROM conversations WHERE id = ${conversationId} AND user_id = ${user.userId}
    `;
    if (owns.length === 0) {
      return res.status(403).json({ error: 'ما إلك صلاحية على هاي المحادثة' });
    }

    const inserted = await sql`
      INSERT INTO messages (conversation_id, role, content, image_data, image_mime_type)
      VALUES (${conversationId}, ${role}, ${content || null}, ${imageData || null}, ${imageMimeType || null})
      RETURNING id, created_at
    `;

    return res.status(201).json({ message: inserted[0] });

  } catch (err) {
    console.error('Messages error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
}
