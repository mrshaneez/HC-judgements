#!/usr/bin/env python3
"""
Scraper for the High Court of Maldives decisions list. Two modes.

MODE=enumerate  (default)
  Loads highcourt.gov.mv/dv/decisions.php with a headless browser, walks every
  page, and collects every judgment link (…/mediamanager/<basename>.pdf).
  Derives case number, date, year and type, and upserts the METADATA into the
  app (POST /api/ingest). No text is fetched — fast. Runs daily.
  Set TARGET_YEAR to limit to one year; leave empty to ingest ALL years.

MODE=text
  Asks the app which cases still need text (GET /api/pending), downloads those
  PDFs, extracts the text layer with pypdf (scanned PDFs yield nothing and are
  skipped), and posts the text back (POST /api/ingest). Loops until nothing is
  pending or TIME_BUDGET_SEC is hit. Run this for the one-time backfill and
  occasionally after that.

Env (from the GitHub Action):
  SITE_URL        https://your-app  (no trailing slash)
  CRON_SECRET     shared secret, also set in the Vercel project
  MODE            enumerate | text          (default: enumerate)
  TARGET_YEAR     e.g. 2026                 (enumerate only; empty = all years)
  BATCH           cases per pending pull     (text mode, default 40)
  TIME_BUDGET_SEC wall-clock budget          (text mode, default 3000)
  DECISIONS_URL   default decisions.php

Selectors marked  # ADJUST  may need a tweak if the court site markup changes;
check the first run's logs.
"""
import os, re, io, sys, json, time, datetime, urllib.request

SITE_URL    = os.environ.get("SITE_URL", "").rstrip("/")
CRON_SECRET = os.environ.get("CRON_SECRET", "")
MODE        = os.environ.get("MODE", "enumerate").strip().lower()
TARGET_YEAR = os.environ.get("TARGET_YEAR", "").strip()
DECISIONS   = os.environ.get("DECISIONS_URL", "https://highcourt.gov.mv/dv/decisions.php")
DATA_URL    = os.environ.get("DATA_URL", "https://highcourt.gov.mv/dv/connects/getmydecisionsfull.php")
PDF_BASE    = os.environ.get("PDF_BASE", "https://highcourt.gov.mv/dhi/mediamanager/")
BATCH       = int(os.environ.get("BATCH", "40"))
TIME_BUDGET = int(os.environ.get("TIME_BUDGET_SEC", "3000"))

TS_RE   = re.compile(r"_(\d{2})(\d{2})(\d{4})\d*\.(?:pdf|PDF)$")
CASE_RE = re.compile(r"\d{2,4}\s*/\s*HC-?[AB]\d*\s*/\s*[A-Za-z0-9]+", re.I)


def api(path, payload=None, method="POST"):
    url = SITE_URL + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
        headers={"content-type": "application/json", "authorization": f"Bearer {CRON_SECRET}"})
    return json.loads(urllib.request.urlopen(req, timeout=120).read().decode())


def basename_of(u): return u.rstrip("/").split("/")[-1]

def date_year(bn):
    m = TS_RE.search(bn)
    if not m: return "", None
    dd, mm, yyyy = m.groups()
    return f"{yyyy}-{mm}-{dd}", yyyy

def caseno_from_basename(bn):
    m = re.match(r"(\d{3,4})HC([AB])(\d+)", bn)
    if not m: return None
    yr, div, num = m.groups()
    return f"{yr}/HC-{div}/{num}"


# ---------------- enumerate ----------------
def fetch_decisions():
    """GET the court's decisions JSON feed (the same endpoint the decisions page
    uses to populate its DataTable). Returns a list of record dicts."""
    req = urllib.request.Request(DATA_URL, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/125.0 Safari/537.36",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": DECISIONS,
    })
    raw = urllib.request.urlopen(req, timeout=180).read().decode("utf-8", "replace")
    return json.loads(raw)


def enumerate_all():
    records = fetch_decisions()
    rows = []
    for r in records:
        caseno = (r.get("numbr") or "").strip()
        pdffile = (r.get("pdffile") or "").strip()
        if not caseno or not pdffile:
            continue
        date = (r.get("created") or "").strip()          # already YYYY-MM-DD
        yr = date[:4] if date[:4].isdigit() else None
        if TARGET_YEAR and yr != TARGET_YEAR:
            continue
        rows.append({
            "caseno": caseno,
            "date_concluded": date,
            "pdf_url": PDF_BASE + pdffile,
            "court": "HC",
            "source": "needs-review",
            "bench": (r.get("fandiyaaru") or "").strip(),
            "disposition": (r.get("massala") or "").strip(),
        })
    # de-dup by caseno (keep first)
    uniq = {}
    for r in rows:
        uniq.setdefault(r["caseno"], r)
    items = list(uniq.values())
    print(f"fetched {len(records)} records; enumerated {len(items)} cases"
          + (f" for {TARGET_YEAR}" if TARGET_YEAR else " (all years)"))
    # post in chunks (kept small to stay well under the serverless time limit)
    total = {"added": 0, "updated": 0, "skipped": 0}
    CHUNK = 40
    for i in range(0, len(items), CHUNK):
        res = api("/api/ingest", {"cases": items[i:i+CHUNK]})
        for k in total: total[k] += res.get(k, 0)
        print("  chunk", i // CHUNK, res)
    print("ingest totals:", total)


# ---------------- text backfill ----------------
def extract_text(url):
    try:
        from pypdf import PdfReader
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req, timeout=90).read()
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join((pg.extract_text() or "") for pg in reader.pages)
        return text if len(text.strip()) >= 200 else ""   # <200 chars => scanned/no text
    except Exception as e:
        print("   extract error:", e)
        return ""

def backfill_text():
    start = time.time()
    done = 0
    while time.time() - start < TIME_BUDGET:
        pend = api(f"/api/pending?limit={BATCH}", method="GET").get("pending", [])
        if not pend:
            print("nothing pending — text backfill complete")
            break
        batch = []
        for row in pend:
            txt = extract_text(row["pdf_url"])
            # text_tried=true marks it done either way, so scanned PDFs (empty text)
            # leave the pending queue instead of being retried forever.
            batch.append({"caseno": row["caseno"], "pdf_url": row["pdf_url"],
                          "full_text": txt, "text_tried": True,
                          "source": ("text" if txt else "needs-review")})
        res = api("/api/ingest", {"cases": batch})
        done += len(batch)
        print(f"posted {len(batch)} (textSet={res.get('textSet')}), total {done}")
    print("text backfill run finished, processed", done)


def main():
    if not SITE_URL or not CRON_SECRET:
        print("SITE_URL and CRON_SECRET required", file=sys.stderr); sys.exit(2)
    if MODE == "text":
        backfill_text()
    else:
        enumerate_all()

if __name__ == "__main__":
    main()
