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
 *
 * The script attaches to the already-running Chrome via CDP so it can pass
 * the site's browser-security challenge. Set CDP_URL to override the endpoint.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HYMN_NUMBER = process.argv[2] || '17';
const HYMNAL = process.argv[3] || 'UMH';
const PAGE = process.argv[4] || '0';
const CDP_URL = process.env.CDP_URL || 'http://localhost:29229';
const OUT_DIR = process.env.OUT_DIR || process.cwd();

async function passSecurityChallenge(page) {
  for (let i = 0; i < 30; i++) {
    const title = await page.title();
    if (!/secure connection|Hold tight|Just a moment/i.test(title)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error('Timed out waiting for the security challenge to clear.');
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = await context.newPage();

  try {
    // 1) Open the hymnal listing page.
    const listUrl = `https://hymnary.org/hymnal/${HYMNAL}?page=${PAGE}`;
    console.log(`Opening ${listUrl}`);
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
    const rowLink = await table.$(`a[href$="/hymn/${HYMNAL}/${HYMN_NUMBER}"]`);
    if (!rowLink) throw new Error(`Could not find hymn #${HYMN_NUMBER} in the table.`);
    console.log(`Clicking hymn #${HYMN_NUMBER}`);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      rowLink.click(),
    ]);
    await passSecurityChallenge(page);

    // 4) Open the "Full Text" tab.
    const fullTextTab = page.locator('a:has-text("Full Text")').first();
    await fullTextTab.waitFor({ state: 'visible', timeout: 15000 });
    console.log('Opening the Full Text tab');
    await fullTextTab.click();

    // 5) Capture the text within the Full Text area.
    const textArea = page.locator('#text');
    await textArea.waitFor({ state: 'visible', timeout: 15000 });
    // Wait for content to populate.
    await page.waitForFunction(() => {
      const el = document.querySelector('#text');
      return el && el.innerText.trim().length > 0;
    }, { timeout: 15000 });

    const fullText = (await textArea.innerText()).trim();
    if (!fullText) throw new Error('Full Text area was empty.');

    const outFile = path.join(OUT_DIR, `${HYMNAL}-${HYMN_NUMBER}-full-text.txt`);
    fs.writeFileSync(outFile, fullText + '\n', 'utf8');
    console.log(`\nSaved Full Text to: ${outFile}\n`);
    console.log('----- captured text -----');
    console.log(fullText);
    console.log('-------------------------');
  } finally {
    await page.close();
    await browser.close();
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
