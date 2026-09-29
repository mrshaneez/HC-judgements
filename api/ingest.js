import { ingestRows } from '../lib/db.js';
import { isCronAuthed } from '../lib/auth.js';

// Called by the GitHub Actions daily scraper.
// Auth: Authorization: Bearer <CRON_SECRET>
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isCronAuthed(req)) return res.status(401).json({ error: 'Bad or missing CRON_SECRET' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const items = Array.isArray(body) ? body : body.cases;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected an array of cases' });
    const result = await ingestRows(items);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
