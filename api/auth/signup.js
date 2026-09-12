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

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'لازم تدخلي إيميل صحيح' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'الباسورد لازم يكون 6 محارف على الأقل' });
    }

    const dbUrl = process.env.DATABASE_URL;
    const jwtSecret = process.env.JWT_SECRET;
    if (!dbUrl || !jwtSecret) {
      return res.status(500).json({ error: 'إعدادات السيرفر ناقصة' });
    }

    const sql = neon(dbUrl);
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail}`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'في حساب مسجّل بهاد الإيميل من قبل' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const inserted = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${normalizedEmail}, ${passwordHash})
      RETURNING id, email, created_at
    `;
    const user = inserted[0];

    const token = jwt.sign({ userId: user.id, email: user.email }, jwtSecret, { expiresIn: '30d' });

    return res.status(201).json({
      token,
      user: { id: user.id, email: user.email }
    });

  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء إنشاء الحساب' });
  }
}
