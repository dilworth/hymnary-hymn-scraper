# hymnary-hymn-scraper

Scrape the **Full Text** of a hymn from [hymnary.org](https://hymnary.org) and save it to a file.

## What it does

Two modes:

**Crawl mode (default)** — scrape the whole hymnal:
1. Opens the hymnal listing (e.g. `https://hymnary.org/hymnal/UMH`) and walks every page.
2. In the **#/Text/Tune** table, finds each row that has a **Text** icon (a link to `/hymn/<HYMNAL>/<#>#text`).
3. Opens that hymn's page and captures it **only if a Full Text tab exists** — otherwise it's skipped.

**Targeted mode** — scrape specific hymn number(s) by passing a number, range, or list.

Each captured hymn is written to its own `<HYMNAL>-<#>-full-text.txt` file.

## Usage

```bash
npm install

# crawl the whole UMH hymnal:
node scrape-hymn.js
node scrape-hymn.js UMH

# targeted: a single hymn / range / list:
node scrape-hymn.js 17 UMH 0
node scrape-hymn.js 17-20 UMH 0
node scrape-hymn.js 1,5,17 UMH 0

# or via npm:
npm run scrape -- 17 UMH 0
```

Set `MAX_HYMNS=<n>` to cap how many hymns a crawl processes (handy for testing).

Every run also writes a timestamped log of its console output to the output
folder, e.g. `Hymns/scrape-log-2026-07-05_21-48-57.log`.

### Note on the security challenge

hymnary.org sits behind a bunny.net browser-security challenge that blocks
plain `curl`/headless requests. The script therefore attaches to an
already-running Chrome over the DevTools protocol (CDP) so it can pass the
challenge. Set `CDP_URL` to override the endpoint (default
`http://localhost:29229`). Set `OUT_DIR` to change where the output file is
written (default: current directory).
