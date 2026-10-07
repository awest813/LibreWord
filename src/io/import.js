import DOMPurify from 'dompurify';

/**
 * Every format LibreWord opens, by extension. `kind` picks the reader. The
 * MIME types feed the file picker (some systems filter by type, others by
 * extension, so both are listed).
 */
export const OPEN_FORMATS = {
  docx: { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  docm: { kind: 'docx', mime: 'application/vnd.ms-word.document.macroEnabled.12' },
  dotx: { kind: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template' },
  dotm: { kind: 'docx', mime: 'application/vnd.ms-word.template.macroEnabled.12' },
  doc: { kind: 'doc', mime: 'application/msword' },
  dot: { kind: 'doc', mime: 'application/msword' },
  odt: { kind: 'odt', mime: 'application/vnd.oasis.opendocument.text' },
  ott: { kind: 'odt', mime: 'application/vnd.oasis.opendocument.text-template' },
  fodt: { kind: 'odt', mime: 'application/vnd.oasis.opendocument.text-flat-xml' },
  rtf: { kind: 'rtf', mime: 'application/rtf' },
  md: { kind: 'md', mime: 'text/markdown' },
  markdown: { kind: 'md', mime: 'text/markdown' },
  mdown: { kind: 'md', mime: 'text/markdown' },
  mkd: { kind: 'md', mime: 'text/markdown' },
  html: { kind: 'html', mime: 'text/html' },
  htm: { kind: 'html', mime: 'text/html' },
  xhtml: { kind: 'html', mime: 'application/xhtml+xml' },
  txt: { kind: 'txt', mime: 'text/plain' },
  text: { kind: 'txt', mime: 'text/plain' },
  log: { kind: 'txt', mime: 'text/plain' },
};
export const IMPORT_ACCEPT = Object.keys(OPEN_FORMATS).map((e) => `.${e}`).join(',');
export const extOf = (name = '') => (String(name).match(/\.([^./\\]+)$/)?.[1] || '').toLowerCase();
/** Can LibreWord open this file (by name)? */
export const canOpen = (name) => Boolean(OPEN_FORMATS[extOf(name)]);

/** What to tell people about common files LibreWord can't open. */
const NOT_SUPPORTED = {
  pdf: 'PDF files can’t be edited in LibreWord. If you have the original document (.docx, .odt…), open that instead.',
  pages: 'Apple Pages files can’t be opened. In Pages, choose File › Export To › Word, then open the .docx.',
  wps: 'Microsoft Works files can’t be opened. Save the file as .docx or .rtf first.',
  wpd: 'WordPerfect files can’t be opened. Save the file as .docx, .odt or .rtf first.',
  xls: 'That’s a spreadsheet. LibreWord opens text documents.', xlsx: 'That’s a spreadsheet. LibreWord opens text documents.', ods: 'That’s a spreadsheet. LibreWord opens text documents.', csv: 'That’s a spreadsheet. LibreWord opens text documents.',
  ppt: 'That’s a presentation. LibreWord opens text documents.', pptx: 'That’s a presentation. LibreWord opens text documents.', odp: 'That’s a presentation. LibreWord opens text documents.',
};

/**
 * Decode a text file: byte-order marks (UTF-8, UTF-16), UTF-16 without one,
 * then UTF-8, falling back to Windows-1252 for older files from Windows.
 * For HTML, a declared <meta charset> wins.
 */
export function decodeText(buffer, { html = false } = {}) {
  const b = new Uint8Array(buffer);
  const decode = (enc, from = 0) => new TextDecoder(enc).decode(b.subarray(from));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return decode('utf-8', 3);
  if (b[0] === 0xff && b[1] === 0xfe) return decode('utf-16le', 2);
  if (b[0] === 0xfe && b[1] === 0xff) return decode('utf-16be', 2);
  // UTF-16 without a BOM: mostly-ASCII text has a zero in every other byte.
  const n = Math.min(b.length, 2000) & ~1;
  if (n >= 4) {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < n; i += 2) {
      if (b[i] === 0) even++;
      if (b[i + 1] === 0) odd++;
    }
    if (odd > n / 4 && even < n / 40) return decode('utf-16le');
    if (even > n / 4 && odd < n / 40) return decode('utf-16be');
  }
  if (html) {
    const head = new TextDecoder('latin1').decode(b.subarray(0, 2048));
    const charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
    if (charset && !/^utf-?8$/i.test(charset)) {
      try {
        return decode(charset);
      } catch { /* unknown label: carry on */ }
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return windows1252(b);
  }
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F (€, curly quotes, dashes…).
// Decoded by hand: some TextDecoder implementations (Node's) treat the label as Latin-1.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
function windows1252(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192)).replace(/[\x80-\x9f]/g, (c) => CP1252[c.charCodeAt(0) - 0x80]);
  }
  return out;
}

