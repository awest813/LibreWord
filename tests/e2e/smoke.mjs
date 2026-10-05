/**
 * End-to-end smoke tests against the production build.
 *
 *   npm run build && npm run test:e2e
 *
 * Uses playwright-core with a system Chromium (set CHROME_PATH to override).
 */
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import JSZip from 'jszip';

import { startPreview, LAUNCH } from './server.mjs';

const { base: BASE, stop } = await startPreview();

const browser = await chromium.launch(LAUNCH);
const context = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
// This suite covers the file-input fallback used by Firefox and Safari; saving
// back to files with the File System Access API is covered by files.mjs.
await page.addInitScript(() => {
  delete window.showOpenFilePicker;
  delete window.showSaveFilePicker;
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${String(err.message).split('\n').slice(0, 14).join('\n    ')}`);
  }
}

const editorReady = () => page.waitForFunction(() => window.libreword?.editor && !window.libreword.editor.isDestroyed);
const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));

/** Every rendered text line must sit inside a page's content area. */
const layoutViolations = () =>
  page.evaluate(() => {
    const s = window.libreword.screen;
    const g = s.geometry;
    const root = s.editorEl.getBoundingClientRect();
    const z = root.width / g.width;
    const P = g.height + g.gap;
    // Zoomed text snaps to device pixels, so allow a couple of device pixels of slack.
    const slack = 2 / Math.min(1, z);
    const bad = [];
    const walker = document.createTreeWalker(s.editorEl, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let n;
    while ((n = walker.nextNode())) {
      if (!n.textContent.trim()) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        const top = (r.top - root.top) / z;
        const bottom = (r.bottom - root.top) / z;
        const k = Math.floor(top / P);
        if (top < k * P + g.margins.top - slack || bottom > k * P + g.height - g.margins.bottom + 2 + slack) {
          bad.push(`"${n.textContent.slice(0, 24)}" ${top.toFixed(0)}–${bottom.toFixed(0)} (page ${k + 1})`);
        }
      }
    }
    return bad;
  });

console.log('LibreWord e2e');

await test('start screen renders templates', async () => {
  await page.goto(BASE);
  await page.waitForSelector('.template-card');
  assert.ok((await page.$$('.template-card')).length >= 6);
});

await test('create a blank document and type with formatting', async () => {
  await page.click('.template-card >> nth=0');
  await editorReady();
  await page.click('.lw-document');
  await page.keyboard.type('Hello ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' world');
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /Hello <strong>bold<\/strong> world/);
  assert.equal(await page.getAttribute('[data-cmd="bold"]', 'aria-pressed'), 'false');
});

await test('ribbon applies styles, alignment and lists', async () => {
  await page.keyboard.press('Enter');
  await page.keyboard.type('A heading');
  await page.click('.style-card[data-style="heading1"]');
  await page.click('[data-cmd="center"]');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.click('[data-cmd="bullets"]');
  await page.keyboard.type('first item');
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<h1 style="text-align: center;?">A heading<\/h1>/);
  // Like Word, the new paragraph inherits the heading's alignment.
  assert.match(html, /<ul><li><p[^>]*>first item<\/p><\/li><\/ul>/);
});

await test('undo and redo', async () => {
  await page.keyboard.press('Control+z');
  await settle();
  let text = await page.evaluate(() => window.libreword.editor.getText());
  assert.ok(!text.includes('first item'));
  await page.keyboard.press('Control+y');
  text = await page.evaluate(() => window.libreword.editor.getText());
  assert.ok(text.includes('first item'));
});

await test('pagination keeps every line inside page margins', async () => {
  await page.evaluate(() => {
    const long = 'A long paragraph sentence that wraps across many lines of the page. '.repeat(90);
    const items = Array.from({ length: 45 }, (_, i) => `<li><p>Item ${i + 1}</p></li>`).join('');
    const rows = Array.from({ length: 45 }, (_, i) => `<tr><td><p>Row ${i + 1}</p></td><td><p>Value</p></td></tr>`).join('');
    window.libreword.editor.commands.setContent(`<h1>Doc</h1><p>${long}</p><ol>${items}</ol><table><tbody>${rows}</tbody></table><p>Before</p><div data-page-break></div><p>After break</p>`);
  });
  await settle();
  assert.deepEqual(await layoutViolations(), []);
  const pages = await page.evaluate(() => window.libreword.screen.pageCount);
  assert.ok(pages >= 5, `expected ≥5 pages, got ${pages}`);
  // "After break" must start at the top of a page.
  const afterTop = await page.evaluate(() => {
    const s = window.libreword.screen;
    const g = s.geometry;
    const el = [...s.editorEl.querySelectorAll('p')].find((p) => p.textContent === 'After break');
    const y = (el.getBoundingClientRect().top - s.editorEl.getBoundingClientRect().top) % (g.height + g.gap);
    return Math.round(y - g.margins.top);
  });
  assert.ok(Math.abs(afterTop) <= 1, `page break target off by ${afterTop}px`);
});

await test('incremental re-layout stays correct while editing', async () => {
  // Insert lines at the very top, which shifts everything that follows.
  await page.evaluate(() => window.libreword.editor.commands.focus('start'));
  for (let i = 0; i < 12; i++) {
    await page.keyboard.type(`Inserted line ${i}`);
    await page.keyboard.press('Enter');
  }
  await settle();
  assert.deepEqual(await layoutViolations(), []);
  // Delete a big chunk in the middle.
  await page.evaluate(() => {
    const ed = window.libreword.editor;
    const size = ed.state.doc.content.size;
    ed.chain().setTextSelection({ from: Math.floor(size * 0.3), to: Math.floor(size * 0.55) }).deleteSelection().run();
  });
  await settle();
  assert.deepEqual(await layoutViolations(), []);
  // Bold a range (a mark step: no positions move, heights may change).
  await page.evaluate(() => window.libreword.editor.chain().selectAll().setFontSize('16pt').run());
  await settle();
  assert.deepEqual(await layoutViolations(), []);
});

await test('find and replace all', async () => {
  await page.evaluate(() => window.libreword.editor.commands.setContent('<p>cat dog cat bird CAT</p>'));
  await page.keyboard.press('Control+h');
  await page.fill('.find-panel input[aria-label="Find"]', 'cat');
  await sleep(250);
  assert.equal((await page.textContent('.find-count')).trim(), '1 of 3');
  await page.fill('.find-panel input[aria-label="Replace with"]', 'fox');
  await page.click('.find-panel button:has-text("All")');
  const text = await page.evaluate(() => window.libreword.editor.getText());
  assert.equal(text, 'fox dog fox bird fox');
  await page.keyboard.press('Escape');
  // Closing the panel refocuses the editor on the next frame; wait for it so
  // the deferred focus can't steal the next test's typing.
  await page.waitForFunction(() => window.libreword.editor.isFocused);
});

await test('documents persist across reloads', async () => {
  await page.evaluate(() => window.libreword.editor.commands.setContent('<p>Persistent content 12345</p>'));
  await page.fill('.doc-title-input', 'Persistence test');
  await page.press('.doc-title-input', 'Enter');
  await page.keyboard.press('Control+s');
  await sleep(300);
  await page.reload();
  await editorReady();
  const text = await page.evaluate(() => window.libreword.editor.getText());
  assert.equal(text, 'Persistent content 12345');
  assert.equal(await page.inputValue('.doc-title-input'), 'Persistence test');
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row');
  assert.ok((await page.textContent('.doc-table')).includes('Persistence test'));
});

await test('export to .docx produces a valid Word document', async () => {
  await page.click('.doc-row:has-text("Persistence test")');
  await editorReady();
  await page.evaluate(() => window.libreword.editor.commands.setContent(
    '<h1>Export heading</h1><p>Some <strong>bold</strong> text.</p><ul><li><p>Bullet</p></li></ul><table><tbody><tr><td><p>Cell A</p></td><td><p>Cell B</p></td></tr></tbody></table>',
  ));
  await page.click('.ribbon-tab.is-file');
  await page.click('.backstage-nav button:has-text("Save a Copy")');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.export-option[data-format="docx"]')]);
  assert.match(download.suggestedFilename(), /\.docx$/);
  const buf = await readFile(await download.path());
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  assert.match(value, /<h1>Export heading<\/h1>/);
  assert.match(value, /<strong>bold<\/strong>/);
  assert.match(value, /Cell B/);
});

await test('export to Markdown', async () => {
  await page.click('.ribbon-tab.is-file');
  await page.click('.backstage-nav button:has-text("Save a Copy")');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.export-option[data-format="md"]')]);
  const md = await readFile(await download.path(), 'utf8');
  assert.match(md, /^# Export heading/m);
  assert.match(md, /\*\*bold\*\*/);
  assert.match(md, /\| Cell A \| Cell B \|/);
});

await test('import a Markdown file', async () => {
  await page.click('.app-logo');
  await page.waitForSelector('.template-card.is-import');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.template-card.is-import')]);
  await chooser.setFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Imported\n\nHello *there*.\n\n- [x] done\n- [ ] todo\n') });
  await page.waitForFunction(() => {
    const ed = window.libreword?.editor;
    return ed && !ed.isDestroyed && ed.getText().includes('Imported');
  });
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<h1>Imported<\/h1>/);
  assert.match(html, /<em>there<\/em>/);
  assert.match(html, /data-type="taskList"/);
  assert.equal(await page.inputValue('.doc-title-input'), 'notes');
});

await test('page setup changes the page geometry', async () => {
  await page.click('.ribbon-tab[data-tab="layout"]');
  await page.click('.rb[aria-label="Orientation"]');
  await page.click('.menu-item:has-text("Landscape")');
  await settle();
  const width = await page.evaluate(() => window.libreword.screen.editorEl.offsetWidth);
  assert.equal(width, 1056);
});

await test('Ctrl+Enter splits the paragraph onto a new page', async () => {
  await page.evaluate(() => {
    const ed = window.libreword.editor;
    ed.commands.setContent('<p>first half second half</p>');
    ed.commands.setTextSelection(12);
    ed.commands.focus();
  });
  await settle(); // TipTap focuses on the next animation frame
  await page.keyboard.press('Control+Enter');
  await settle();
  const json = await page.evaluate(() => window.libreword.editor.getJSON().content.map((n) => n.type));
  assert.deepEqual(json.slice(0, 3), ['paragraph', 'pageBreak', 'paragraph']);
  assert.equal(await page.evaluate(() => window.libreword.screen.pageCount), 2);
  await page.keyboard.press('Control+z');
  await settle();
  assert.equal(await page.evaluate(() => window.libreword.screen.pageCount), 1);
});

await test('format painter copies character formatting', async () => {
  await page.click('.ribbon-tab[data-tab="home"]');
  await page.evaluate(() => {
    const ed = window.libreword.editor;
    ed.commands.setContent('<p><strong><em>source</em></strong> target</p>');
    ed.commands.setTextSelection(3);
  });
  await page.click('.rb[aria-label="Format Painter"]');
  await page.evaluate(() => window.libreword.editor.commands.setTextSelection({ from: 8, to: 14 }));
  await page.dispatchEvent('.lw-document', 'mouseup');
  await settle();
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<strong><em>source<\/em><\/strong> <strong><em>target<\/em><\/strong>/);
});

await test('insert a link through the dialog', async () => {
  await page.evaluate(() => {
    const ed = window.libreword.editor;
    ed.commands.setContent('<p>visit example</p>');
    ed.commands.setTextSelection({ from: 7, to: 14 });
  });
  await page.keyboard.press('Control+k');
  await page.fill('dialog input[name="href"]', 'example.com');
  await page.press('dialog input[name="href"]', 'Enter');
  await page.waitForFunction(() => window.libreword.editor.getHTML().includes('<a '));
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<a [^>]*href="https:\/\/example\.com"[^>]*>example<\/a>/);
});

await test('insert a picture from a file', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  await page.evaluate(() => window.libreword.editor.commands.setContent('<p>pic: </p>'));
  await page.click('.ribbon-tab[data-tab="insert"]');
  await page.click('.rb[aria-label="Pictures"]');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.menu-item:has-text("This Device")')]);
  await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.libreword.editor.getHTML().includes('<img'));
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<img [^>]*src="data:image\/png;base64,/);
  assert.match(html, /alt="dot"/);
});

await test('dragging the ruler changes the left margin', async () => {
  await page.evaluate(() => window.libreword.screen.setLayout('print'));
  await page.evaluate(() => window.libreword.screen.updateSettings({ orientation: 'portrait', margins: { top: 96, bottom: 96, left: 96, right: 96 } }));
  await settle();
  const box = await page.locator('.ruler-handle[aria-label="Left margin"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 48, box.y + 4, { steps: 4 });
  await page.mouse.up();
  await settle();
  const left = await page.evaluate(() => window.libreword.screen.settings.margins.left);
  assert.ok(Math.abs(left - 144) <= 6, `left margin ${left}`);
});

await test('layout stays valid when zoomed', async () => {
  await page.evaluate(() => {
    window.libreword.editor.commands.setContent(Array.from({ length: 60 }, (_, i) => `<p>Zoomed paragraph ${i} with enough words to wrap onto a second line at this width, hopefully.</p>`).join(''));
    window.libreword.screen.setZoom(1.5);
  });
  await settle();
  assert.deepEqual(await layoutViolations(), []);
  await page.evaluate(() => window.libreword.screen.setZoom(0.5));
  await settle();
  assert.deepEqual(await layoutViolations(), []);
  await page.evaluate(() => window.libreword.screen.setZoom(1));
});

await test('table of contents lists headings with page numbers', async () => {
  await page.evaluate(() => window.libreword.editor.commands.setContent('<nav data-toc></nav><h1>One</h1><p>x</p><div data-page-break></div><h1>Two</h1><h2>Two point one</h2>'));
  await page.waitForFunction(() => document.querySelectorAll('.toc-entry').length === 3);
  await sleep(400);
  const entries = await page.$$eval('.toc-entry', (els) => els.map((e) => `${e.querySelector('.toc-text').textContent}:${e.querySelector('.toc-page').textContent}`));
  assert.deepEqual(entries, ['One:1', 'Two:2', 'Two point one:2']);
});

await test('comments: add, reply, resolve, persist and export', async () => {
  await page.evaluate(() => {
    const ed = window.libreword.editor;
    ed.commands.setContent('<p>Please review this sentence carefully.</p>');
    ed.commands.setTextSelection({ from: 8, to: 14 });
    ed.commands.focus();
  });
  await settle();
  await page.click('.ribbon-tab[data-tab="review"]');
  await page.click('[data-cmd="new-comment"]');
  await page.fill('dialog input[name="name"]', 'Ada Lovelace');
  await page.press('dialog input[name="name"]', 'Enter');
  await page.waitForSelector('.comment-card textarea');
  await page.fill('.comment-card textarea', 'Is this the right word?');
  await page.click('.comment-card .btn-primary');
  await page.fill('.comment-reply-input', 'Yes, keep it.');
  await page.press('.comment-reply-input', 'Enter');
  await page.waitForSelector('.comment-reply');
  assert.match(await page.evaluate(() => window.libreword.editor.getHTML()), /<span data-comment-id="[^"]+" class="lw-comment">review<\/span>/);
  await page.keyboard.press('Control+s');
  await sleep(300);
  await page.reload();
  await editorReady();
  await page.waitForSelector('.comment-card');
  assert.equal(await page.textContent('.comment-card .who strong'), 'Ada Lovelace');
  assert.match(await page.textContent('.comment-card'), /Is this the right word\?.*Yes, keep it\./s);
  await page.click('.comment-card button[aria-label="Resolve comment"]');
  assert.match(await page.textContent('.comment-card .who small'), /Resolved/);
  await page.click('.ribbon-tab.is-file');
  await page.click('.backstage-nav button:has-text("Save a Copy")');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.export-option[data-format="docx"]')]);
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  const xml = await zip.file('word/comments.xml').async('string');
  assert.match(xml, /Is this the right word\?/);
  assert.match(xml, /Yes, keep it\./);
  await page.click('.comment-card button[aria-label="Delete comment"]');
  assert.doesNotMatch(await page.evaluate(() => window.libreword.editor.getHTML()), /data-comment-id/);
});

await test('review regressions: drafts, clear formatting, go to page', async () => {
  await page.evaluate(() => window.libreword.editor.commands.setContent('<p>Alpha beta gamma delta.</p>'));
  await page.evaluate(() => {
    const ed = window.libreword.editor;
    ed.commands.setTextSelection({ from: 7, to: 11 });
  });
  await page.evaluate(() => window.libreword.screen.addComment());
  await page.waitForSelector('.comment-card textarea');
  await page.fill('.comment-card textarea', 'half-written draft');
  // Click back into the document and keep typing: the draft must survive.
  await page.evaluate(() => window.libreword.editor.commands.focus('end'));
  await settle();
  await page.keyboard.type(' more');
  await sleep(400);
  assert.equal(await page.inputValue('.comment-card textarea'), 'half-written draft');
  assert.match(await page.evaluate(() => window.libreword.editor.getText()), /delta\. more$/);
  await page.click('.comment-card .btn-primary');
  // Clear formatting keeps the comment anchor.
  await page.evaluate(() => window.libreword.editor.chain().selectAll().toggleBold().clearFormatting().run());
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /data-comment-id/);
  assert.doesNotMatch(html, /<strong>/);
  // Go To a page far below the viewport.
  await page.evaluate(() => window.libreword.editor.commands.setContent(Array.from({ length: 12 }, (_, i) => `<h2>Page ${i + 1}</h2><div data-page-break></div>`).join('') + '<p>end</p>'));
  await settle();
  await page.evaluate(() => { window.libreword.screen.canvas.scrollTop = 0; });
  await page.keyboard.press('Control+g');
  await page.fill('dialog input[name="page"]', '9');
  await page.press('dialog input[name="page"]', 'Enter');
  await page.waitForFunction(() => window.libreword.screen.statusPage.textContent.startsWith('Page 9 '));
});

await test('version history restores the pre-edit state', async () => {
  await page.click('.app-logo');
  await page.click('.template-card >> nth=1'); // Letter
  await editorReady();
  const original = await page.evaluate(() => window.libreword.editor.getText());
  await page.evaluate(() => window.libreword.editor.commands.setContent('<p>Completely rewritten.</p>'));
  await page.keyboard.press('Control+s');
  await sleep(400);
  await page.click('.ribbon-tab.is-file');
  await page.click('.backstage-nav button:has-text("Version History")');
  await page.waitForSelector('.version-row');
  await page.click('.version-row .btn-primary');
  await page.click('dialog .btn-primary');
  await page.waitForFunction((t) => window.libreword.editor.getText() === t, original);
  // The rewritten state was kept as a version too.
  await page.click('.ribbon-tab.is-file');
  await page.click('.backstage-nav button:has-text("Version History")');
  await page.waitForSelector('.version-row:has-text("Before restoring")');
  await page.keyboard.press('Escape');
});

await test('documents from LibreWord v1 are migrated', async () => {
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(`${BASE}favicon.svg`); // same origin, app not loaded
  await p2.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('libreword', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('documents', { keyPath: 'id', autoIncrement: true });
    req.onsuccess = () => {
      const tx = req.result.transaction('documents', 'readwrite');
      tx.objectStore('documents').add({ title: 'Old Quill doc', content: '<p>Written in <strong>v1</strong></p>', createdAt: 1, updatedAt: 2 });
      tx.oncomplete = () => { req.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }));
  await p2.goto(BASE);
  await p2.waitForSelector('.doc-row:has-text("Old Quill doc")');
  await p2.click('.doc-row:has-text("Old Quill doc")');
  await p2.waitForFunction(() => window.libreword?.editor?.getHTML().includes('<strong>v1</strong>'));
  await ctx2.close();
});

await test('back up all documents and restore them into a fresh profile', async () => {
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row');
  const titles = await page.$$eval('.doc-row strong', (els) => els.map((e) => e.textContent).sort());
  await page.click('button[aria-label="Backup and restore"]');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.menu-item:has-text("Back Up")')]);
  const backup = await readFile(await download.path());
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(BASE);
  await p3.click('button[aria-label="Backup and restore"]');
  const [chooser] = await Promise.all([p3.waitForEvent('filechooser'), p3.click('.menu-item:has-text("Restore")')]);
  await chooser.setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
  await p3.waitForFunction((n) => document.querySelectorAll('.doc-row').length === n, titles.length);
  assert.deepEqual(await p3.$$eval('.doc-row strong', (els) => els.map((e) => e.textContent).sort()), titles);
  await ctx3.close();
});

await test('the File backstage closes when leaving the document', async () => {
  await page.click('.template-card >> nth=0');
  await editorReady();
  await page.click('.ribbon-tab.is-file');
  await page.waitForSelector('.backstage');
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForSelector('.template-card');
  assert.equal(await page.$('.backstage'), null);
  assert.equal(await page.getAttribute('#app', 'inert'), null);
});

await test('the open document is renamed, not deleted, from File › Open', async () => {
  await page.click('.template-card >> nth=0');
  await editorReady();
  await page.click('.ribbon-tab.is-file');
  await page.click('.backstage-nav button:has-text("Open")');
  const row = '.backstage .doc-row >> nth=0';
  await page.click(`${row} >> .doc-actions button`);
  assert.equal(await page.$('.menu-item:has-text("Delete")'), null);
  await page.click('.menu-item:has-text("Rename")');
  await page.fill('dialog input', 'Renamed from the list');
  await page.click('dialog .btn-primary');
  await page.waitForSelector('.backstage .doc-row:has-text("Renamed from the list")');
  await page.keyboard.press('Escape');
  await page.click('.lw-document');
  await page.keyboard.type('x');
  await page.evaluate(() => window.libreword.screen.flush());
  assert.equal(await page.inputValue('.doc-title-input'), 'Renamed from the list');
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row:has-text("Renamed from the list")');
  await page.click('.doc-row:has-text("Renamed from the list")');
  await editorReady();
});

await test('a save from another tab pauses autosave instead of overwriting it', async () => {
  const id = await page.evaluate(() => window.libreword.screen.docId);
  const other = await context.newPage();
  other.on('pageerror', (e) => errors.push(e.message));
  await other.goto(`${BASE}#/doc/${id}`);
  await other.waitForFunction(() => window.libreword?.editor && !window.libreword.editor.isDestroyed);
  await other.evaluate(() => window.libreword.editor.commands.setContent('<p>From the other tab</p>'));
  await other.evaluate(() => window.libreword.screen.flush());
  await page.waitForSelector('.save-state:has-text("another tab")');
  await page.click('.lw-document');
  await page.keyboard.type('more');
  await sleep(1200); // past the autosave delay
  await other.reload();
  await other.waitForFunction(() => window.libreword?.editor && !window.libreword.editor.isDestroyed);
  assert.equal(await other.evaluate(() => window.libreword.editor.getText()), 'From the other tab');
  // Saving explicitly keeps this tab's version.
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.save-state:has-text("Saved")');
  await other.close();
});

await test('no runtime errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
stop();
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
