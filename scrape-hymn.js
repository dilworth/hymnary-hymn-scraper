#!/usr/bin/env node
/**
 * Scrape the "Full Text" of hymns from hymnary.org.
 *
 * Two modes:
 *
 *   Crawl mode (default) — walk the whole hymnal:
 *     1) Open the hymnal listing (e.g. https://hymnary.org/hymnal/UMH)
 *     2) For each row in the #/Text/Tune table that has a "Text" icon,
 *        open that hymn's page.
 *     3) Capture it only if the hymn page has a "Full Text" tab; otherwise skip.
 *
 *   Targeted mode — scrape specific hymn number(s):
 *     Same per-hymn capture, driven by explicit numbers.
 *
 * Each captured hymn is saved to `<HYMNAL>-<#>-full-text.txt` with the layout:
 *     Title
 *     <hymn title>
 *     <Hymnal Name> #<number>
 *
 *     <Verse/Chorus sections>
 *
 *     Blank
 *
 * Usage:
 *   node scrape-hymn.js                 # crawl the whole UMH hymnal
 *   node scrape-hymn.js UMH             # crawl the whole UMH hymnal
 *   node scrape-hymn.js 17 UMH 0        # targeted: a single hymn
 *   node scrape-hymn.js 17-20 UMH 0     # targeted: a range
 *   node scrape-hymn.js 1,5,17 UMH 0    # targeted: a comma-separated list
 *
 * The script attaches to the already-running Chrome via CDP so it can pass
 * the site's browser-security challenge. Set CDP_URL to override the endpoint,
 * OUT_DIR to change where files are written.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL || 'http://localhost:29229';
const OUT_DIR = process.env.OUT_DIR || process.cwd();

// Decide mode from the first CLI arg. A number/range/list => targeted mode;
// otherwise treat it as the hymnal code (default "UMH") and crawl everything.
const ARG1 = process.argv[2];
const IS_TARGETED = !!ARG1 && /^[\d][\d,\-\s]*$/.test(ARG1);
const HYMNAL = IS_TARGETED ? (process.argv[3] || 'UMH') : (ARG1 || 'UMH');
const HYMN_ARG = IS_TARGETED ? ARG1 : null;
const PAGE = process.argv[4] || '0';

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

// Format the hymn body: for each block of text (a "block" is a run of non-blank
// lines separated by blank lines) add a heading — "Verse <number>" if the first
// line starts with a number (that number is stripped), otherwise "Chorus" — and
// insert a blank line after every two lines of text within the block. Existing
// blank lines between blocks are preserved as-is.
function formatHymnBody(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      out.push(lines[i]);
      i++;
      continue;
    }
    // Collect the current block of consecutive non-blank lines.
    const block = [];
    while (i < lines.length && lines[i].trim() !== '') {
      block.push(lines[i]);
      i++;
    }
    // Heading + the block's text lines (with any leading verse number removed).
    const m = block[0].match(/^(\d+)[.)]?\s*/);
    let textLines;
    if (m) {
      out.push(`Verse ${m[1]}`);
      const rest = block[0].slice(m[0].length);
      textLines = (rest.trim() !== '' ? [rest] : []).concat(block.slice(1));
    } else {
      out.push('Chorus');
      textLines = block.slice();
    }
    // Emit text lines, inserting a blank line after every two.
    for (let k = 0; k < textLines.length; k++) {
      out.push(textLines[k]);
      if ((k + 1) % 2 === 0 && k + 1 < textLines.length) out.push('');
    }
  }
  return out.join('\n');
}