export function sanitizeHtml(html) {
  return DOMPurify.sanitize(String(html || ''), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'meta', 'link'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    ADD_ATTR: ['colwidth'], // table column widths (prosemirror-tables)
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|data:image\/(?:png|gif|jpe?g|webp|svg\+xml|bmp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}

/**
 * HTML collapses tabs, runs of spaces and leading spaces, but in a word
 * processor they are content ("Name:<tab>Value", indented code). Mark the
 * paragraphs that have any with white-space: pre-wrap, which the editor's
 * parser honours, so they survive import. Only for sources where whitespace
 * is meaningful: .docx, .txt and LibreWord's own HTML export, not arbitrary
 * pretty-printed web pages.
 */
export function preserveSpaces(html) {
  if (!/\t| {2}|> /.test(html)) return html;
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const el of doc.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th')) {
    if (/^(LI|TD|TH)$/.test(el.tagName) && ![...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) continue;
    if (/\t| {2}|^ /.test(el.textContent)) el.style.whiteSpace = 'pre-wrap';
  }
  return doc.body.innerHTML;
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function textToHtml(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

export async function markdownToHtml(md) {
  const { marked } = await import('marked');
  const html = await marked.parse(String(md), { gfm: true, breaks: false });
  // GFM task lists → TipTap task list markup.
  // Convert GFM checkboxes before sanitizing (the sanitizer drops <input>).
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script').forEach((el) => el.remove());
  doc.querySelectorAll('ul').forEach((ul) => {
    const items = [...ul.children];
    if (!items.length || !items.every((li) => li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'))) return;
    ul.setAttribute('data-type', 'taskList');
    items.forEach((li) => {
      const box = li.querySelector('input[type="checkbox"]');
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', box?.checked ? 'true' : 'false');
      box?.remove();
    });
  });
  return sanitizeHtml(doc.body.innerHTML);
}

// \ansicpgN values whose TextDecoder label isn't simply "windows-N".
const RTF_CODEPAGES = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' };
// cp1252's 0x80–0x9F block, decoded by hand: some TextDecoder builds (Node 22) treat it as Latin-1.
const CP1252_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
const cp1252 = (bytes) => bytes.map((b) => (b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join('');

/** Byte decoder for the document's \ansicpg code page (cp1252 by default). */
function rtfDecoder(rtf) {
  const cp = Number(/\\ansicpg(\d+)/.exec(rtf)?.[1]) || 1252;
  if (cp !== 1252) {
    try {
      const decoder = new TextDecoder(RTF_CODEPAGES[cp] || `windows-${cp}`);
      return (bytes) => decoder.decode(new Uint8Array(bytes));
    } catch { /* unknown code page: fall back to cp1252 */ }
  }
  return cp1252;
}

/** Strip a minimal RTF document down to its text (good enough for plain RTF). */
export function rtfToText(rtf) {
  let depth = 0;
  let skipDepth = -1;
  let out = '';
  // \'xx escapes are bytes in the document's code page (cp1252 unless \ansicpg says
  // otherwise); consecutive ones are decoded together so double-byte code pages work.
  const decode = rtfDecoder(rtf);
  let bytes = [];
  // \ucN: how many fallback characters follow each \uN (per group, default 1).
  const uc = [1];
  const emit = (s) => {
    if (bytes.length) out += decode(bytes);
    bytes = [];
    out += s;
  };
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === '{') {
      depth++;
      uc.push(uc[uc.length - 1]);
      if (rtf.startsWith('{\\*', i) || /^\{\\(fonttbl|colortbl|stylesheet|info|pict|header|footer)/.test(rtf.slice(i, i + 12))) {
        if (skipDepth < 0) skipDepth = depth;
      }
    } else if (c === '}') {
      if (depth === skipDepth) skipDepth = -1;
      depth--;
      if (uc.length > 1) uc.pop();
    } else if (c === '\\') {
      const m = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(rtf.slice(i));
      if (!m) continue;
      i += m[0].length - 1;
      if (skipDepth >= 0) continue;
      if (m[1] === 'uc' && m[2]) uc[uc.length - 1] = Math.max(0, Number(m[2]));
      else if (m[1] === 'par' || m[1] === 'line') emit('\n');
      else if (m[1] === 'tab') emit('\t');
      else if (m[1] === 'u' && m[2]) {
        emit(String.fromCharCode(Number(m[2]) < 0 ? Number(m[2]) + 65536 : Number(m[2])));
        // Skip the ANSI fallback that follows \uN: \ucN units, each a character or a \'xx escape.
        for (let k = 0; k < uc[uc.length - 1]; k++) {
          if (/^\\'[0-9a-f]{2}/i.test(rtf.slice(i + 1, i + 5))) i += 4;
          else if (rtf[i + 1] && !'\\{}'.includes(rtf[i + 1])) i++;
          else break;
        }
      }
      else if (m[3]) bytes.push(parseInt(m[3], 16));
      else if (m[4] && '{}\\'.includes(m[4])) emit(m[4]);
      else if (m[4] === '~') emit('\u00a0');
      else if (m[4] === '_') emit('\u2011');
    } else if (skipDepth < 0 && c !== '\r' && c !== '\n') {
      emit(c);
    }
  }
  emit('');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

const MAMMOTH_STYLE_MAP = [
  "p[style-name='Title'] => p.pstyle-title:fresh",
  "p[style-name='Subtitle'] => p.pstyle-subtitle:fresh",
  "p[style-name='Quote'] => p.pstyle-quote:fresh",
  "p[style-name='Intense Quote'] => p.pstyle-intense-quote:fresh",
  "p[style-name='Caption'] => p.pstyle-caption:fresh",
  "p[style-name='No Spacing'] => p.pstyle-no-spacing:fresh",
  "r[style-name='Strong'] => strong",
  'u => u',
  'strike => s',
  'highlight => mark',
];

/** Formatting-preserving import; falls back to mammoth for unusual files. */
export async function importDocx(arrayBuffer) {
  try {
    const { readDocx } = await import('./docx-import.js');
    const result = await readDocx(arrayBuffer);
    return { ...result, html: sanitizeHtml(result.html) };
  } catch (err) {
    console.warn('Native .docx import failed, falling back to mammoth', err);
    try {
      return { html: await docxToHtml(arrayBuffer), settings: {}, comments: {}, title: '' };
    } catch (fallbackErr) {
      console.warn('mammoth could not read it either', fallbackErr);
      throw Object.assign(new Error('This file isn’t a Word document, or it’s damaged.'), { code: 'not-docx' });
    }
  }
}

export async function docxToHtml(arrayBuffer) {
  const mammoth = await import('mammoth');
  const lib = mammoth.default || mammoth;
  const result = await lib.convertToHtml(
    { arrayBuffer },
    {
      styleMap: MAMMOTH_STYLE_MAP,
      convertImage: lib.images.imgElement(async (image) => {
        const b64 = await image.read('base64');
        return { src: `data:${image.contentType};base64,${b64}` };
      }),
    },
  );
  return sanitizeHtml(result.value);
}

const stripExtension = (name) => name.replace(/\.[^.]+$/, '') || name;

/** Convert a File into { title, html, settings?, comments? } for a new document. */
export async function importFile(file) {
  const name = file.name || 'Imported document';
  const ext = extOf(name);
  // The file name wins over titles stored inside documents: those are often left over from a template.
  const title = stripExtension(name);
  const kind = OPEN_FORMATS[ext]?.kind || (file.type?.startsWith('text/') && !NOT_SUPPORTED[ext] ? 'txt' : null);
  switch (kind) {
    case 'docx': {
      const r = await importDocx(await file.arrayBuffer());
      return { title, html: preserveSpaces(r.html), settings: r.settings, comments: r.comments };
    }
    case 'odt': {
      const { readOdt } = await import('./odt.js');
      const r = await readOdt(await file.arrayBuffer());
      return { title, html: preserveSpaces(sanitizeHtml(r.html)), settings: r.settings, comments: r.comments };
    }
    case 'doc': {
      const { readDoc } = await import('./doc-import.js');
      const r = await readDoc(await file.arrayBuffer());
      return { title, html: preserveSpaces(sanitizeHtml(r.html)) };
    }
    case 'rtf': {
      const { rtfToHtml } = await import('./rtf.js');
      const r = rtfToHtml(decodeText(await file.arrayBuffer()));
      return { title, html: preserveSpaces(sanitizeHtml(r.html)) };
    }
    case 'md':
      return { title, html: await markdownToHtml(decodeText(await file.arrayBuffer())) };
    case 'html': {
      const raw = decodeText(await file.arrayBuffer(), { html: true });
      const doc = new DOMParser().parseFromString(raw, 'text/html');
      const docTitle = doc.querySelector('title')?.textContent?.trim();
      const ours = doc.querySelector('meta[name="generator"]')?.content === 'LibreWord';
      const html = sanitizeHtml(doc.body.innerHTML);
      return { title: docTitle || title, html: ours ? preserveSpaces(html) : html };
    }
    case 'txt':
      return { title, html: preserveSpaces(textToHtml(decodeText(await file.arrayBuffer()))) };
    default:
      throw Object.assign(new Error(NOT_SUPPORTED[ext] || `LibreWord can’t open .${ext || '?'} files. It opens Word (.docx, .doc), OpenDocument (.odt), RTF, Markdown, HTML and text files.`), { code: 'unsupported' });
  }
}
