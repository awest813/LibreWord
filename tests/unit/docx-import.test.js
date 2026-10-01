import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readDocx } from '../../src/io/docx-import.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** Build a minimal .docx from body XML plus optional parts. */
async function docx(body, { numbering, styles, footer } = {}) {
  const zip = new JSZip();
  const sect = footer ? '<w:sectPr><w:footerReference w:type="default" r:id="rIdF"/></w:sectPr>' : '';
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`);
  const rels = [];
  if (numbering) zip.file('word/numbering.xml', `<?xml version="1.0"?><w:numbering ${NS}>${numbering}</w:numbering>`);
  if (styles) zip.file('word/styles.xml', `<?xml version="1.0"?><w:styles ${NS}>${styles}</w:styles>`);
  if (footer) {
    zip.file('word/footer1.xml', `<?xml version="1.0"?><w:ftr ${NS}>${footer}</w:ftr>`);
    rels.push('<Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>');
  }
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  return readDocx(await zip.generateAsync({ type: 'uint8array' }));
}

const p = (inner, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const r = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const decimal = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
const item = (text, ilvl = 0, numId = 1) => p(r(text), `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);

describe('docx import edge cases', () => {
  it('splits a paragraph at an inner page break', async () => {
    const { html } = await docx(p(r('One')) + p('<w:r><w:br w:type="page"/></w:r>' + r('Two')) + p(r('A') + '<w:r><w:br w:type="page"/></w:r>' + r('B')));
    expect(html).toBe('<p>One</p><div data-page-break></div><p>Two</p><p>A</p><div data-page-break></div><p>B</p>');
  });

  it('drops page-number field results from footers, in any language', async () => {
    const field = (instr, shown) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${r(shown)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const only = await docx(p(r('x')), { footer: p(field('PAGE', '1')) });
    expect(only.settings).toMatchObject({ footer: '', pageNumbers: true });
    const german = await docx(p(r('x')), { footer: p(r('Vertraulich   ') + r('Seite ') + field('PAGE', '1') + r(' von ') + field('NUMPAGES', '3')) });
    expect(german.settings).toMatchObject({ footer: 'Vertraulich', pageNumbers: true });
  });

  it('keeps text moved with tracked changes', async () => {
    const { html } = await docx(p(`<w:moveFrom w:id="1">${r('old')}</w:moveFrom><w:moveTo w:id="2">${r('moved')}</w:moveTo>`));
    expect(html).toBe('<p>moved</p>');
  });

  it('survives list paragraphs without numbering.xml', async () => {
    const { html } = await docx(item('a'));
    expect(html).toBe('<p>a</p>');
  });

  it('continues numbering across an interrupting paragraph and honours startOverride', async () => {
    const { html } = await docx(item('a') + item('b') + p(r('mid')) + item('c'), { numbering: decimal });
    expect(html).toBe('<ol><li><p>a</p></li><li><p>b</p></li></ol><p>mid</p><ol start="3"><li><p>c</p></li></ol>');
    const overridden = await docx(item('x', 0, 2), { numbering: `${decimal}<w:num w:numId="2"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>` });
    expect(overridden.html).toBe('<ol start="5"><li><p>x</p></li></ol>');
  });

  it('inherits numId from the paragraph style when only ilvl is given', async () => {
    const styles = '<w:style w:type="paragraph" w:styleId="LB"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>';
    const { html } = await docx(p(r('top'), '<w:pStyle w:val="LB"/>') + p(r('sub'), '<w:pStyle w:val="LB"/><w:numPr><w:ilvl w:val="1"/></w:numPr>'), { numbering: decimal, styles });
    expect(html).toBe('<ol><li><p>top</p><ul><li><p>sub</p></li></ul></li></ol>');
  });

  it('lets direct formatting switch off a style\'s strikethrough', async () => {
    const styles = '<w:style w:type="character" w:styleId="S"><w:name w:val="Struck"/><w:rPr><w:strike/></w:rPr></w:style>';
    const { html } = await docx(p(r('plain', '<w:rStyle w:val="S"/><w:strike w:val="0"/>') + r(' struck', '<w:rStyle w:val="S"/>')), { styles });
    expect(html).toBe('<p>plain<s> struck</s></p>');
  });

  it('sanitises font names', async () => {
    const { html } = await docx(p(r('x', '<w:rFonts w:ascii="Evil&quot;;}Font"/>')));
    expect(html).toBe('<p><span style="font-family: EvilFont">x</span></p>');
  });
});
