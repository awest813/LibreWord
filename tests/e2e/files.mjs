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
import { startPreview, CHROME } from './server.mjs';

const { base, stop } = await startPreview();
const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${String(err.message).split('\n').slice(0, 12).join('\n    ')}`);
  }
}

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

await test('no runtime errors', async () => {
  assert.deepEqual(errors, []);
});

await browser.close();
stop();
console.log(failures ? `\n${failures} failing` : '\nall passing');
process.exit(failures ? 1 : 0);
