/**
 * Saving back to files on the device (File System Access API).
 *   npm run build && npm run test:files
 *
 * Native pickers can't be driven by automation, so showOpenFilePicker /
 * showSaveFilePicker are replaced with files in the origin-private file
 * system, which are real FileSystemFileHandles with the same write API.
 */
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPreview } from './server.mjs';
import { createSuite, launchOptions } from './harness.mjs';

const { base, stop } = await startPreview();
// A regular (persistent) profile, as real users have: Chromium 153 crashes
// reading file handles back from IndexedDB in Playwright's incognito-style
// contexts.
const profile = await mkdtemp(join(tmpdir(), 'libreword-files-'));
const context = await chromium.launchPersistentContext(profile, { ...launchOptions(), viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = context.pages()[0] || await context.newPage();
// For --grep: start on the start screen.
const suite = createSuite(import.meta.url, { page, setup: async () => { await page.goto(base); await page.waitForSelector('.template-card'); } });
const { test, finish } = suite;
// A browser crash would otherwise surface as a cascade of "target closed" failures.
const crashed = (what) => () => { console.error(`\n${what} during “${suite.current}”`); stop(); process.exit(1); };
page.on('crash', crashed('The page crashed'));
const onExit = crashed('The browser exited');
context.on('close', onExit);

const sourceDocx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('Original text from disk')] })] }] }));

// Install fake pickers backed by OPFS before the app loads.
await page.addInitScript(() => {
  window.__opfs = async () => navigator.storage.getDirectory();
  window.__nextOpen = null; // file name to return from showOpenFilePicker
  window.__nextSave = null; // file name to return from showSaveFilePicker (null = cancel)
  window.showOpenFilePicker = async () => {
    const dir = await window.__opfs();
    return [await dir.getFileHandle(window.__nextOpen)];
  };
  window.showSaveFilePicker = async ({ suggestedName } = {}) => {
    if (window.__nextSave === null) throw new DOMException('cancelled', 'AbortError');
    const dir = await window.__opfs();
    window.__lastSuggested = suggestedName;
    return dir.getFileHandle(window.__nextSave, { create: true });
  };
  // "Open with LibreWord" from the OS file manager arrives through launchQueue.
  Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer: (fn) => { window.__launch = fn; } } });
});

const putFile = (name, bytes) => page.evaluate(async ({ name, bytes }) => {
  const dir = await navigator.storage.getDirectory();
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(new Uint8Array(bytes));
  await w.close();
}, { name, bytes: [...bytes] });

const readFile = (name) => page.evaluate(async (name) => {
  const dir = await navigator.storage.getDirectory();
  const f = await (await dir.getFileHandle(name)).getFile();
  return { bytes: [...new Uint8Array(await f.arrayBuffer())], text: await f.text(), lastModified: f.lastModified };
}, name);

const editorReady = () => page.waitForFunction(() => window.libreword?.editor && !window.libreword.editor.isDestroyed);
const chip = () => page.textContent('.file-chip');

console.log('LibreWord file saving');
await page.goto(base);
await page.waitForSelector('.template-card');

await test('opening a .docx links the document to the file', async () => {
  await putFile('report.docx', sourceDocx);
  await page.evaluate(() => { window.__nextOpen = 'report.docx'; });
  await page.click('.template-card.is-import');
  await editorReady();
  await page.waitForFunction(() => window.libreword.editor.getText().includes('Original text'));
  assert.match(await chip(), /report\.docx.*Saved/);
});

await test('editing marks the file as unsaved; Ctrl+S writes it back as .docx', async () => {
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent(' plus an edit').run());
  await page.waitForFunction(() => document.querySelector('.file-chip')?.textContent.includes('Unsaved'));
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('.file-chip')?.textContent.includes('Saved') && !document.querySelector('.file-chip').classList.contains('is-dirty'));
  const { bytes } = await readFile('report.docx');
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  assert.match(value, /Original text from disk plus an edit/);
});

await test('reopening the same unchanged file reuses its document', async () => {
  const before = await page.evaluate(() => window.libreword.screen.docId);
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row');
  const rows = await page.$$eval('.doc-row', (r) => r.length);
  await page.click('.template-card.is-import');
  await editorReady();
  assert.equal(await page.evaluate(() => window.libreword.screen.docId), before);
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row');
  assert.equal(await page.$$eval('.doc-row', (r) => r.length), rows);
  assert.match(await page.textContent('.doc-table'), /Saves to report\.docx/);
});

