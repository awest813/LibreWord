import { downloadBlob, safeFileName, escapeHtml } from '../ui/dom.js';
import { pageGeometry } from '../editor/page-setup.js';
import { collectHeadings } from '../editor/toc.js';
import documentCss from '../styles/document.css?inline';

export const EXPORT_FORMATS = [
  { id: 'docx', label: 'Word Document', ext: '.docx', icon: 'file' },
  { id: 'pdf', label: 'PDF', ext: '.pdf', icon: 'fileDown' },
  { id: 'html', label: 'Web Page', ext: '.html', icon: 'webLayout' },
  { id: 'md', label: 'Markdown', ext: '.md', icon: 'code' },
  { id: 'txt', label: 'Plain Text', ext: '.txt', icon: 'type' },
];

/** HTML of the document with live widgets (TOC) rendered statically. */
export function staticHtml(editor) {
  const html = editor.getHTML();
  if (!html.includes('data-toc')) return html;
  const headings = collectHeadings(editor.state.doc);
  const min = Math.min(6, ...headings.map((h) => h.level));
  const toc = `<nav data-toc class="toc"><div class="toc-title">Contents</div>${headings
    .map((h) => `<div class="toc-entry toc-level-${h.level - min + 1}"><span class="toc-text">${escapeHtml(h.text)}</span></div>`)
    .join('')}</nav>`;
  return html.replace(/<nav[^>]*data-toc[^>]*>\s*<\/nav>/g, toc);
}

export function standaloneHtml(editor, title, settings) {
  const g = pageGeometry(settings);
  return `<!doctype html>
<html lang="${document.documentElement.lang || 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="LibreWord">
<title>${escapeHtml(title)}</title>
<style>
${documentCss}
body { margin: 0; background: #fff; color: #000; }
.lw-document { max-width: ${g.contentWidth}px; margin: 0 auto; padding: 48px 24px; }
.page-break { break-after: page; height: 0; border: 0; }
@media screen { .page-break { border-top: 1px dashed #bbb; margin: 24px 0; } }
@page { size: ${g.width}px ${g.height}px; margin: ${g.margins.top}px ${g.margins.right}px ${g.margins.bottom}px ${g.margins.left}px; }
@media print { .lw-document { padding: 0; max-width: none; } }
</style>
</head>
<body>
<article class="lw-document">
${staticHtml(editor)}
</article>
</body>
</html>`;
}

export async function exportDocument(editor, format, { title, settings }) {
  const name = safeFileName(title || 'Untitled document');
  switch (format) {
    case 'docx': {
      const { docxBlob } = await import('./docx.js');
      const blob = await docxBlob(editor.getJSON(), settings, { title });
      downloadBlob(blob, `${name}.docx`);
      return;
    }
    case 'html':
      downloadBlob(new Blob([standaloneHtml(editor, title, settings)], { type: 'text/html;charset=utf-8' }), `${name}.html`);
      return;
    case 'md': {
      const { jsonToMarkdown } = await import('./markdown.js');
      downloadBlob(new Blob([jsonToMarkdown(editor.getJSON())], { type: 'text/markdown;charset=utf-8' }), `${name}.md`);
      return;
    }
    case 'txt':
      downloadBlob(new Blob([editor.getText({ blockSeparator: '\n\n' })], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
      return;
    case 'pdf':
      printDocument(title);
      return;
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

/**
 * Printing uses the browser's own engine, which produces a vector PDF via
 * "Save as PDF". Page size, margins, header/footer are applied with @page
 * rules injected by the editor screen (see applyPrintStyles).
 */
export function printDocument(title) {
  const previous = document.title;
  if (title) document.title = title;
  window.print();
  setTimeout(() => {
    document.title = previous;
  }, 500);
}

const cssString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

export function printCss(settings) {
  const g = pageGeometry(settings);
  const footerParts = [];
  if (settings.footer) footerParts.push(cssString(settings.footer));
  if (settings.pageNumbers) footerParts.push(`${settings.footer ? '"   " ' : ''}"Page " counter(page) " of " counter(pages)`);
  return `@page {
  size: ${g.width}px ${g.height}px;
  margin: ${g.margins.top}px ${g.margins.right}px ${g.margins.bottom}px ${g.margins.left}px;
  ${settings.header ? `@top-right { content: ${cssString(settings.header)}; font: 9pt Calibri, Carlito, sans-serif; color: #595959; }` : ''}
  ${footerParts.length ? `@bottom-center { content: ${footerParts.join(' ')}; font: 9pt Calibri, Carlito, sans-serif; color: #595959; }` : ''}
}`;
}
