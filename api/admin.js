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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  const user = getUserFromToken(req);
  if (!user) {
    return res.status(401).json({ error: 'لازم تسجلي دخول' });
  }

  const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!adminEmail || user.email !== adminEmail) {
    return res.status(403).json({ error: 'ما إلك صلاحية الوصول لهاي الصفحة' });
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: 'إعدادات السيرفر ناقصة' });
  }
  const sql = neon(dbUrl);

  try {
    const action = req.query.action || 'stats';

    if (action === 'stats') {
      const [userCount] = await sql`SELECT COUNT(*)::int AS count FROM users`;
      const [convCount] = await sql`SELECT COUNT(*)::int AS count FROM conversations`;
      const [msgCount] = await sql`SELECT COUNT(*)::int AS count FROM messages`;
      const [imgCount] = await sql`SELECT COUNT(*)::int AS count FROM messages WHERE image_data IS NOT NULL`;
      const [newUsersToday] = await sql`
        SELECT COUNT(*)::int AS count FROM users
        WHERE created_at >= CURRENT_DATE
      `;

      return res.status(200).json({
        totalUsers: userCount.count,
        totalConversations: convCount.count,
        totalMessages: msgCount.count,
        totalImagesGenerated: imgCount.count,
        newUsersToday: newUsersToday.count
      });
    }

    if (action === 'users') {
      const users = await sql`
        SELECT
          u.id, u.email, u.created_at,
          COUNT(DISTINCT c.id)::int AS conversation_count,
          COUNT(m.id)::int AS message_count,
          MAX(m.created_at) AS last_activity
        FROM users u
        LEFT JOIN conversations c ON c.user_id = u.id
        LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY u.id, u.email, u.created_at
        ORDER BY u.created_at DESC
      `;
      return res.status(200).json({ users });
    }

    if (action === 'conversations') {
      const userId = req.query.userId;
      if (!userId) {
        return res.status(400).json({ error: 'لازم تحددي userId' });
      }
      const conversations = await sql`
        SELECT id, title, created_at FROM conversations
        WHERE user_id = ${userId}
        ORDER BY created_at DESC
      `;
      const conversationIds = conversations.map(c => c.id);
      let messages = [];
      if (conversationIds.length > 0) {
        messages = await sql`
          SELECT id, conversation_id, role, content, image_data, image_mime_type, attachments_json, created_at
          FROM messages
          WHERE conversation_id = ANY(${conversationIds})
          ORDER BY created_at ASC
        `;
      }
      const result = conversations.map(conv => ({
        id: conv.id,
        title: conv.title,
        created_at: conv.created_at,
        messages: messages
          .filter(m => m.conversation_id === conv.id)
          .map(m => ({
            role: m.role,
            content: m.content,
            hasImage: !!m.image_data,
            hasAttachments: !!m.attachments_json,
            created_at: m.created_at
          }))
      }));
      return res.status(200).json({ conversations: result });
    }

    return res.status(400).json({ error: 'action غير معروف' });

  } catch (err) {
    console.error('Admin error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
}
