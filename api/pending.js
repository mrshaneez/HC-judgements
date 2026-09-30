import { pendingText } from '../lib/db.js';
import { isCronAuthed } from '../lib/auth.js';

// Used by the text-backfill scraper to find cases that still need text.
// Auth: Authorization: Bearer <CRON_SECRET>
export default async function handler(req, res) {
  if (!isCronAuthed(req)) return res.status(401).json({ error: 'Bad or missing CRON_SECRET' });
  try {
    const limit = req.query.limit || 100;
    return res.status(200).json({ pending: await pendingText(limit) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