await test('leaving with unsaved file changes asks to save', async () => {
  await page.click('.doc-row:has-text("report")');
  await editorReady();
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent(' second edit').run());
  await page.waitForFunction(() => window.libreword.screen.fileDirty);
  await page.click('.app-logo');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.textContent('dialog[open]'), /Save changes\?.*report\.docx/s);
  await page.click('dialog[open] .btn-primary');
  await page.waitForSelector('.doc-row');
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from((await readFile('report.docx')).bytes) });
  assert.match(value, /second edit/);
});

await test('a file changed outside LibreWord is not silently overwritten', async () => {
  await page.click('.doc-row:has-text("report")');
  await editorReady();
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent(' third').run());
  await page.waitForTimeout(1100); // lastModified resolution
  await putFile('report.docx', sourceDocx); // another app saves the file
  await page.keyboard.press('Control+s');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.textContent('dialog[open]'), /changed outside LibreWord/);
  await page.click('dialog[open] button:has-text("Cancel")');
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from((await readFile('report.docx')).bytes) });
  assert.doesNotMatch(value, /third/);
  await page.keyboard.press('Control+s');
  await page.click('dialog[open] button:has-text("Replace")');
  await page.waitForFunction(() => !window.libreword.screen.fileDirty);
  const after = await mammoth.convertToHtml({ buffer: Buffer.from((await readFile('report.docx')).bytes) });
  assert.match(after.value, /third/);
});

await test('Markdown files save back as Markdown after a one-time notice', async () => {
  await putFile('notes.md', Buffer.from('# Notes\n\nHello *world*.\n'));
  await page.click('.app-logo');
  await page.evaluate(() => { window.__nextOpen = 'notes.md'; });
  await page.click('.template-card.is-import');
  await editorReady();
  await page.waitForFunction(() => window.libreword.editor.getText().includes('Hello'));
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'Added line' }] }).run());
  await page.keyboard.press('Control+s');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.textContent('dialog[open]'), /Keep using Markdown/);
  await page.click('dialog[open] .btn-primary');
  await page.waitForFunction(() => !window.libreword.screen.fileDirty);
  assert.equal((await readFile('notes.md')).text, '# Notes\n\nHello *world*.\n\nAdded line\n');
  // Second save: no notice.
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent(' again').run());
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.libreword.screen.fileDirty);
  assert.equal(await page.$('dialog[open]'), null);
});

await test('Save As links a new document to the chosen file', async () => {
  await page.click('.app-logo');
  await page.click('.template-card >> nth=0');
  await editorReady();
  await page.evaluate(() => window.libreword.editor.commands.insertContent('Brand new'));
  await page.fill('.doc-title-input', 'Fresh doc');
  await page.press('.doc-title-input', 'Enter');
  await page.evaluate(() => { window.__nextSave = 'fresh.docx'; });
  await page.keyboard.press('Control+Shift+S');
  await page.waitForFunction(() => window.libreword.screen.file?.name === 'fresh.docx' && !window.libreword.screen.fileDirty);
  assert.equal(await page.evaluate(() => window.__lastSuggested), 'Fresh doc.docx');
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from((await readFile('fresh.docx')).bytes) });
  assert.match(value, /Brand new/);
  // Cancelling Save As changes nothing.
  await page.evaluate(() => { window.__nextSave = null; });
  await page.keyboard.press('Control+Shift+S');
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.libreword.screen.file?.name), 'fresh.docx');
});

await test('Stop Saving to This File unlinks it', async () => {
  await page.click('.ribbon-tab.is-file');
  await page.click('.backstage-nav button:has-text("Info")');
  await page.click('button:has-text("Stop Saving to This File")');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.libreword.screen.file), null);
  assert.equal(await page.isHidden('.file-chip'), true);
});

await test("Don't Save keeps the changes marked unsaved, and Back asks too", async () => {
  await page.evaluate(() => { window.__nextOpen = 'report.docx'; });
  await page.click('.app-logo');
  await page.click('.template-card.is-import');
  await editorReady();
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent(' not yet saved').run());
  await page.waitForFunction(() => window.libreword.screen.fileDirty);
  await page.waitForTimeout(900); // autosave to the browser
  // Browser Back button goes through the router: it must ask as well.
  await page.goBack();
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] button:has-text("Don’t Save")');
  await page.waitForSelector('.template-card');
  await page.click('.doc-row:has-text("report")');
  await editorReady();
  assert.match(await chip(), /Unsaved changes/);
  assert.match(await page.evaluate(() => window.libreword.editor.getText()), /not yet saved/);
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from((await readFile('report.docx')).bytes) });
  assert.doesNotMatch(value, /not yet saved/);
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.libreword.screen.fileDirty);
});

