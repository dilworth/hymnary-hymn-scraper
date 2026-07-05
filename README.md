# hymnary-hymn-scraper

Scrape the **Full Text** of a hymn from [hymnary.org](https://hymnary.org) and save it to a file.

## What it does

1. Opens a hymnal listing page (e.g. `UMH?page=0`)
2. Finds the table with the columns **#**, **Text**, **Tune**
3. Clicks the row whose **#** matches the requested hymn number
4. Opens the **Full Text** tab
5. Captures the text in the Full Text area and saves it to
   `<HYMNAL>-<#>-full-text.txt`

## Usage

```bash
npm install
node scrape-hymn.js [number] [hymnal] [page]
# example (defaults):
node scrape-hymn.js 17 UMH 0

# a range of hymns:
node scrape-hymn.js 17-20 UMH 0
# a comma-separated list:
node scrape-hymn.js 1,5,17 UMH 0

# or via npm:
npm run scrape -- 17 UMH 0
```

Each hymn is written to its own `<HYMNAL>-<#>-full-text.txt` file.

Every run also writes a timestamped log of its console output to the output
folder, e.g. `Hymns/scrape-log-2026-07-05_21-48-57.log`.

### Note on the security challenge

hymnary.org sits behind a bunny.net browser-security challenge that blocks
plain `curl`/headless requests. The script therefore attaches to an
already-running Chrome over the DevTools protocol (CDP) so it can pass the
challenge. Set `CDP_URL` to override the endpoint (default
`http://localhost:29229`). Set `OUT_DIR` to change where the output file is
written (default: current directory).
