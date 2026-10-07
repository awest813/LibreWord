import { downloadBlob, safeFileName, escapeHtml } from '../ui/dom.js';
import { pageGeometry } from '../editor/page-setup.js';
import { collectHeadings } from '../editor/toc.js';
import documentCss from '../styles/document.css?inline';

export const EXPORT_FORMATS = [
  { id: 'docx', label: 'Word Document', ext: '.docx', icon: 'file' },
  { id: 'odt', label: 'OpenDocument Text', ext: '.odt', icon: 'file' },
  { id: 'pdf', label: 'PDF', ext: '.pdf', icon: 'fileDown' },
  { id: 'html', label: 'Web Page', ext: '.html', icon: 'webLayout' },
  { id: 'rtf', label: 'Rich Text Format', ext: '.rtf', icon: 'type' },
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
  // A replacer function, so "$&" or "$'" in a heading stays literal text.
  return html.replace(/<nav[^>]*data-toc[^>]*>\s*<\/nav>/g, () => toc);
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
/* Tabs and runs of spaces are content, as in the editor. */
.lw-document :is(p, h1, h2, h3, h4, h5, h6, li, td, th) { white-space: pre-wrap; }
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

/** Page of each heading, for the table of contents' cached entries. */
function tocPagesOf(editor) {
  const pageOf = editor.extensionManager.extensions.find((e) => e.name === 'tableOfContents')?.options.getPageOf;
  return collectHeadings(editor.state.doc).map((h) => {
    try {
      return pageOf?.(h.pos) ?? null;
    } catch {
      return null;
    }
  });
}

/** The document as a file in the given format (docx, odt, rtf, html, md, txt). */
export async function renderDocumentBlob(editor, format, { title, settings, comments = {} }) {
  switch (format) {
    case 'docx': {
      const { docxBlob } = await import('./docx.js');
      return docxBlob(editor.getJSON(), settings, { title, comments, tocPages: tocPagesOf(editor) });
    }
    case 'odt': {
      const { writeOdt } = await import('./odt.js');
      // ODF only numbers the first three heading levels in its contents.
      const pages = tocPagesOf(editor);
      const levels = collectHeadings(editor.state.doc).map((h) => h.level);
      return writeOdt(editor.getJSON(), settings, { title, comments, tocPages: pages.filter((_, i) => levels[i] <= 3), blob: true });
    }
    case 'rtf': {
      const { jsonToRtf } = await import('./rtf.js');
      return new Blob([jsonToRtf(editor.getJSON(), { title, settings })], { type: 'application/rtf' });
    }
    case 'html':
      return new Blob([standaloneHtml(editor, title, settings)], { type: 'text/html;charset=utf-8' });
    case 'md': {
      const { jsonToMarkdown } = await import('./markdown.js');
      return new Blob([jsonToMarkdown(editor.getJSON())], { type: 'text/markdown;charset=utf-8' });
    }
    case 'txt':
      return new Blob([editor.getText({ blockSeparator: '\n\n' })], { type: 'text/plain;charset=utf-8' });
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

export async function exportDocument(editor, format, meta) {
  if (format === 'pdf') {
    printDocument(meta.title);
    return;
  }
  const name = safeFileName(meta.title || 'Untitled document');
  const ext = EXPORT_FORMATS.find((f) => f.id === format)?.ext.slice(1) || format;
  downloadBlob(await renderDocumentBlob(editor, format, meta), `${name}.${ext}`);
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