await test('cancelling Save As midway keeps the existing link', async () => {
  // Linked to report.docx; Save As to a .md, then cancel the Markdown notice.
  await page.evaluate(() => { window.__nextSave = 'copy.md'; });
  await page.keyboard.press('Control+Shift+S');
  await page.waitForSelector('dialog[open]');
  await page.click('dialog[open] button:has-text("Cancel")');
  await page.waitForFunction(() => window.libreword.screen.file?.name === 'report.docx');
  assert.match(await chip(), /report\.docx/);
});

await test('reopening a file that changed on disk refreshes the same document', async () => {
  const id = await page.evaluate(() => window.libreword.screen.docId);
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row');
  const rows = await page.$$eval('.doc-row', (r) => r.length);
  await page.waitForTimeout(1100);
  const changed = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('Edited in Word')] })] }] }));
  await putFile('report.docx', changed);
  await page.evaluate(() => { window.__nextOpen = 'report.docx'; });
  await page.click('.template-card.is-import');
  await page.waitForFunction(() => { const ed = window.libreword?.editor; return ed && !ed.isDestroyed && ed.getText().includes('Edited in Word'); });
  assert.equal(await page.evaluate(() => window.libreword.screen.docId), id);
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row');
  assert.equal(await page.$$eval('.doc-row', (r) => r.length), rows);
});

await test('reopening a changed file while it is open shows the new version and keeps it', async () => {
  const launch = (name) => page.evaluate(async (n) => {
    const dir = await navigator.storage.getDirectory();
    await window.__launch({ files: [await dir.getFileHandle(n)] });
  }, name);
  await launch('report.docx');
  await page.waitForFunction(() => { const ed = window.libreword?.editor; return ed && !ed.isDestroyed && ed.getText().includes('Edited in Word'); });
  const id = await page.evaluate(() => window.libreword.screen.docId);
  await page.waitForTimeout(1100);
  const changed = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun('Edited again elsewhere')] })] }] }));
  await putFile('report.docx', changed);
  await launch('report.docx');
  await page.waitForFunction(() => { const ed = window.libreword?.editor; return ed && !ed.isDestroyed && ed.getText().includes('Edited again elsewhere'); });
  assert.equal(await page.evaluate(() => window.libreword.screen.docId), id);
  // The editor that showed the old version must not save it over the reload.
  await page.waitForTimeout(1000);
  await page.reload();
  await page.waitForFunction(() => { const ed = window.libreword?.editor; return ed && !ed.isDestroyed && ed.getText().length > 0; });
  assert.match(await page.evaluate(() => window.libreword.editor.getText()), /Edited again elsewhere/);
});

await test('Ctrl+O on the start screen opens a file', async () => {
  await page.click('.app-logo');
  await page.waitForSelector('.template-card');
  await putFile('shortcut.md', Buffer.from('# Opened with Ctrl+O\n'));
  await page.evaluate(() => { window.__nextOpen = 'shortcut.md'; });
  await page.keyboard.press('Control+o');
  await page.waitForFunction(() => { const ed = window.libreword?.editor; return ed && !ed.isDestroyed && ed.getText().includes('Opened with Ctrl+O'); });
  assert.match(await chip(), /shortcut\.md/);
  // A file that ends in a heading gets a trailing paragraph on focus; that isn't an unsaved change.
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.libreword.screen.fileDirty), false);
});

await test('Open with LibreWord: several files open the first and list the rest', async () => {
  await page.click('.app-logo');
  await page.waitForSelector('.template-card');
  await putFile('launch-a.md', Buffer.from('First launched file\n'));
  await putFile('launch-b.txt', Buffer.from('Second launched file\n'));
  await page.evaluate(async () => {
    const dir = await navigator.storage.getDirectory();
    await window.__launch({ files: [await dir.getFileHandle('launch-a.md'), await dir.getFileHandle('launch-b.txt')] });
  });
  await page.waitForFunction(() => { const ed = window.libreword?.editor; return ed && !ed.isDestroyed && ed.getText().includes('First launched file'); });
  assert.match(await chip(), /launch-a\.md/);
  await page.click('.app-logo');
  await page.waitForSelector('.doc-row');
  const titles = await page.$$eval('.doc-row', (rows) => rows.map((r) => r.textContent));
  assert.ok(titles.some((t) => t.includes('launch-b')), `launch-b missing from ${titles.join(' | ')}`);
});

const goHome = async () => {
  await page.click('.app-logo');
  await page.waitForSelector('.template-card');
};
const openFromPicker = async (name) => {
  await goHome();
  await page.evaluate((n) => { window.__nextOpen = n; }, name);
  await page.click('.template-card.is-import');
  await editorReady();
};
const editorText = () => page.evaluate(() => window.libreword.editor.getText());

