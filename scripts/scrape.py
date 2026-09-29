#!/usr/bin/env python3
"""
Daily scraper for the High Court of Maldives decisions list.

What it does
------------
1. Loads highcourt.gov.mv/dv/decisions.php with a headless browser and reads every
   judgment link (…/mediamanager/<basename>.pdf) across all pages.
2. Keeps the ones whose timestamp (encoded in the filename) is in TARGET_YEAR.
3. Builds a row per case: case number, date concluded, and the PDF URL.
4. (Optional, best-effort) tries to read the presiding judge from the PDF's text
   layer. Scanned judgments have no text layer, so those are left as "needs-review".
5. POSTs the rows to <SITE_URL>/api/ingest with the CRON_SECRET.
   The server NEVER overwrites a locked row, so your curated 2026 seed and any manual
   edits are safe. Only genuinely new cases are added (flagged "needs-review" until a
   human or Claude fills the presiding judge).

Env vars (set by the GitHub Action):
  SITE_URL      e.g. https://hc-judges.vercel.app   (no trailing slash)
  CRON_SECRET   shared secret, also set in Vercel project env
  TARGET_YEAR   default: current year
  DECISIONS_URL default: https://highcourt.gov.mv/dv/decisions.php

Selectors marked  # ADJUST  may need a tweak if the court site's markup changes;
check the first Action run's logs.
"""
import os, re, sys, io, json, datetime, urllib.request
from playwright.sync_api import sync_playwright

SITE_URL   = os.environ.get("SITE_URL", "").rstrip("/")
CRON_SECRET= os.environ.get("CRON_SECRET", "")
TARGET_YEAR= os.environ.get("TARGET_YEAR", str(datetime.date.today().year))
DECISIONS  = os.environ.get("DECISIONS_URL", "https://highcourt.gov.mv/dv/decisions.php")
TRY_TEXT   = os.environ.get("TRY_PDF_TEXT", "1") == "1"

TS_RE   = re.compile(r"_(\d{2})(\d{2})(\d{4})\d*\.(?:pdf|PDF)$")   # _ddmmyyyyhhmmss
CASE_RE = re.compile(r"\d{2,4}\s*/\s*HC-?[AB]\d*\s*/\s*\d+", re.I)  # displayed case number


def basename_of(url):
    return url.rstrip("/").split("/")[-1]


def date_from_basename(bn):
    m = TS_RE.search(bn)
    if not m:
        return None, None
    dd, mm, yyyy = m.groups()
    return f"{yyyy}-{mm}-{dd}", yyyy


def caseno_from_basename(bn):
    # e.g. 2022HCA188_...  -> 2022/HC-A/188 ; 2026HCB1207_... -> 2026/HC-B12/07 (best effort)
    m = re.match(r"(\d{3,4})HC([AB])(\d+)", bn)
    if not m:
        return None
    yr, div, num = m.groups()
    return f"{yr}/HC-{div}/{num}"


def extract_presiding_from_pdf(url):
    """Best-effort: read the PDF text layer and pull the name marked (ރިޔާސަތު).
    Returns (presiding_dv, bench_text) or (None, None) for scanned/unclear PDFs."""
    try:
        from pypdf import PdfReader
    except Exception:
        return None, None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        data = urllib.request.urlopen(req, timeout=60).read()
        reader = PdfReader(io.BytesIO(data))
        text = "\n".join((p.extract_text() or "") for p in reader.pages)
    except Exception:
        return None, None
    if len(text.strip()) < 200:
        return None, None  # scanned image PDF — no usable text
    # The presiding judge's name appears next to the marker "ރިޔާސަތު".
    idx = text.find("ރިޔާސަތު")
    if idx == -1:
        return None, None
    window = text[max(0, idx - 120): idx]
    # grab the last "ފަނޑިޔާރު <name>" chunk before the marker
    m = list(re.finditer(r"ފަނޑިޔާރު[^\n]{0,60}", window))
    if not m:
        return None, None
    return m[-1].group(0).strip(), None


def scrape_links():
    urls = set()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(DECISIONS, wait_until="networkidle", timeout=90000)
        # Try to show as many rows per page as possible (DataTables length select). # ADJUST
        try:
            page.select_option("select[name$='_length']", "100")
            page.wait_for_timeout(1500)
        except Exception:
            pass
        # Walk all pages via the "Next" pagination button. # ADJUST
        seen_pages = 0
        while True:
            for a in page.query_selector_all("a[href*='mediamanager']"):
                href = a.get_attribute("href") or ""
                if "mediamanager" in href:
                    urls.add(href if href.startswith("http") else ("https://highcourt.gov.mv" + href))
            seen_pages += 1
            nxt = page.query_selector("a.paginate_button.next:not(.disabled), li.next:not(.disabled) a")
            if not nxt or seen_pages > 60:
                break
            try:
                nxt.click(); page.wait_for_timeout(1200)
            except Exception:
                break
        browser.close()
    return sorted(urls)


def main():
    if not SITE_URL or not CRON_SECRET:
        print("SITE_URL and CRON_SECRET must be set", file=sys.stderr); sys.exit(2)
    links = scrape_links()
    print(f"found {len(links)} judgment links")
    rows, seen = [], set()
    for url in links:
        bn = basename_of(url)
        date, yr = date_from_basename(bn)
        if yr != TARGET_YEAR:
            continue
        caseno = caseno_from_basename(bn)
        if not caseno or caseno in seen:
            continue
        seen.add(caseno)
        row = {"caseno": caseno, "date_concluded": date or "", "pdf_url": url,
               "presiding_en": "", "presiding_dv": "", "bench": "", "disposition": "",
               "source": "needs-review"}
        if TRY_TEXT:
            pdv, bench = extract_presiding_from_pdf(url)
            if pdv:
                row["presiding_dv"] = pdv
                row["source"] = "text"   # unlocked; a human can correct/confirm
        rows.append(row)
    print(f"{len(rows)} cases for {TARGET_YEAR}")
    payload = json.dumps({"cases": rows}).encode()
    req = urllib.request.Request(SITE_URL + "/api/ingest", data=payload, method="POST",
                                 headers={"content-type": "application/json",
                                          "authorization": f"Bearer {CRON_SECRET}"})
    resp = urllib.request.urlopen(req, timeout=120).read().decode()
    print("ingest result:", resp)


if __name__ == "__main__":
    main()
