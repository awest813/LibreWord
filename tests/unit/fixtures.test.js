import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDocx } from '../../src/io/docx-import.js';

// Word-authored documents from mammoth's test suite (tests/fixtures/word).
const fixture = (name) => readFileSync(`tests/fixtures/word/${name}`);

describe('docx import of Word-authored files', () => {
  it('lists', async () => {
    expect((await readDocx(fixture('simple-list.docx'))).html).toMatch(/<ul><li><p[^>]*>Apple<\/p><\/li><li><p[^>]*>Banana<\/p><\/li><\/ul>/);
  });
  it('tables', async () => {
    expect((await readDocx(fixture('tables.docx'))).html).toMatch(/<table><tbody><tr><td colwidth="\d+"><p[^>]*>Top left<\/p><\/td>/);
  });
  it('character formatting', async () => {
    expect((await readDocx(fixture('underline.docx'))).html).toContain('<strong><u>Sunset</u></strong>');
    expect((await readDocx(fixture('strikethrough.docx'))).html).toContain('<s>Today&#39;s Special: Salmon</s>');
  });
  it('images', async () => {
    expect((await readDocx(fixture('tiny-picture.docx'))).html).toMatch(/<img src="data:image\/png;base64,[^"]+" width="10" height="10">/);
  });
  it('comments with authors', async () => {
    const r = await readDocx(fixture('comments.docx'));
    expect(r.html).toMatch(/<span data-comment-id="d0">Ouch<\/span>/);
    expect(r.comments.d0).toMatchObject({ author: 'Michael Williamson', text: 'A tachyon walks into a bar.' });
  });
  it('footnotes and endnotes', async () => {
    const r = await readDocx(fixture('footnotes.docx'));
    expect(r.html).toContain('Ouch<sup>1</sup>.<sup>2</sup>');
    expect(r.html).not.toMatch(/<h\d>Notes/); // stays out of the TOC
    expect(r.html).toContain('A tachyon walks into a bar.');
    expect((await readDocx(fixture('endnotes.docx'))).html).toContain('Fin.');
  });
  it('text boxes', async () => {
    expect((await readDocx(fixture('text-box.docx'))).html).toContain('Datum plane');
  });
  it('strict OOXML with unit measures', async () => {
    const r = await readDocx(fixture('strict-format.docx'));
    expect(r.html).toContain('Test');
    expect(r.settings).toMatchObject({ pageSize: 'a4', margins: { top: 96, right: 96, bottom: 96, left: 96 } });
  });
});
