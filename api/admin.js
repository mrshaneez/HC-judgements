import { ensureDb, ingestRows, listUsers, createUser, updateUser, deleteUser } from '../lib/db.js';
import { sql } from '@vercel/postgres';
import { isAdmin, isAuthed } from '../lib/auth.js';

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

async function stats(opts = {}) {
  const from = (opts.from || '').trim();
  const to = (opts.to || '').trim();
  const hasRange = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to);

  // One "presided" count for ALL judges via a single GROUP BY (was 1 query per judge).
  const presidedAgg = hasRange
    ? sql.query(`SELECT lower(trim(presiding_en)) AS pj, COUNT(*)::int AS n FROM cases WHERE date_concluded >= $1 AND date_concluded <= $2 GROUP BY lower(trim(presiding_en))`, [from, to])
    : sql`SELECT lower(trim(presiding_en)) AS pj, COUNT(*)::int AS n FROM cases GROUP BY lower(trim(presiding_en));`;

  // Every top-level aggregate fires together instead of one-at-a-time.
  const [totalR, withTextR, needsReviewR, scannedR, pendingR, lockedR, yearsR, typesR, jbaseR, presidedByYearR, presidedAggR] = await Promise.all([
    sql`SELECT COUNT(*)::int AS n FROM cases;`,
    sql`SELECT COUNT(*)::int AS n FROM cases WHERE full_text <> '';`,
    sql`SELECT COUNT(*)::int AS n FROM cases WHERE presiding_en IS NULL OR trim(presiding_en) = '';`,
    sql`SELECT COUNT(*)::int AS n FROM cases WHERE text_tried = TRUE AND (full_text IS NULL OR full_text = '') AND pdf_url <> '';`,
    sql`SELECT COUNT(*)::int AS n FROM cases WHERE (full_text IS NULL OR full_text = '') AND text_tried = FALSE AND pdf_url <> '';`,
    sql`SELECT COUNT(*)::int AS n FROM cases WHERE locked = TRUE;`,
    sql`SELECT year, COUNT(*)::int AS n FROM cases WHERE year IS NOT NULL GROUP BY year ORDER BY year;`,
    sql`SELECT case_type, COUNT(*)::int AS n FROM cases WHERE case_type <> '' GROUP BY case_type ORDER BY case_type;`,
    sql`SELECT name_en, name_dv FROM judges WHERE active ORDER BY name_en;`,
    sql`SELECT presiding_en, year, COUNT(*)::int AS n FROM cases WHERE presiding_en <> '' AND year IS NOT NULL GROUP BY presiding_en, year ORDER BY year;`,
    presidedAgg,
  ]);

  const presMap = new Map(presidedAggR.rows.map(r => [r.pj, r.n]));
  const jbase = jbaseR.rows;

  // Bench counts still need a per-judge pattern match on two name variants — but fire them all at once.
  const benchCounts = await Promise.all(jbase.map(j => {
    const enLike = '%' + j.name_en + '%';
    const dvLike = j.name_dv ? '%' + j.name_dv + '%' : '\u0000x\u0000';
    const p = hasRange
      ? sql.query(`SELECT COUNT(*)::int AS n FROM cases WHERE (bench ILIKE $1 OR presiding_en ILIKE $1 OR bench ILIKE $2 OR presiding_dv ILIKE $2) AND date_concluded >= $3 AND date_concluded <= $4`, [enLike, dvLike, from, to])
      : sql.query(`SELECT COUNT(*)::int AS n FROM cases WHERE bench ILIKE $1 OR presiding_en ILIKE $1 OR bench ILIKE $2 OR presiding_dv ILIKE $2`, [enLike, dvLike]);
    return p.then(r => r.rows[0].n);
  }));

  const judges = jbase.map((j, i) => ({
    name_en: j.name_en,
    name_dv: j.name_dv,
    presided: presMap.get(String(j.name_en || '').trim().toLowerCase()) || 0,
    bench: benchCounts[i],
  }));

  return {
    totals: {
      total: totalR.rows[0].n, withText: withTextR.rows[0].n, needsReview: needsReviewR.rows[0].n,
      scanned: scannedR.rows[0].n, pending: pendingR.rows[0].n, locked: lockedR.rows[0].n,
    },
    years: yearsR.rows, types: typesR.rows, judges, presidedByYear: presidedByYearR.rows,
    range: hasRange ? { from, to } : null,
  };
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
      bench: (rec.fandiyaaru || '').trim(), parties: (rec.massala || '').trim(),
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
  // Dashboard stats are available to any signed-in user (viewers + admins).
  if (req.method === 'GET' && (req.query.action || 'stats') === 'stats') {
    if (!isAuthed(req)) return res.status(401).json({ error: 'Not authenticated' });
    await ensureDb();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(await stats({ from: req.query.from, to: req.query.to }));
  }
  if (!isAdmin(req)) return res.status(401).json({ error: 'Admin only' });
  try {
    await ensureDb();
    if (req.method === 'GET') {
      const action = req.query.action || 'stats';
      if (action === 'stats') { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json(await stats({ from: req.query.from, to: req.query.to })); }
      if (action === 'users') { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json({ users: await listUsers() }); }
      return res.status(400).json({ error: 'Unknown action' });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body.action === 'sync') return res.status(200).json(await sync(body.limit));
      if (body.action === 'run') return res.status(200).json(await run(body));
      if (body.action === 'reextract') return res.status(200).json(await reextract(body));
      if (body.action === 'user-create') { if (!body.email || !body.password) return res.status(400).json({ error: 'Email and password required' }); return res.status(200).json({ user: await createUser(body.email, body.password, body.role) }); }
      if (body.action === 'user-update') { if (!body.id) return res.status(400).json({ error: 'id required' }); return res.status(200).json({ user: await updateUser(body.id, body) }); }
      if (body.action === 'user-delete') { if (!body.id) return res.status(400).json({ error: 'id required' }); await deleteUser(body.id); return res.status(200).json({ ok: true }); }
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
