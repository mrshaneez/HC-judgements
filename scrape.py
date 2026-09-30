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
def enumerate_all():
    from playwright.sync_api import sync_playwright
    rows, seen = [], set()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(DECISIONS, wait_until="networkidle", timeout=120000)
        try:
            page.select_option("select[name$='_length']", "100")   # ADJUST
            page.wait_for_timeout(1500)
        except Exception:
            pass
        pages = 0
        while True:
            anchors = page.query_selector_all("a[href*='mediamanager']")
            for a in anchors:
                href = a.get_attribute("href") or ""
                if "mediamanager" not in href:
                    continue
                url = href if href.startswith("http") else ("https://highcourt.gov.mv" + href)
                bn = basename_of(url)
                if bn in seen:
                    continue
                seen.add(bn)
                date, yr = date_year(bn)
                if TARGET_YEAR and yr != TARGET_YEAR:
                    continue
                # case number: prefer the visible row text, fallback to basename
                caseno = None
                try:
                    row = a.evaluate_handle("el => el.closest('tr')")
                    txt = row.evaluate("el => el ? el.innerText : ''") if row else ""
                    m = CASE_RE.search(txt or "")
                    if m:
                        caseno = re.sub(r"\s+", "", m.group(0)).upper().replace("HCA", "HC-A").replace("HCB", "HC-B")
                except Exception:
                    pass
                if not caseno:
                    caseno = caseno_from_basename(bn)
                if not caseno:
                    continue
                rows.append({"caseno": caseno, "date_concluded": date, "pdf_url": url,
                             "court": "HC", "source": "needs-review"})
            pages += 1
            nxt = page.query_selector("a.paginate_button.next:not(.disabled), li.next:not(.disabled) a")  # ADJUST
            if not nxt or pages > 400:
                break
            try:
                nxt.click(); page.wait_for_timeout(1100)
            except Exception:
                break
        browser.close()
    # de-dup by caseno (keep first)
    uniq = {}
    for r in rows:
        uniq.setdefault(r["caseno"], r)
    items = list(uniq.values())
    print(f"enumerated {len(items)} cases"
          + (f" for {TARGET_YEAR}" if TARGET_YEAR else " (all years)"))
    # post in chunks
    total = {"added": 0, "updated": 0, "skipped": 0}
    CHUNK = 50   # keep each /api/ingest request well under the serverless time limit
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