async function passSecurityChallenge(page) {
  for (let i = 0; i < 30; i++) {
    const title = await page.title();
    if (!/secure connection|Hold tight|Just a moment/i.test(title)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('Timed out waiting for the security challenge to clear.');
}

// Locate the #/Text/Tune table as an element handle on the current page.
async function findHymnTable(page) {
  const handle = await page.evaluateHandle(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    return tables.find((t) => {
      const hdr = Array.from(t.querySelectorAll('th')).map((th) => th.textContent.trim().toLowerCase());
      return hdr.includes('#') && hdr.includes('text') && hdr.includes('tune');
    }) || null;
  });
  return handle.asElement();
}

// Walk every page of the hymnal listing and collect the hymn numbers whose row
// has a "Text" icon (an anchor linking to `/hymn/<HYMNAL>/<num>#text`).
async function collectHymnsWithText(page, hymnal) {
  const collected = [];
  const seen = new Set();
  let pageNum = 0;
  while (true) {
    const listUrl = `https://hymnary.org/hymnal/${hymnal}?page=${pageNum}`;
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
    await passSecurityChallenge(page);

    const table = await findHymnTable(page);
    if (!table) break;

    const rows = await table.evaluate((t, h) => {
      const trs = Array.from(t.querySelectorAll('tr')).slice(1); // skip header
      return trs.map((tr) => {
        const numCell = tr.querySelector('td');
        const num = numCell ? numCell.textContent.trim() : '';
        const hasTextIcon = !!tr.querySelector(`a[href*="/hymn/${h}/"][href$="#text"]`);
        const titleCell = tr.querySelectorAll('td')[1];
        const title = titleCell ? titleCell.textContent.trim() : '';
        return { num, hasTextIcon, title };
      }).filter((r) => r.num);
    }, hymnal);

    if (rows.length === 0) break;

    let added = 0;
    for (const r of rows) {
      if (r.hasTextIcon && !seen.has(r.num)) {
        seen.add(r.num);
        collected.push(r);
        added++;
      }
    }
    console.log(`Listing page ${pageNum}: ${rows.length} rows, ${added} with a Text icon.`);

    // Stop when there's no "next" pager link beyond this page.
    const hasNext = await page.$$eval('a', (as, p) => as.some((a) => {
      const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
      return m && parseInt(m[1], 10) > p;
    }), pageNum);
    if (!hasNext) break;
    pageNum++;
  }
  return collected;
}

// Given we're already on a hymn page, capture and save its Full Text.
// Returns { skipped, reason?, content? }. Skips if there's no Full Text tab.
async function captureCurrentHymn(page, hymnNumber, rowTitle = '') {
  const fullTextTab = page.locator('a:has-text("Full Text")').first();
  if ((await fullTextTab.count()) === 0) {
    return { skipped: true, reason: 'no Full Text tab' };
  }
  await fullTextTab.click();

  // Hymn heading, e.g. "17. The Great Thanksgiving : Musical Setting A".
  const heading =
    (await page.locator('h2.hymntitle').first().textContent().catch(() => null))?.trim() ||
    (rowTitle ? `${hymnNumber}. ${rowTitle}` : `${hymnNumber}.`);
  const esc = String(hymnNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hymnTitle = heading.replace(new RegExp(`^${esc}\\.\\s*`), '').trim();

  // Hymnal display name from the page <title> ("<Name> <num>. ... | Hymnary.org").
  const pageTitle = (await page.title()).replace(/\s*\|\s*Hymnary\.org\s*$/i, '').trim();
  const nameMatch = pageTitle.match(new RegExp(`^(.*?)\\s+${esc}\\.\\s`));
  const hymnalName = nameMatch ? nameMatch[1].trim() : HYMNAL;

  // Capture the Full Text area.
  const textArea = page.locator('#text');
  await textArea.waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('#text');
    return el && el.innerText.trim().length > 0;
  }, { timeout: 15000 });

  const fullText = (await textArea.innerText()).trim();
  if (!fullText) return { skipped: true, reason: 'Full Text area was empty' };

  // Strip trailing punctuation from each line.
  const cleanedText = fullText
    .split('\n')
    .map((line) => line.replace(/[.,;:!?]+\s*$/, '').trimEnd())
    .join('\n');
  const bodyText = formatHymnBody(cleanedText);

  const content =
    `Title\n${hymnTitle}\n${hymnalName} #${hymnNumber}\n\n${bodyText}\n\nBlank\n`;

  const outFile = path.join(OUT_DIR, `${HYMNAL}-${hymnNumber}-full-text.txt`);
  fs.writeFileSync(outFile, content, 'utf8');
  console.log(`Saved Full Text to: ${outFile}`);
  return { skipped: false, content };
}

