import { readSession } from '../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = readSession(req);
  return res.status(200).json({ authed: !!s, role: s ? s.role : null, email: s ? s.email : null });
}
