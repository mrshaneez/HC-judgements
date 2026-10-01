import { sql } from '@vercel/postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Seed is optional — the database already holds the data after the first deploy.
// A missing/unbundled seed.json must never crash the module at import time.
let seed = [];
try { seed = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'seed.json'), 'utf8')); }
catch (e) { seed = []; }

// Canonical High Court judges (English + Dhivehi). Seeds the judges table.
const JUDGE_SEED = [
  ['Muhammad Shaniz Abdulla', 'މުޙައްމަދު ޝަނީޒް ޢަބްދުالله'],
  ['Huzaifa Muhammad', 'ހުޒައިފާ މުޙައްމަދު'],
  ['Fathimath Farheeza', 'ފާޠިމަތު ފަރުހީޒް'],
  ['Hassan Shafee', 'ޙަސަން ޝަފީޢު'],
  ['Abdul Raoof Ibrahim', 'ޢަބްދުއްރައޫފު އިބްރާހީމް'],
  ['Dheebanaz Fahmy', 'ދީބާނާޒް ފަހްމީ'],
  ['Hussain Mazeed', 'ޙުސައިން މަޒީދު'],
  ['Ismail Shafee', 'އިސްމާޢީލް ޝަފީޢު'],
  ['Ibrahim Mahir', 'އިބްރާހީމް މާހިރު'],
  ['Abdulla Jameel Moosa', 'ޢަބްދުالله ޖަމީލް މޫސާ'],
  ['Abdul Maanee Hussain', 'ޢަބްދުالމާނިޢު ޙުސައިން'],
];

let ready = false;

export function deriveMeta(caseno = '', date = '', pdf_url = '') {
  // year: prefer date, then basename timestamp (_ddmmyyyy...), then leading year in caseno
  let year = null;
  const md = /^(\d{4})-\d{2}-\d{2}/.exec(date || '');
  if (md) year = parseInt(md[1], 10);
  if (!year) {
    const mb = /_(\d{2})(\d{2})(\d{4})\d*\.(?:pdf|PDF)/.exec(pdf_url || '');
    if (mb) year = parseInt(mb[3], 10);
  }
  if (!year) {
    const mc = /(\d{4})/.exec(caseno || '');
    if (mc) year = parseInt(mc[1], 10);
  }
  // case_type: the class letter(s) after HC- (A = appeal, B = misc, etc.)
  let case_type = '';
  const mt = /HC-?([A-Za-z]+)/i.exec(caseno || '');
  if (mt) case_type = mt[1].toUpperCase();
  return { year: year || null, case_type };
}

// Run a statement but never let a single idempotent-migration hiccup take down
// the whole request. Columns/tables usually already exist, so failures here are
// safe to log and skip.
async function step(fn, label) {
  try { await fn(); } catch (e) { console.error('ensureDb step failed [' + label + ']:', e.message); }
}

