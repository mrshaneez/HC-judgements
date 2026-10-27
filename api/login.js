import { setSessionCookie } from '../lib/auth.js';
import { verifyUser } from '../lib/db.js';

// Admin logs in with the admin password (email blank or "admin").
// Access-given users log in with their email + password.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const adminPw = process.env.ADMIN_PASSWORD;

    // Master admin login (always available — never locks you out).
    if ((!email || email === 'admin') && adminPw && password === adminPw) {
      setSessionCookie(res, { email: 'admin', role: 'admin' });
      return res.status(200).json({ ok: true, role: 'admin' });
    }
    // Access-given user login.
    if (email) {
      const u = await verifyUser(email, password);
      if (u) { setSessionCookie(res, u); return res.status(200).json({ ok: true, role: u.role }); }
    }
    return res.status(401).json({ error: 'Incorrect email or password' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
