/**
 * Accessibility audit with axe-core across the main screens.
 *   npm run build && npm run test:a11y
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startPreview, CHROME } from './server.mjs';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const { base, stop } = await startPreview();
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

let total = 0;
async function audit(label) {
  await page.waitForTimeout(250);
  await page.addScriptTag({ content: axeSource });
  const results = await page.evaluate(() => window.axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
  }));
  const serious = results.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  total += serious.length;
  console.log(`${serious.length ? '✗' : '✓'} ${label}: ${results.violations.length} issues (${serious.length} serious/critical)`);
  for (const v of results.violations) {
    console.log(`   [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length})`);
    for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target.join(' ')}  ${n.failureSummary?.split('\n')[1]?.trim() || ''}`);
  }
}

await page.goto(base);
await page.waitForSelector('.template-card');
await audit('start screen');
await page.click('.template-card >> nth=3');
await page.waitForFunction(() => window.libreword?.editor);
await audit('editor (Home tab)');
for (const tab of ['insert', 'layout', 'review', 'view']) {
  await page.click(`.ribbon-tab[data-tab="${tab}"]`);
  await audit(`editor (${tab} tab)`);
}
await page.keyboard.press('Control+h');
await audit('find & replace');
await page.keyboard.press('Escape');
await page.evaluate(() => window.libreword.screen.paragraphDialog());
await page.waitForSelector('dialog[open]');
await audit('paragraph dialog');
await page.keyboard.press('Escape');
await page.click('.ribbon-tab.is-file');
await audit('backstage');
await page.keyboard.press('Escape');
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await audit('editor (dark)');
await page.goto(base);
await page.waitForSelector('.template-card');
await audit('start screen (dark)');

await browser.close();
stop();
console.log(total ? `\n${total} serious/critical issue types` : '\nno serious issues');
process.exit(total ? 1 : 0);