await test('OpenDocument: opens an .odt from LibreOffice, saves back to it and Save As writes .odt', async () => {
  await putFile('sample.odt', readFileSync('tests/fixtures/odt/sample.odt'));
  await openFromPicker('sample.odt');
  await page.waitForFunction(() => window.libreword.editor.getText().includes('Quarterly Notes'));
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<h1[^>]*>Quarterly Notes<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<th[^>]*>.*Item/s);
  assert.match(await chip(), /sample\.odt/);
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'Edited in LibreWord' }] }).run());
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !window.libreword.screen.fileDirty);
  const saved = await JSZip.loadAsync(Buffer.from((await readFile('sample.odt')).bytes));
  assert.equal(await saved.file('mimetype').async('string'), 'application/vnd.oasis.opendocument.text');
  const content = await saved.file('content.xml').async('string');
  assert.match(content, /Edited in LibreWord/);
  assert.match(content, /Quarterly Notes/);
  // Save As to a new .odt keeps saving there.
  await page.evaluate(() => { window.__nextSave = 'copy.odt'; });
  await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(() => window.libreword.screen.file?.name === 'copy.odt' && !window.libreword.screen.fileDirty);
  const copy = await JSZip.loadAsync(Buffer.from((await readFile('copy.odt')).bytes));
  assert.match(await copy.file('content.xml').async('string'), /Edited in LibreWord/);
});

await test('Rich Text: opens with formatting and saves back as .rtf after the one-time notice', async () => {
  await putFile('letter.rtf', Buffer.from('{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Arial;}}\\f0\\fs24 Dear {\\b Ada},\\par Caf\\\'e9 at {\\i noon}.\\par}'));
  await openFromPicker('letter.rtf');
  await page.waitForFunction(() => window.libreword.editor.getText().includes('Dear'));
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<strong>Ada<\/strong>/);
  assert.match(html, /Café/);
  assert.match(html, /<em>noon<\/em>/);
  assert.match(await chip(), /letter\.rtf/);
  await page.evaluate(() => window.libreword.editor.chain().focus('end').insertContent(' Bye!').run());
  await page.keyboard.press('Control+s');
  await page.waitForSelector('dialog[open]');
  assert.match(await page.textContent('dialog[open]'), /Rich Text/);
  await page.click('dialog[open] .btn-primary');
  await page.waitForFunction(() => !window.libreword.screen.fileDirty);
  const rtf = (await readFile('letter.rtf')).text;
  assert.match(rtf, /^\{\\rtf1/);
  assert.match(rtf, /Bye!/);
  assert.match(rtf, /\\b\b/);
});

await test('Word 97–2003: opens a .doc, explains it can’t save back, and Save As writes .docx', async () => {
  await putFile('formatting.doc', readFileSync('tests/fixtures/doc/formatting.doc'));
  await openFromPicker('formatting.doc');
  await page.waitForSelector('.toast:has-text("can’t save .doc files")');
  const html = await page.evaluate(() => window.libreword.editor.getHTML());
  assert.match(html, /<h1[^>]*>/);
  assert.match(html, /<strong>/);
  assert.equal(await page.isVisible('.file-chip'), false); // opened as a copy
  await page.evaluate(() => { window.__nextSave = 'formatting.docx'; });
  await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(() => window.libreword.screen.file?.name === 'formatting.docx' && !window.libreword.screen.fileDirty);
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from((await readFile('formatting.docx')).bytes) });
  assert.match(value, /<h1>/);
});

await test('text files in UTF-16 and Windows-1252 open with the right characters', async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße aus Köln — 東京\r\nline two', 'utf16le')]);
  await putFile('utf16.txt', utf16);
  await openFromPicker('utf16.txt');
  await page.waitForFunction(() => window.libreword.editor.getText().includes('line two'));
  assert.equal(await page.evaluate(() => window.libreword.editor.getText({ blockSeparator: '|' })), 'Grüße aus Köln — 東京|line two');
  await putFile('ansi.txt', Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x20, 0x93, 0x71, 0x94]));
  await openFromPicker('ansi.txt');
  await page.waitForFunction(() => window.libreword.editor.getText().includes('Caf'));
  assert.equal(await editorText(), 'Café €5 “q”');
});

await test('unsupported files say what to do instead', async () => {
  await putFile('scan.pdf', Buffer.from('%PDF-1.4'));
  await goHome();
  await page.evaluate(() => { window.__nextOpen = 'scan.pdf'; });
  await page.click('.template-card.is-import');
  await page.waitForSelector('.toast:has-text("PDF files can’t be edited")');
});

context.off('close', onExit);
await context.close();
await rm(profile, { recursive: true, force: true });
stop();
process.exit(finish());
