import { sql } from '@vercel/postgres';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'seed.json'), 'utf8'));

let ready = false;

// Create the table on first use, and seed it once if empty.
export async function ensureDb() {
  if (ready) return;
  await sql`
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
    );
  `;
  const { rows } = await sql`SELECT COUNT(*)::int AS n FROM cases;`;
  if (rows[0].n === 0) {
    for (const c of seed) {
      await sql`
        INSERT INTO cases (caseno,date_concluded,presiding_en,presiding_dv,bench,disposition,source,pdf_url,locked)
        VALUES (${c.caseno},${c.date_concluded||''},${c.presiding_en||''},${c.presiding_dv||''},${c.bench||''},${c.disposition||''},${c.source||'text'},${c.pdf_url||''},${c.locked!==false})
        ON CONFLICT (caseno) DO NOTHING;
      `;
    }
  }
  ready = true;
}

export async function listCases() {
  await ensureDb();
  const { rows } = await sql`SELECT * FROM cases ORDER BY date_concluded DESC, caseno DESC;`;
  return rows;
}

export async function createCase(c) {
  await ensureDb();
  const { rows } = await sql`
    INSERT INTO cases (caseno,date_concluded,presiding_en,presiding_dv,bench,disposition,source,pdf_url,locked)
    VALUES (${c.caseno},${c.date_concluded||''},${c.presiding_en||''},${c.presiding_dv||''},${c.bench||''},${c.disposition||''},${c.source||'manual'},${c.pdf_url||''},${c.locked!==false})
    ON CONFLICT (caseno) DO UPDATE SET
      date_concluded=EXCLUDED.date_concluded, presiding_en=EXCLUDED.presiding_en,
      presiding_dv=EXCLUDED.presiding_dv, bench=EXCLUDED.bench, disposition=EXCLUDED.disposition,
      source=EXCLUDED.source, pdf_url=EXCLUDED.pdf_url, locked=EXCLUDED.locked, updated_at=NOW()
    RETURNING *;
  `;
  return rows[0];
}

export async function updateCase(id, c) {
  await ensureDb();
  const { rows } = await sql`
    UPDATE cases SET
      caseno=${c.caseno}, date_concluded=${c.date_concluded||''}, presiding_en=${c.presiding_en||''},
      presiding_dv=${c.presiding_dv||''}, bench=${c.bench||''}, disposition=${c.disposition||''},
      source=${c.source||'manual'}, pdf_url=${c.pdf_url||''}, locked=${c.locked!==false}, updated_at=NOW()
    WHERE id=${id} RETURNING *;
  `;
  return rows[0];
}

export async function deleteCase(id) {
  await ensureDb();
  await sql`DELETE FROM cases WHERE id=${id};`;
  return true;
}

// Upsert used by the daily scraper: never overwrites a locked row.
export async function ingestRows(items) {
  await ensureDb();
  let added = 0, updated = 0, skipped = 0;
  for (const c of items) {
    if (!c.caseno) continue;
    const { rows } = await sql`SELECT id, locked FROM cases WHERE caseno=${c.caseno};`;
    if (rows.length === 0) {
      await sql`
        INSERT INTO cases (caseno,date_concluded,presiding_en,presiding_dv,bench,disposition,source,pdf_url,locked)
        VALUES (${c.caseno},${c.date_concluded||''},${c.presiding_en||''},${c.presiding_dv||''},${c.bench||''},${c.disposition||''},${c.source||'needs-review'},${c.pdf_url||''},FALSE);
      `;
      added++;
    } else if (rows[0].locked) {
      skipped++;
    } else {
      await sql`
        UPDATE cases SET
          date_concluded=${c.date_concluded||''}, presiding_en=${c.presiding_en||''},
          presiding_dv=${c.presiding_dv||''}, bench=${c.bench||''}, disposition=${c.disposition||''},
          source=${c.source||'needs-review'}, pdf_url=${c.pdf_url||''}, updated_at=NOW()
        WHERE id=${rows[0].id};
      `;
      updated++;
    }
  }
  return { added, updated, skipped, received: items.length };
}
