import { ensureDb } from '../lib/db.js';
import { sql } from '@vercel/postgres';
import { isAuthed } from '../lib/auth.js';

// CSV export of the whole library (opens in Excel). Admin only.
// ?text=1 also includes the full extracted text column.
export const maxDuration = 60;

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await ensureDb();
    const withText = req.query.text === '1';
    const { rows } = await sql`
      SELECT caseno, date_concluded, year, case_type, court, presiding_en, presiding_dv,
             bench, disposition, source, locked, pdf_url,
             (full_text IS NOT NULL AND full_text <> '') AS has_text, full_text
      FROM cases
      ORDER BY date_concluded DESC NULLS LAST, id DESC;`;

    const header = ['caseno', 'date_concluded', 'year', 'case_type', 'court', 'presiding_en',
      'presiding_dv', 'bench', 'disposition', 'source', 'locked', 'pdf_url', 'has_text']
      .concat(withText ? ['full_text'] : []);
    const q = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [header.join(',')];
    for (const r of rows) lines.push(header.map((h) => q(r[h])).join(','));
    const csv = '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8 (Thaana) correctly

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hc-judgments-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(csv);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
