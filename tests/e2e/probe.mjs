// Diagnostic: run each File System Access step in its own browser to see which one kills it.
import { chromium } from 'playwright-core';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  'isSameEntry on two fresh handles': async () => { const d = await navigator.storage.getDirectory(); const a = await d.getFileHandle('q.bin', { create: true }); const b = await d.getFileHandle('q.bin'); await a.isSameEntry(b); },
  'IDB round-trip only': () => new Promise(async (res, rej) => {
    const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p5.bin', { create: true });
    const open = indexedDB.open('probe-830664', 1); open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put({ handle: h }, 'k');
      tx.oncomplete = () => { const g = open.result.transaction('s').objectStore('s').get('k'); g.onsuccess = async () => { const r = g.result.handle;  res(); }; g.onerror = () => rej(g.error); };
    };
  }),
  'IDB round-trip + getFile': () => new Promise(async (res, rej) => {
    const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p5.bin', { create: true });
    const open = indexedDB.open('probe-884883', 1); open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put({ handle: h }, 'k');
      tx.oncomplete = () => { const g = open.result.transaction('s').objectStore('s').get('k'); g.onsuccess = async () => { const r = g.result.handle; await r.getFile(); res(); }; g.onerror = () => rej(g.error); };
    };
  }),
  'IDB round-trip + queryPermission': () => new Promise(async (res, rej) => {
    const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p5.bin', { create: true });
    const open = indexedDB.open('probe-845805', 1); open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put({ handle: h }, 'k');
      tx.oncomplete = () => { const g = open.result.transaction('s').objectStore('s').get('k'); g.onsuccess = async () => { const r = g.result.handle; await r.queryPermission({ mode: 'readwrite' }); res(); }; g.onerror = () => rej(g.error); };
    };
  }),
  'IDB round-trip + createWritable': () => new Promise(async (res, rej) => {
    const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p5.bin', { create: true });
    const open = indexedDB.open('probe-50385', 1); open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put({ handle: h }, 'k');
      tx.oncomplete = () => { const g = open.result.transaction('s').objectStore('s').get('k'); g.onsuccess = async () => { const r = g.result.handle; const w = await r.createWritable(); await w.close(); res(); }; g.onerror = () => rej(g.error); };
    };
  }),
  'IDB round-trip + isSameEntry': () => new Promise(async (res, rej) => {
    const d = await navigator.storage.getDirectory(); const h = await d.getFileHandle('p5.bin', { create: true });
    const open = indexedDB.open('probe-610130', 1); open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onsuccess = () => {
      const tx = open.result.transaction('s', 'readwrite'); tx.objectStore('s').put({ handle: h }, 'k');
      tx.oncomplete = () => { const g = open.result.transaction('s').objectStore('s').get('k'); g.onsuccess = async () => { const r = g.result.handle; await r.isSameEntry(h); res(); }; g.onerror = () => rej(g.error); };
    };
  }),
};

let bad = 0;
for (const [name, fn] of Object.entries(steps)) {
  if (name === Object.keys(steps)[0]) console.log(process.env.PERSISTENT ? '-- persistent profile --' : '-- incognito context --');
  let browser, page;
  if (process.env.PERSISTENT) {
    const ctx = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'lw-probe-')), LAUNCH);
    browser = { on: (ev, fn) => ctx.on(ev === 'disconnected' ? 'close' : ev, fn), close: () => ctx.close() };
    page = await ctx.newPage();
  } else {
    browser = await chromium.launch(LAUNCH);
    page = await (await browser.newContext()).newPage();
  }
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
