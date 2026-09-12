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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

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
    if (req.method === 'GET') {
      const conversations = await sql`
        SELECT id, title, created_at FROM conversations
        WHERE user_id = ${user.userId}
        ORDER BY created_at DESC
      `;

      const conversationIds = conversations.map(c => c.id);
      let messages = [];
      if (conversationIds.length > 0) {
        messages = await sql`
          SELECT id, conversation_id, role, content, image_data, image_mime_type, created_at
          FROM messages
          WHERE conversation_id = ANY(${conversationIds})
          ORDER BY created_at ASC
        `;
      }

      const result = conversations.map(conv => ({
        id: conv.id,
        title: conv.title,
        messages: messages
          .filter(m => m.conversation_id === conv.id)
          .map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            generatedImage: m.image_data
              ? { url: `data:${m.image_mime_type || 'image/png'};base64,${m.image_data}` }
              : null
          }))
      }));

      return res.status(200).json({ conversations: result });
    }

    if (req.method === 'POST') {
      const { title } = req.body || {};
      const inserted = await sql`
        INSERT INTO conversations (user_id, title)
        VALUES (${user.userId}, ${title || 'محادثة جديدة'})
        RETURNING id, title, created_at
      `;
      return res.status(201).json({ conversation: inserted[0] });
    }

    return res.status(405).json({ error: 'الطريقة غير مسموحة' });

  } catch (err) {
    console.error('Conversations error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
}
