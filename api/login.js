import { setSessionCookie } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured' });
  if (!body.password || body.password !== expected) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  setSessionCookie(res);
  return res.status(200).json({ ok: true });
}
