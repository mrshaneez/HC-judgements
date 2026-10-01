import { ensureDb, ingestRows } from '../lib/db.js';
import { sql } from '@vercel/postgres';
import { isAuthed } from '../lib/auth.js';

// Combined admin endpoint (all admin-only). Actions:
//   GET  ?action=stats                      -> dashboard + analytics aggregates
//   POST {action:'sync', limit}             -> pull newest judgments from the court feed
//   POST {action:'run', mode, year}         -> trigger a GitHub Actions run (needs GITHUB_TOKEN)
//   POST {action:'reextract', id|allMissing}-> queue judgment(s) for text re-extraction
export const maxDuration = 60;

const DATA_URL  = process.env.DATA_URL  || 'https://highcourt.gov.mv/dv/connects/getmydecisionsfull.php';
const PDF_BASE  = process.env.PDF_BASE  || 'https://highcourt.gov.mv/dhi/mediamanager/';
const DECISIONS = 'https://highcourt.gov.mv/dv/decisions.php';
const REPO      = process.env.GITHUB_REPO || 'mrshaneez/HC-judgements';

async function stats() {
  const one = async (q) => (await q).rows[0].n;
  const total       = await one(sql`SELECT COUNT(*)::int AS n FROM cases;`);
  const withText    = await one(sql`SELECT COUNT(*)::int AS n FROM cases WHERE full_text <> '';`);
  const needsReview = await one(sql`SELECT COUNT(*)::int AS n FROM cases WHERE presiding_en IS NULL OR trim(presiding_en) = '';`);
  const scanned     = await one(sql`SELECT COUNT(*)::int AS n FROM cases WHERE text_tried = TRUE AND (full_text IS NULL OR full_text = '') AND pdf_url <> '';`);
  const pending     = await one(sql`SELECT COUNT(*)::int AS n FROM cases WHERE (full_text IS NULL OR full_text = '') AND text_tried = FALSE AND pdf_url <> '';`);
  const locked      = await one(sql`SELECT COUNT(*)::int AS n FROM cases WHERE locked = TRUE;`);

  const years = (await sql`SELECT year, COUNT(*)::int AS n FROM cases WHERE year IS NOT NULL GROUP BY year ORDER BY year;`).rows;
  const types = (await sql`SELECT case_type, COUNT(*)::int AS n FROM cases WHERE case_type <> '' GROUP BY case_type ORDER BY case_type;`).rows;

  const jbase = (await sql`SELECT name_en, name_dv FROM judges WHERE active ORDER BY name_en;`).rows;
  const judges = [];
  for (const j of jbase) {
    const presided = (await sql`SELECT COUNT(*)::int AS n FROM cases WHERE trim(presiding_en) ILIKE trim(${j.name_en});`).rows[0].n;
    const enLike = '%' + j.name_en + '%';
    const dvLike = j.name_dv ? '%' + j.name_dv + '%' : '\u0000x\u0000';
    const bench = (await sql`SELECT COUNT(*)::int AS n FROM cases
      WHERE bench ILIKE ${enLike} OR presiding_en ILIKE ${enLike} OR bench ILIKE ${dvLike} OR presiding_dv ILIKE ${dvLike};`).rows[0].n;
    judges.push({ name_en: j.name_en, name_dv: j.name_dv, presided, bench });
  }
  const presidedByYear = (await sql`
    SELECT presiding_en, year, COUNT(*)::int AS n FROM cases
    WHERE presiding_en <> '' AND year IS NOT NULL GROUP BY presiding_en, year ORDER BY year;`).rows;

  return { totals: { total, withText, needsReview, scanned, pending, locked }, years, types, judges, presidedByYear };
}

async function sync(limitRaw) {
  const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 80, 1), 400);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  let records;
  try {
    const r = await fetch(DATA_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': DECISIONS,
      },
      signal: ctrl.signal,
    });
    records = JSON.parse(await r.text());
  } finally { clearTimeout(t); }
  if (!Array.isArray(records)) throw new Error('Unexpected feed format from the court website.');
  records.sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
  const items = [];
  for (const rec of records.slice(0, limit)) {
    const caseno = (rec.numbr || '').trim();
    const pdffile = (rec.pdffile || '').trim();
    if (!caseno || !pdffile) continue;
    items.push({
      caseno, date_concluded: (rec.created || '').trim(), pdf_url: PDF_BASE + pdffile,
      court: 'HC', source: 'needs-review',
      bench: (rec.fandiyaaru || '').trim(), disposition: (rec.massala || '').trim(),
    });
  }
  const result = await ingestRows(items);
  return { ...result, feedTotal: records.length, considered: items.length };
}

async function run(body) {
  const mode = body.mode === 'text' ? 'text' : 'enumerate';
  const file = mode === 'text' ? 'backfill-text.yml' : 'update.yml';
  const actionsUrl = `https://github.com/${REPO}/actions/workflows/${file}`;
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, needsToken: true, actionsUrl, message: 'No GITHUB_TOKEN set. Run it on the Actions page, or add a token for one-click runs.' };
  const inputs = (mode === 'enumerate' && body.year) ? { target_year: String(body.year) } : {};
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${file}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hcjudgements-admin', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  if (r.status === 204) return { ok: true, mode, actionsUrl, message: 'Started on GitHub. Watch progress on the Actions page.' };
  return { ok: false, actionsUrl, error: `GitHub API ${r.status}: ${(await r.text()).slice(0, 300)}` };
}

async function reextract(body) {
  if (body.id) {
    await sql`UPDATE cases SET full_text = '', text_tried = FALSE, updated_at = NOW() WHERE id = ${parseInt(body.id, 10)};`;
    return { ok: true, queued: 1 };
  }
  if (body.allMissing) {
    const r = await sql`UPDATE cases SET text_tried = FALSE WHERE (full_text IS NULL OR full_text = '') AND pdf_url <> '';`;
    return { ok: true, queued: r.rowCount || 0 };
  }
  throw new Error('id or allMissing required');
}

export default async function handler(req, res) {
  if (!isAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
  try {
    await ensureDb();
    if (req.method === 'GET') {
      const action = req.query.action || 'stats';
      if (action === 'stats') { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json(await stats()); }
      return res.status(400).json({ error: 'Unknown action' });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body.action === 'sync') return res.status(200).json(await sync(body.limit));
      if (body.action === 'run') return res.status(200).json(await run(body));
      if (body.action === 'reextract') return res.status(200).json(await reextract(body));
      return res.status(400).json({ error: 'Unknown action' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    const msg = String(e.message || e);
    const timedOut = /abort|timeout/i.test(msg);
    return res.status(timedOut ? 504 : 500).json({
      error: timedOut ? 'The court website was too slow to respond. Use "Run full fetch" (GitHub) instead.' : msg,
    });
  }
}
