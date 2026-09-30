# Maldives High Court Judgments — search app

A full-stack app on Vercel:

- **Public site** (`/`) — full-text **search** across judgments (English or Dhivehi) with
  filters for **year, type, judge, keyword** and source. Each result shows a highlighted
  snippet, a **Read** panel to view and **copy** the text, and a **View** link to the
  original PDF.
- **Admin** (`/admin`, password-protected) — add / edit / delete cases (with a full-text
  field), and a **Judges** tab to add, edit, or **rename a judge across every case** at once.
- **Auto-update** — GitHub Actions enumerates the court's decisions list on a schedule you
  set and adds new judgments; a second workflow extracts judgment text.
- **Database** — Vercel Postgres (Neon). Seeded with the 133 curated 2026 cases; those rows
  are **locked** so the crawler never overwrites your work.

Stack: static HTML/JS + Node serverless functions in `/api` + `@vercel/postgres`. No build step.

---

## First-time deploy

1. **Push to GitHub**, then import at <https://vercel.com/new> (framework **Other**, no build settings).
2. **Attach Postgres**: project → **Storage → Create → Neon Postgres → Connect** to the project
   (all environments). This injects `POSTGRES_URL`. If your project has leftover `POSTGRES_*`
   variables from an old database, remove that old connection first so the new one uses the
   default names.
3. **Env vars** (Settings → Environment Variables): `ADMIN_PASSWORD` and `CRON_SECRET`.
4. **Redeploy** (Deployments → ⋯ → Redeploy). On first load the app creates the tables,
   runs migrations, seeds the 2026 cases and the judges list.
5. **GitHub → Settings → Secrets and variables → Actions → Secrets**: add `SITE_URL`
   (your live URL, no trailing slash) and `CRON_SECRET` (same value as in Vercel).

> Upgrading an existing deployment? Just replace the files and redeploy — the database
> migrates itself (adds the `full_text`, `year`, `type`, `text_tried` columns and the
> `judges` table; existing rows are backfilled and preserved).

---

## Load the whole High Court library

Everything comes from the court's **public** website, so your `D:\judgements` drive is not
needed.

1. **Enumerate all judgments** (metadata): GitHub repo → **Actions** → **Daily update
   (enumerate)** → **Run workflow**, leave *target year* blank → Run. This adds every High
   Court judgment (all years) as a row. New rows are flagged **Needs review** until they have
   a presiding judge. (After this, the daily schedule keeps catching new cases automatically.)
2. **Extract the text**: **Actions** → **Backfill judgment text** → **Run workflow**. It
   downloads judgment PDFs and pulls the text layer. Scanned PDFs have no text and are skipped
   (marked so they aren't retried). Each run works for ~50 minutes; **re-run it until the log
   says nothing is pending.** A weekly scheduled pass then keeps new judgments' text current.

Only text-layer PDFs become content-searchable and copyable; scanned judgments stay
searchable by metadata and open via **View**.

---

## Using it

**Search** — type in the box (matches case text, principles, names, keywords in English or
Thaana). Narrow with the year / type / judge / source dropdowns. Click **Read** to open the
judgment text and **Copy text**, or **View** for the original PDF.

**Admin → Cases** — add or edit any case. The presiding judge is a dropdown from your judges
list (or free text). Paste or edit the **Full text** to make a judgment searchable. **Locked**
protects a row from the daily crawler.

**Admin → Judges** — add or edit judges (English + Dhivehi). When you rename a judge, tick
**"Also rename across all existing cases"** and every judgment's presiding/bench text updates
in one go — the clean way to normalise spellings.

---

## Environment variables

| Name             | Where            | Purpose                                             |
|------------------|------------------|-----------------------------------------------------|
| `ADMIN_PASSWORD` | Vercel           | Password for `/admin`                               |
| `CRON_SECRET`    | Vercel + GitHub  | Shared secret for the crawler's `/api/ingest`       |
| `POSTGRES_URL`   | Vercel (auto)    | Added when you connect the Neon database            |
| `SITE_URL`       | GitHub secret    | Your live URL, no trailing slash                    |

## Files
```
index.html            public search page
admin.html            admin (/admin): Cases + Judges tabs
api/
  cases.js            GET search/list + single (with full_text); POST/PUT/DELETE (admin)
  judges.js           judges CRUD + rename-propagation
  meta.js             filter facets (years, types, judges, counts)
  ingest.js           bulk upsert for the crawler (Bearer CRON_SECRET)
  pending.js          lists cases still needing text (Bearer CRON_SECRET)
  login/logout/session
lib/db.js             schema, migrations, search, judges, seed
lib/auth.js           admin session + cron auth
data/seed.json        the 134 curated 2026 cases
scripts/scrape.py     crawler (MODE=enumerate | text)
.github/workflows/    update.yml (daily enumerate) · backfill-text.yml (text)
```

OCR / *Needs review* rows should be verified against the original judgment before relying on
them in filings.
