/**
 * Editing benchmark on a large document.  npm run build && npm run bench
 */
import { chromium } from 'playwright-core';
import { startPreview, LAUNCH } from './server.mjs';

const N = Number(process.argv[2] || 2000);
const { base, stop } = await startPreview();
const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto(base);
await page.click('.template-card >> nth=0');
await page.waitForFunction(() => window.libreword?.editor);


const load = await page.evaluate(async (N) => {
  const html = Array.from({ length: N }, (_, i) => (i % 25 === 0
    ? `<h2>Section ${i}</h2>`
    : `<p>Paragraph ${i}: The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs, and then some more words for wrapping.</p>`)).join('');
  const t = performance.now();
  window.libreword.editor.commands.setContent(html);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { ms: performance.now() - t, layoutMs: window.libreword.editor.storage.pagination.lastLayoutMs, pages: window.libreword.screen.pageCount };
}, N);

const typing = await page.evaluate(async () => {
  const ed = window.libreword.editor;
  ed.commands.focus('start');
  const frame = [];
  const layout = [];
  for (let i = 0; i < 60; i++) {
    const t = performance.now();
    ed.view.dispatch(ed.state.tr.insertText(i % 10 === 9 ? ' ' : 'x'));
    const sync = performance.now() - t;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    frame.push(sync);
    layout.push(ed.storage.pagination.lastLayoutMs);
  }
  const stat = (a) => {
    a.sort((x, y) => x - y);
    return { median: +a[a.length >> 1].toFixed(2), p95: +a[Math.floor(a.length * 0.95)].toFixed(2) };
  };
  return { transactionMs: stat(frame), layoutMs: stat(layout) };
});

console.log(`${N} blocks → ${load.pages} pages`);
console.log(`  initial load + full layout: ${load.ms.toFixed(0)} ms (layout pass ${load.layoutMs.toFixed(1)} ms)`);
console.log('  per keystroke at top of document:', JSON.stringify(typing));
await browser.close();
stop();
process.exit(0);