export async function ensureDb() {
  if (ready) return;

  await step(() => sql`
    CREATE TABLE IF NOT EXISTS cases (
      id            SERIAL PRIMARY KEY,
      caseno        TEXT UNIQUE NOT NULL,
      date_concluded TEXT DEFAULT '',
      presiding_en  TEXT DEFAULT '',
      presiding_dv  TEXT DEFAULT '',
      bench         TEXT DEFAULT '',
      disposition   TEXT DEFAULT '',
      source        TEXT DEFAULT 'manual',
      pdf_url       TEXT DEFAULT '',
      locked        BOOLEAN DEFAULT FALSE,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );`, 'create cases');

  await step(() => sql`ALTER TABLE cases ADD COLUMN IF NOT EXISTS full_text TEXT DEFAULT '';`, 'full_text');
  await step(() => sql`ALTER TABLE cases ADD COLUMN IF NOT EXISTS court TEXT DEFAULT 'HC';`, 'court');
  await step(() => sql`ALTER TABLE cases ADD COLUMN IF NOT EXISTS case_type TEXT DEFAULT '';`, 'case_type');
  await step(() => sql`ALTER TABLE cases ADD COLUMN IF NOT EXISTS year INT;`, 'year');
  await step(() => sql`ALTER TABLE cases ADD COLUMN IF NOT EXISTS text_tried BOOLEAN DEFAULT FALSE;`, 'text_tried');

  await step(() => sql`
    CREATE TABLE IF NOT EXISTS judges (
      id         SERIAL PRIMARY KEY,
      name_en    TEXT UNIQUE NOT NULL,
      name_dv    TEXT DEFAULT '',
      active     BOOLEAN DEFAULT TRUE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );`, 'create judges');

  await step(async () => {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm;`;
    await sql`CREATE INDEX IF NOT EXISTS idx_cases_fulltext_trgm ON cases USING gin (full_text gin_trgm_ops);`;
  }, 'trgm index');
  await step(() => sql`CREATE INDEX IF NOT EXISTS idx_cases_year ON cases (year);`, 'idx year');
  await step(() => sql`CREATE INDEX IF NOT EXISTS idx_cases_type ON cases (case_type);`, 'idx type');
  await step(() => sql`CREATE INDEX IF NOT EXISTS idx_cases_presiding ON cases (presiding_en);`, 'idx presiding');

  // Seed cases once (only if the table is empty and a seed is bundled).
  await step(async () => {
    const { rows: c } = await sql`SELECT COUNT(*)::int AS n FROM cases;`;
    if (c[0].n === 0 && seed.length) {
      for (const x of seed) {
        const { year, case_type } = deriveMeta(x.caseno, x.date_concluded, x.pdf_url);
        await sql`
          INSERT INTO cases (caseno,date_concluded,presiding_en,presiding_dv,bench,disposition,source,pdf_url,locked,court,case_type,year)
          VALUES (${x.caseno},${x.date_concluded||''},${x.presiding_en||''},${x.presiding_dv||''},${x.bench||''},${x.disposition||''},${x.source||'text'},${x.pdf_url||''},${x.locked!==false},'HC',${case_type},${year})
          ON CONFLICT (caseno) DO NOTHING;`;
      }
    } else {
      const { rows: need } = await sql`SELECT id, caseno, date_concluded, pdf_url FROM cases WHERE year IS NULL LIMIT 500;`;
      for (const r of need) {
        const { year, case_type } = deriveMeta(r.caseno, r.date_concluded, r.pdf_url);
        await sql`UPDATE cases SET year=${year}, case_type=${case_type} WHERE id=${r.id};`;
      }
    }
  }, 'seed/backfill cases');

  await step(async () => {
    const { rows: j } = await sql`SELECT COUNT(*)::int AS n FROM judges;`;
    if (j[0].n === 0) {
      for (const [en, dv] of JUDGE_SEED) {
        await sql`INSERT INTO judges (name_en,name_dv) VALUES (${en},${dv}) ON CONFLICT (name_en) DO NOTHING;`;
      }
    }
  }, 'seed judges');

  ready = true;
}

const LIST_COLS = `id,caseno,date_concluded,presiding_en,presiding_dv,bench,disposition,source,pdf_url,locked,court,case_type,year,
  (full_text IS NOT NULL AND full_text <> '') AS has_text`;

export async function listCases(opts = {}) {
  await ensureDb();
  const { q = '', year = '', type = '', judge = '', source = '', page = 1, pageSize = 50 } = opts;
  const lim = Math.min(Math.max(parseInt(pageSize, 10) || 50, 1), 200);
  const off = (Math.max(parseInt(page, 10) || 1, 1) - 1) * lim;

  // Build the WHERE clause against a caller-supplied push(value)->index, so the
  // same logic can be reused for the count query and the data query (which has
  // extra snippet params before it, hence different starting indices).
  const buildWhere = (push) => {
    const w = [];
    if (q) { const i = push('%' + q + '%'); w.push(`(caseno ILIKE $${i} OR presiding_en ILIKE $${i} OR presiding_dv ILIKE $${i} OR bench ILIKE $${i} OR disposition ILIKE $${i} OR full_text ILIKE $${i})`); }
    if (year) { const i = push(parseInt(year, 10)); w.push(`year = $${i}`); }
    if (type) { const i = push(String(type).toUpperCase()); w.push(`case_type = $${i}`); }
    if (judge) { const i = push('%' + judge + '%'); w.push(`(presiding_en ILIKE $${i} OR bench ILIKE $${i} OR presiding_dv ILIKE $${i})`); }
    if (source) { const i = push(source); w.push(`source = $${i}`); }
    return w;
  };

  // count
  const cP = []; const cPush = (v) => { cP.push(v); return cP.length; };
  const cWhere = buildWhere(cPush);
  const cWhereSql = cWhere.length ? 'WHERE ' + cWhere.join(' AND ') : '';
  const countRes = await sql.query(`SELECT COUNT(*)::int AS n FROM cases ${cWhereSql}`, cP);

  // data (snippet params first, then filters, then limit/offset)
  const dP = []; const dPush = (v) => { dP.push(v); return dP.length; };
  let snippetSql = `'' AS snippet`;
  if (q) {
    const iLike = dPush('%' + q + '%');
    const iPos = dPush(q);
    snippetSql = `CASE WHEN full_text ILIKE $${iLike} THEN substring(full_text FROM GREATEST(1, position(lower($${iPos}) in lower(full_text)) - 90) FOR 260) ELSE '' END AS snippet`;
  }
  const dWhere = buildWhere(dPush);
  const dWhereSql = dWhere.length ? 'WHERE ' + dWhere.join(' AND ') : '';
  const iLim = dPush(lim); const iOff = dPush(off);
  const dataSql = `SELECT ${LIST_COLS}, ${snippetSql} FROM cases ${dWhereSql} ORDER BY date_concluded DESC NULLS LAST, id DESC LIMIT $${iLim} OFFSET $${iOff}`;
  const dataRes = await sql.query(dataSql, dP);

  return { cases: dataRes.rows, total: countRes.rows[0].n, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: lim };
}

export async function getCase(idOrCaseno) {
  await ensureDb();
  const isNum = /^\d+$/.test(String(idOrCaseno));
  const { rows } = isNum
    ? await sql`SELECT * FROM cases WHERE id=${parseInt(idOrCaseno, 10)};`
    : await sql`SELECT * FROM cases WHERE caseno=${idOrCaseno};`;
  return rows[0] || null;
}

export async function createCase(c) {
  await ensureDb();
  const { year, case_type } = deriveMeta(c.caseno, c.date_concluded, c.pdf_url);
  const { rows } = await sql`
    INSERT INTO cases (caseno,date_concluded,presiding_en,presiding_dv,bench,disposition,source,pdf_url,locked,court,case_type,year,full_text)
    VALUES (${c.caseno},${c.date_concluded||''},${c.presiding_en||''},${c.presiding_dv||''},${c.bench||''},${c.disposition||''},${c.source||'manual'},${c.pdf_url||''},${c.locked!==false},${c.court||'HC'},${c.case_type||case_type},${c.year||year},${c.full_text||''})
    ON CONFLICT (caseno) DO UPDATE SET
      date_concluded=EXCLUDED.date_concluded, presiding_en=EXCLUDED.presiding_en, presiding_dv=EXCLUDED.presiding_dv,
      bench=EXCLUDED.bench, disposition=EXCLUDED.disposition, source=EXCLUDED.source, pdf_url=EXCLUDED.pdf_url,
      locked=EXCLUDED.locked, court=EXCLUDED.court, case_type=EXCLUDED.case_type, year=EXCLUDED.year,
      full_text=EXCLUDED.full_text, updated_at=NOW()
    RETURNING *;
  `;
  return rows[0];
}

export async function updateCase(id, c) {
  await ensureDb();
  const { year, case_type } = deriveMeta(c.caseno, c.date_concluded, c.pdf_url);
  const { rows } = await sql`
    UPDATE cases SET
      caseno=${c.caseno}, date_concluded=${c.date_concluded||''}, presiding_en=${c.presiding_en||''},
      presiding_dv=${c.presiding_dv||''}, bench=${c.bench||''}, disposition=${c.disposition||''},
      source=${c.source||'manual'}, pdf_url=${c.pdf_url||''}, locked=${c.locked!==false},
      court=${c.court||'HC'}, case_type=${c.case_type||case_type}, year=${c.year||year},
      full_text=${c.full_text!==undefined?c.full_text:''}, updated_at=NOW()
    WHERE id=${parseInt(id, 10)} RETURNING *;
  `;
  return rows[0];
}

export async function deleteCase(id) {
  await ensureDb();
  await sql`DELETE FROM cases WHERE id=${parseInt(id, 10)};`;
  return true;
}

// Bulk upsert for the scraper.
//  - enumerate mode: items carry metadata only (no full_text key) -> add new / refresh metadata.
//  - text mode: items carry a full_text key (possibly '') and text_tried:true.
// Locked rows keep their curated fields; text is only filled when currently empty.
export async function ingestRows(items) {
  await ensureDb();
  let added = 0, updated = 0, skipped = 0, textSet = 0;
  for (const c of items) {
    if (!c.caseno) continue;
    const { year, case_type } = deriveMeta(c.caseno, c.date_concluded, c.pdf_url);
    const hasTextKey = Object.prototype.hasOwnProperty.call(c, 'full_text');
    const textVal = hasTextKey ? (c.full_text || '') : '';
    const tried = c.text_tried === true;
    const { rows } = await sql`SELECT id, locked FROM cases WHERE caseno=${c.caseno};`;

    if (rows.length === 0) {
      await sql`
        INSERT INTO cases (caseno,date_concluded,presiding_en,presiding_dv,bench,disposition,source,pdf_url,locked,court,case_type,year,full_text,text_tried)
        VALUES (${c.caseno},${c.date_concluded||''},${c.presiding_en||''},${c.presiding_dv||''},${c.bench||''},${c.disposition||''},${c.source||'needs-review'},${c.pdf_url||''},FALSE,${c.court||'HC'},${case_type},${year},${textVal},${tried});
      `;
      added++; if (textVal) textSet++;
    } else if (rows[0].locked) {
      if (hasTextKey) {
        if (textVal) { await sql`UPDATE cases SET full_text=${textVal}, text_tried=TRUE, updated_at=NOW() WHERE id=${rows[0].id} AND (full_text IS NULL OR full_text='');`; textSet++; }
        else if (tried) { await sql`UPDATE cases SET text_tried=TRUE, updated_at=NOW() WHERE id=${rows[0].id};`; }
      }
      skipped++;
    } else if (hasTextKey) {
      // text mode
      if (textVal) {
        await sql`UPDATE cases SET full_text=${textVal}, text_tried=TRUE, source=${c.source||'text'}, updated_at=NOW() WHERE id=${rows[0].id};`;
        textSet++;
      } else {
        await sql`UPDATE cases SET text_tried=TRUE, updated_at=NOW() WHERE id=${rows[0].id};`;
      }
      updated++;
    } else {
      // enumerate mode: metadata refresh only
      await sql`UPDATE cases SET date_concluded=${c.date_concluded||''}, pdf_url=${c.pdf_url||''}, court=${c.court||'HC'}, case_type=${case_type}, year=${year}, updated_at=NOW() WHERE id=${rows[0].id};`;
      updated++;
    }
  }
  return { added, updated, skipped, textSet, received: items.length };
}

// Cases that still need text extraction (have a pdf but no full_text).
export async function pendingText(limit = 100) {
  await ensureDb();
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const { rows } = await sql`
    SELECT caseno, pdf_url FROM cases
    WHERE (full_text IS NULL OR full_text='') AND text_tried = FALSE AND pdf_url <> ''
    ORDER BY date_concluded DESC NULLS LAST LIMIT ${lim};`;
  return rows;
}

// ---- Judges ----
export async function listJudges() {
  await ensureDb();
  const { rows } = await sql`SELECT * FROM judges ORDER BY name_en;`;
  return rows;
}
export async function createJudge(j) {
  await ensureDb();
  const { rows } = await sql`
    INSERT INTO judges (name_en,name_dv,active) VALUES (${j.name_en},${j.name_dv||''},${j.active!==false})
    ON CONFLICT (name_en) DO UPDATE SET name_dv=EXCLUDED.name_dv, active=EXCLUDED.active, updated_at=NOW()
    RETURNING *;`;
  return rows[0];
}
export async function updateJudge(id, j, applyToCases) {
  await ensureDb();
  const { rows: old } = await sql`SELECT * FROM judges WHERE id=${parseInt(id,10)};`;
  if (!old.length) return null;
  const prev = old[0];
  const { rows } = await sql`
    UPDATE judges SET name_en=${j.name_en}, name_dv=${j.name_dv||''}, active=${j.active!==false}, updated_at=NOW()
    WHERE id=${parseInt(id,10)} RETURNING *;`;
  let propagated = 0;
  if (applyToCases) {
    if (j.name_en && j.name_en !== prev.name_en) {
      const r1 = await sql`UPDATE cases SET presiding_en=REPLACE(presiding_en, ${prev.name_en}, ${j.name_en}) WHERE presiding_en ILIKE ${'%'+prev.name_en+'%'};`;
      const r2 = await sql`UPDATE cases SET bench=REPLACE(bench, ${prev.name_en}, ${j.name_en}) WHERE bench ILIKE ${'%'+prev.name_en+'%'};`;
      propagated += (r1.rowCount||0) + (r2.rowCount||0);
    }
    if (j.name_dv && prev.name_dv && j.name_dv !== prev.name_dv) {
      await sql`UPDATE cases SET presiding_dv=REPLACE(presiding_dv, ${prev.name_dv}, ${j.name_dv}) WHERE presiding_dv ILIKE ${'%'+prev.name_dv+'%'};`;
    }
  }
  return { judge: rows[0], propagated };
}
export async function deleteJudge(id) {
  await ensureDb();
  await sql`DELETE FROM judges WHERE id=${parseInt(id,10)};`;
  return true;
}

// ---- Facets for filter dropdowns ----
export async function meta() {
  await ensureDb();
  const years = (await sql`SELECT DISTINCT year FROM cases WHERE year IS NOT NULL ORDER BY year DESC;`).rows.map(r => r.year);
  const types = (await sql`SELECT DISTINCT case_type FROM cases WHERE case_type <> '' ORDER BY case_type;`).rows.map(r => r.case_type);
  const judges = (await sql`SELECT name_en, name_dv FROM judges WHERE active ORDER BY name_en;`).rows;
  const total = (await sql`SELECT COUNT(*)::int AS n FROM cases;`).rows[0].n;
  const withText = (await sql`SELECT COUNT(*)::int AS n FROM cases WHERE full_text <> '';`).rows[0].n;
  return { years, types, judges, total, withText };
}
