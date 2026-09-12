import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { return res.status(200).end(); }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'الطريقة غير مسموحة' });
  }

  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'لازم تدخلي الإيميل والباسورد' });
    }

    const dbUrl = process.env.DATABASE_URL;
    const jwtSecret = process.env.JWT_SECRET;
    if (!dbUrl || !jwtSecret) {
      return res.status(500).json({ error: 'إعدادات السيرفر ناقصة' });
    }

    const sql = neon(dbUrl);
    const normalizedEmail = email.trim().toLowerCase();

    const rows = await sql`SELECT id, email, password_hash FROM users WHERE email = ${normalizedEmail}`;
    if (rows.length === 0) {
      return res.status(401).json({ error: 'الإيميل أو الباسورد غلط' });
    }

    const user = rows[0];
    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'الإيميل أو الباسورد غلط' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, jwtSecret, { expiresIn: '30d' });

    return res.status(200).json({
      token,
      user: { id: user.id, email: user.email }
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء تسجيل الدخول' });
  }
}