// Navigate directly to a hymn page and capture it (used by crawl mode).
async function scrapeHymnByUrl(page, hymnNumber, rowTitle = '') {
  const url = `https://hymnary.org/hymn/${HYMNAL}/${hymnNumber}`;
  const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
  await passSecurityChallenge(page);
  const status = resp ? resp.status() : 200;
  if (status >= 400 || /page not found/i.test(await page.title())) {
    return { skipped: true, reason: `page not found (HTTP ${status})` };
  }
  return captureCurrentHymn(page, hymnNumber, rowTitle);
}

// Targeted mode: start from the listing, click the row, then capture.
async function scrapeHymnFromListing(page, listUrl, hymnNumber) {
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await passSecurityChallenge(page);

  const table = await findHymnTable(page);
  if (!table) throw new Error('Could not find the #/Text/Tune table on the listing page.');

  const rowLink = await table.$(`a[href$="/hymn/${HYMNAL}/${hymnNumber}"]`);
  if (!rowLink) return { skipped: true, reason: 'not listed in the table' };
  const rowTitle = (await rowLink.evaluate((a) => a.closest('tr').querySelectorAll('td')[1]?.textContent.trim() || '')) || '';
  console.log(`Clicking hymn #${hymnNumber}`);
  const [navResponse] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    rowLink.click(),
  ]);
  await passSecurityChallenge(page);

  const status = navResponse ? navResponse.status() : 200;
  if (status >= 400 || /page not found/i.test(await page.title())) {
    return { skipped: true, reason: `page not found (HTTP ${status})` };
  }
  return captureCurrentHymn(page, hymnNumber, rowTitle);
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

  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  const saved = [];
  const skipped = [];
  const failures = [];

  try {
    let worklist;
    if (IS_TARGETED) {
      console.log(`Targeted mode: ${HYMN_ARG} (${HYMNAL})`);
      worklist = parseHymnNumbers(HYMN_ARG).map((num) => ({ num, title: '' }));
    } else {
      console.log(`Crawl mode: entire ${HYMNAL} hymnal`);
      worklist = await collectHymnsWithText(page, HYMNAL);
      console.log(`\nFound ${worklist.length} hymns with a Text icon to process.`);
      const limit = parseInt(process.env.MAX_HYMNS || '', 10);
      if (Number.isInteger(limit) && limit > 0 && worklist.length > limit) {
        console.log(`MAX_HYMNS=${limit} set — processing only the first ${limit}.`);
        worklist = worklist.slice(0, limit);
      }
    }

    for (const { num, title } of worklist) {
      console.log(`\n=== Hymn #${num} ===`);
      try {
        const result = IS_TARGETED
          ? await scrapeHymnFromListing(page, `https://hymnary.org/hymnal/${HYMNAL}?page=${PAGE}`, num)
          : await scrapeHymnByUrl(page, num, title);
        if (result.skipped) {
          console.log(`Skipping hymn #${num}: ${result.reason} — no file created.`);
          skipped.push(num);
          continue;
        }
        saved.push(num);
      } catch (e) {
        console.error(`Failed on hymn #${num}: ${e.message}`);
        failures.push(num);
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }

  console.log(`\n===== Summary =====`);
  console.log(`Saved   (${saved.length}): ${saved.join(', ')}`);
  console.log(`Skipped (${skipped.length}): ${skipped.join(', ')}`);
  if (failures.length) console.error(`Failed  (${failures.length}): ${failures.join(', ')}`);
  console.log(`Run finished: ${new Date().toISOString()}`);
  finish(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('ERROR:', e.message);
  finish(1);
});
