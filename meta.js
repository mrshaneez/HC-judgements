import { meta } from '../lib/db.js';

export default async function handler(req, res) {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await meta());
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
