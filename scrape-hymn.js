#!/usr/bin/env node
/**
 * Scrape the "Full Text" of a hymn from hymnary.org.
 *
 * Follows the flow:
 *   1) Open the hymnal listing page (e.g. UMH page 0)
 *   2) Find the table with columns: #, Text, Tune
 *   3) Click the row whose "#" matches the requested hymn number
 *   4) Open the "Full Text" tab
 *   5) Capture the text in the Full Text area and save it to a file
 *      whose name contains the hymn number (e.g. UMH-17-full-text.txt)
 *
 * Usage:
 *   node scrape-hymn.js [number] [hymnal] [page]
 *   node scrape-hymn.js 17 UMH 0        # default
 *   node scrape-hymn.js 17-20 UMH 0     # a range of hymns
 *   node scrape-hymn.js 1,5,17 UMH 0    # a comma-separated list
 *
 * The script attaches to the already-running Chrome via CDP so it can pass
 * the site's browser-security challenge. Set CDP_URL to override the endpoint.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HYMN_ARG = process.argv[2] || '17';
const HYMNAL = process.argv[3] || 'UMH';
const PAGE = process.argv[4] || '0';
const CDP_URL = process.env.CDP_URL || 'http://localhost:29229';
const OUT_DIR = process.env.OUT_DIR || process.cwd();

// Parse "17", "17-20" (range) or "1,5,17" (list) into a list of hymn numbers.
function parseHymnNumbers(arg) {
  const out = [];
  for (const part of arg.split(',').map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      for (let n = start; n <= end; n++) out.push(String(n));
    } else {
      out.push(part);
    }
  }
  return out;
}

async function passSecurityChallenge(page) {
  for (let i = 0; i < 30; i++) {
    const title = await page.title();
    if (!/secure connection|Hold tight|Just a moment/i.test(title)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('Timed out waiting for the security challenge to clear.');
}

// Perform the full flow for a single hymn number, starting from the listing page.
async function scrapeHymn(page, listUrl, hymnNumber) {
  // 1) Open the hymnal listing page.
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await passSecurityChallenge(page);

  // 2) Find the table whose headers are #, Text, Tune.
  const tableHandle = await page.evaluateHandle(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.find((t) => {
      const hdr = Array.from(t.querySelectorAll('th')).map((th) => th.textContent.trim().toLowerCase());
      return hdr.includes('#') && hdr.includes('text') && hdr.includes('tune');
    }) || null;
  });
  const table = tableHandle.asElement();
  if (!table) throw new Error('Could not find the #/Text/Tune table on the listing page.');

  // 3) Click the link in the "#" column that matches the requested number.
  const rowLink = await table.$(`a[href$="/hymn/${HYMNAL}/${hymnNumber}"]`);
  if (!rowLink) {
    // Hymn number isn't listed in the table (nothing to open) — skip it.
    return { skipped: true, reason: 'not listed in the table' };
  }
  // Fallback title straight from the listing row's "Text" column.
  const rowTitle = (await rowLink.evaluate((a) => a.closest('tr').querySelectorAll('td')[1]?.textContent.trim() || '')) || '';
  console.log(`Clicking hymn #${hymnNumber}`);
  const [navResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    rowLink.click(),
  ]);
  await passSecurityChallenge(page);

  // Skip if the hymn page doesn't exist (e.g. HTTP 403/404 "Page Not Found").
  const status = navResponse ? navResponse.status() : 200;
  if (status >= 400 || /page not found/i.test(await page.title())) {
    return { skipped: true, reason: `page not found (HTTP ${status})` };
  }

  // Hymn heading, e.g. "17. The Great Thanksgiving : Musical Setting A".
  // Read from the page's `h2.hymntitle`, falling back to "<num>. <row Text>".
  const heading =
    (await page.locator('h2.hymntitle').first().textContent().catch(() => null))?.trim() ||
    (rowTitle ? `${hymnNumber}. ${rowTitle}` : `${hymnNumber}.`);
  // Drop the leading "<number>. " from the heading to get the bare title.
  const esc0 = String(hymnNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hymnTitle = heading.replace(new RegExp(`^${esc0}\\.\\s*`), '').trim();

  // Line 2: the hymnal display name, parsed from the page <title>
  // ("<Hymnal Name> <num>. <Title> | Hymnary.org").
  const pageTitle = (await page.title()).replace(/\s*\|\s*Hymnary\.org\s*$/i, '').trim();
  const esc = String(hymnNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameMatch = pageTitle.match(new RegExp(`^(.*?)\\s+${esc}\\.\\s`));
  const hymnalName = nameMatch ? nameMatch[1].trim() : HYMNAL;

  // 4) Open the "Full Text" tab.
  const fullTextTab = page.locator('a:has-text("Full Text")').first();
  await fullTextTab.waitFor({ state: 'visible', timeout: 15000 });
  console.log('Opening the Full Text tab');
  await fullTextTab.click();

  // 5) Capture the text within the Full Text area.
  const textArea = page.locator('#text');
  await textArea.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#text');
    return el && el.innerText.trim().length > 0;
  }, { timeout: 15000 });

  const fullText = (await textArea.innerText()).trim();
  if (!fullText) throw new Error('Full Text area was empty.');

  // Strip trailing punctuation from each line of the hymn text.
  const cleanedText = fullText
    .split('\n')
    .map((line) => line.replace(/[.,;:!?]+\s*$/, '').trimEnd())
    .join('\n');

  // Header: a "Title" label, the bare title, then "<Hymnal Name> #<number>".
  // Footer: a blank line followed by the word "Blank".
  const content =
    `Title\n${hymnTitle}\n${hymnalName} #${hymnNumber}\n\n${cleanedText}\n\nBlank\n`;

  const outFile = path.join(OUT_DIR, `${HYMNAL}-${hymnNumber}-full-text.txt`);
  fs.writeFileSync(outFile, content, 'utf8');
  console.log(`Saved Full Text to: ${outFile}`);
  return { skipped: false, content };
}

// Tee console output to a timestamped log file inside the output folder.
let logStream = null;
function startLogging() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const logFile = path.join(OUT_DIR, `scrape-log-${stamp}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const write = (fn) => (...args) => {
    logStream.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
    fn(...args);
  };
  console.log = write(console.log.bind(console));
  console.error = write(console.error.bind(console));
  return logFile;
}

// Flush the log stream, then exit with the given code.
function finish(code) {
  if (logStream) {
    logStream.end(() => process.exit(code));
  } else {
    process.exit(code);
  }
}

(async () => {
  const logFile = startLogging();
  console.log(`Run started: ${new Date().toISOString()}`);
  console.log(`Logging to: ${logFile}`);
  const hymnNumbers = parseHymnNumbers(HYMN_ARG);
  const listUrl = `https://hymnary.org/hymnal/${HYMNAL}?page=${PAGE}`;
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  const failures = [];
  const skipped = [];
  try {
    for (const hymnNumber of hymnNumbers) {
      console.log(`\n=== Hymn #${hymnNumber} (${listUrl}) ===`);
      try {
        const result = await scrapeHymn(page, listUrl, hymnNumber);
        if (result.skipped) {
          console.log(`Skipping hymn #${hymnNumber}: ${result.reason} — no file created.`);
          skipped.push(hymnNumber);
          continue;
        }
        console.log('----- captured text -----');
        console.log(result.content);
        console.log('-------------------------');
      } catch (e) {
        console.error(`Failed on hymn #${hymnNumber}: ${e.message}`);
        failures.push(hymnNumber);
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }

  if (skipped.length) {
    console.log(`\nSkipped (not found): ${skipped.join(', ')}`);
  }
  console.log(`Run finished: ${new Date().toISOString()}`);
  finish(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  finish(1);
});
