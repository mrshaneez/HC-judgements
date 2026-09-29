# High Court of Maldives — Presiding Judges, 2026

A single-page, searchable/sortable table of every 2026 High Court judgment and the
presiding judge (ރިޔާސަތު) plus the full bench. Pure static site — no build step,
no dependencies. `index.html` contains all the data inline; `data/` holds the same
data as downloadable CSV and Excel.

- **133 of 134** cases have a presiding judge identified.
- A **Source** column marks how each came in: `Judgment text`, `OCR (high)`,
  `OCR (medium)`, or `Unresolved` (one case whose PDF 404s on the court server).

## Deploy on Vercel via GitHub (no command line)

1. **Create a GitHub repo.** Go to <https://github.com/new>, name it e.g.
   `hc2026-judges`, and create it (empty, no README).
2. **Upload these files.** On the new repo page click **uploading an existing file**,
   then drag in everything from this folder — `index.html`, `vercel.json`,
   `README.md`, and the whole `data/` folder — and commit.
3. **Import into Vercel.** Go to <https://vercel.com/new>, click **Import** next to
   your `hc2026-judges` repo. Leave every setting at its default:
   - Framework Preset: **Other**
   - Build Command: *(empty)*
   - Output Directory: *(empty / leave default)*
4. Click **Deploy**. In under a minute you get a live URL like
   `https://hc2026-judges.vercel.app`.

Every future push to the repo's main branch redeploys automatically.

## Deploy with the command line (alternative)

```bash
# from inside this folder
git init
git add .
git commit -m "2026 High Court presiding judges"
git branch -M main
git remote add origin https://github.com/<you>/hc2026-judges.git
git push -u origin main
```

Then import the repo at <https://vercel.com/new>, or skip GitHub entirely:

```bash
npm i -g vercel
vercel        # preview deploy
vercel --prod # production deploy
```

## Custom domain (optional)

In the Vercel project → **Settings → Domains**, add your own domain and follow the
DNS instructions.

## Updating the data

Replace `index.html` (and the files in `data/`) with newer versions and push /
re-upload. Vercel redeploys on its own.

---
Generated 2026-09-29. Source: highcourt.gov.mv decisions list. OCR-derived rows
(flagged in the Source column) are best verified against the original judgment
before use in filings.
