# High Court of Maldives — Presiding Judges (2026)

A small full-stack app on Vercel:

- **Public page** (`/`) — searchable / sortable table of every 2026 High Court
  judgment, its presiding judge (ރިޔާސަތު), the full bench, and a **View** link to
  the original judgment PDF. Downloads to CSV/JSON.
- **Admin page** (`/admin`) — password-protected. Add, edit, and delete cases.
- **Daily auto-update** — a GitHub Actions job re-checks the court's decisions list
  on a schedule you control and adds any new cases (flagged *Needs review*).
- **Database** — Vercel Postgres. Seeded once with the 133 curated 2026 cases
  (95 from judgment text + 38 from OCR). Every seeded row is **locked**, so the daily
  update can never overwrite your curated data or your manual edits.

Stack: static HTML/JS frontend + Node serverless functions in `/api` + `@vercel/postgres`.
No framework build step.

---

## Deploy (about 10 minutes)

### 1. Put the code on GitHub
Create a new repo at <https://github.com/new> (empty). Then either drag every file in
this folder into GitHub's "uploading an existing file" box, or:

```bash
git init && git add . && git commit -m "HC 2026 judges app"
git branch -M main
git remote add origin https://github.com/<you>/hc-judges.git
git push -u origin main
```

### 2. Import into Vercel
Go to <https://vercel.com/new>, import the repo. Framework preset **Other**, leave
build settings empty. Click **Deploy**. (The first deploy will error until the
database is attached — that's expected; finish step 3 then redeploy.)

### 3. Attach a Postgres database
In the Vercel project → **Storage → Create Database → Postgres** → connect it to this
project. Vercel injects the `POSTGRES_*` env vars automatically. No code changes.

### 4. Set environment variables
Project → **Settings → Environment Variables**, add (Production + Preview):

| Name             | Value                                             |
|------------------|---------------------------------------------------|
| `ADMIN_PASSWORD` | the password you'll use to log into `/admin`      |
| `CRON_SECRET`    | a long random string (used by the daily job)      |

Then **Deployments → … → Redeploy** the latest deployment.

On first load the app creates the table and seeds it with the 134 rows in
`data/seed.json`. Visit your URL — the public table should be populated, and
`/admin` should let you log in.

### 5. Turn on the daily update (GitHub Actions)
In the **GitHub repo → Settings → Secrets and variables → Actions**:

- **Secrets** tab → add:
  - `SITE_URL` = your live URL, no trailing slash (e.g. `https://hc-judges.vercel.app`)
  - `CRON_SECRET` = the exact same value you set in Vercel
- **Variables** tab (optional) → `TARGET_YEAR` = `2026` (defaults to the current year)

The schedule lives in `.github/workflows/update.yml`. The default is **06:00 Maldives
time daily**; edit the `cron:` line to change the time or frequency (examples are in
the file; <https://crontab.guru> helps). You can also run it any time from the repo's
**Actions** tab → *Daily update* → *Run workflow*.

---

## How updates and edits coexist

- Every seeded/curated row is **locked** (🔒 in the admin table). The daily scraper
  **never** changes a locked row — it only inserts brand-new cases.
- New cases arrive as **Needs review** (the presiding judge on a scanned judgment
  can't be read automatically). Open `/admin`, fill in the presiding judge from the
  **View** PDF link, and save — saving marks the row Manual and locks it.
- To let the scraper auto-refresh a specific row, open it in admin and untick
  **Locked**.
- The scraper attempts to read the presiding judge from judgments that have a text
  layer; scanned ones are left for review. (This best-effort text read is conservative
  and can be improved over time — see `scripts/scrape.py`.)

## Editing content
`/admin` → **Add case** or **Edit**. Fields: case number, date, presiding judge
(English + Dhivehi), full bench, disposition, source, original PDF URL, and the Lock
toggle. Delete is on the edit dialog.

## Local development (optional)
```bash
npm i -g vercel
vercel link
vercel env pull .env.local     # pulls Postgres + your env vars
vercel dev                     # http://localhost:3000
```

## Files
```
index.html              public page
admin.html              admin page (/admin)
api/                    serverless functions
  cases.js              GET list (public) · POST/PUT/DELETE (admin)
  login.js  logout.js   admin session
  session.js            auth check for the admin UI
  ingest.js             upsert endpoint for the daily job (Bearer CRON_SECRET)
lib/                    db.js (schema, queries, seed) · auth.js (sessions)
data/seed.json          the 134 curated 2026 cases
scripts/scrape.py       the daily scraper
.github/workflows/update.yml   the schedule
vercel.json             function config
```

---
OCR-derived and *Needs review* rows should be verified against the original judgment
before being relied on in filings.
