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

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: 'إعدادات السيرفر ناقصة' });
  }
  const sql = neon(dbUrl);

  try {
    const rows = await sql`SELECT credits FROM users WHERE id = ${user.userId}`;
    if (rows.length === 0) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    return res.status(200).json({ credits: rows[0].credits });
  } catch (err) {
    console.error('Credits error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع' });
  }
}
