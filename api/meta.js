import { meta } from '../lib/db.js';
import { isAuthed } from '../lib/auth.js';

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await meta());
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
