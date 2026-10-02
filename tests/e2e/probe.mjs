// Diagnostic: run each File System Access step in its own browser to see which one kills it.
import { chromium } from 'playwright-core';
import { startPreview, LAUNCH } from './server.mjs';

const { base, stop } = await startPreview();
const steps = {
  'opfs write': async () => { const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p.bin', { create: true }); const w = await h.createWritable(); await w.write(new Uint8Array([1, 2, 3])); await w.close(); },
  'opfs getFile': async () => { const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p2.bin', { create: true }); await (await h.createWritable()).close(); await h.getFile(); },
  'opfs queryPermission': async () => { const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p3.bin', { create: true }); await h.queryPermission({ mode: 'readwrite' }); },
  'opfs requestPermission': async () => { const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p4.bin', { create: true }); await h.requestPermission({ mode: 'readwrite' }); },
  'handle into IndexedDB': () => new Promise(async (res, rej) => {
    const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p5.bin', { create: true });
    const open = indexedDB.open('probe', 1); open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => { const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put({ handle: h }, 'k'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); };
  }),
  'handle round-trip through IndexedDB + isSameEntry': () => new Promise(async (res, rej) => {
    const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p5.bin', { create: true });
    const open = indexedDB.open('probe2', 1); open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put({ handle: h }, 'k');
      tx.oncomplete = () => { const g = open.result.transaction('s').objectStore('s').get('k'); g.onsuccess = async () => { await g.result.handle.isSameEntry(h); res(); }; g.onerror = () => rej(g.error); };
    };
  }),
};

let bad = 0;
for (const [name, fn] of Object.entries(steps)) {
  const browser = await chromium.launch(LAUNCH);
  const page = await (await browser.newContext()).newPage();
  let died = false;
  browser.on('disconnected', () => { died = true; });
  page.on('crash', () => { died = true; });
  let result = 'ok';
  try {
    await page.goto(base);
    await page.evaluate(fn);
    await page.waitForTimeout(500);
  } catch (e) { result = `error: ${String(e.message).split('\n')[0]}`; }
  if (died) result = `BROWSER DIED (${result})`;
  if (result !== 'ok') bad++;
  console.log(`${result === 'ok' ? '✓' : '✗'} ${name}: ${result}`);
  await browser.close().catch(() => {});
}
stop();
console.log(bad ? `${bad} probe(s) failed` : 'all probes ok');
