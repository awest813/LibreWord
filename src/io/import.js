import DOMPurify from 'dompurify';

export const IMPORT_ACCEPT = '.docx,.md,.markdown,.txt,.html,.htm,.rtf';

export function sanitizeHtml(html) {
  return DOMPurify.sanitize(String(html || ''), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea', 'meta', 'link'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick'],
    ADD_ATTR: ['colwidth'], // table column widths (prosemirror-tables)
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|data:image\/(?:png|gif|jpe?g|webp|svg\+xml|bmp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
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
  const emit = (s) => {
    if (bytes.length) out += decode(bytes);
    bytes = [];
    out += s;
  };
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === '{') {
      depth++;
      if (rtf.startsWith('{\\*', i) || /^\{\\(fonttbl|colortbl|stylesheet|info|pict|header|footer)/.test(rtf.slice(i, i + 12))) {
        if (skipDepth < 0) skipDepth = depth;
      }
    } else if (c === '}') {
      if (depth === skipDepth) skipDepth = -1;
      depth--;
    } else if (c === '\\') {
      const m = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(rtf.slice(i));
      if (!m) continue;
      i += m[0].length - 1;
      if (skipDepth >= 0) continue;
      if (m[1] === 'par' || m[1] === 'line') emit('\n');
      else if (m[1] === 'tab') emit('\t');
      else if (m[1] === 'u' && m[2]) {
        emit(String.fromCharCode(Number(m[2]) < 0 ? Number(m[2]) + 65536 : Number(m[2])));
        // Skip the ANSI fallback that follows \uN (\uc1 default): a character or a \'xx escape.
        if (/^\\'[0-9a-f]{2}/i.test(rtf.slice(i + 1, i + 5))) i += 4;
        else if (rtf[i + 1] && !'\\{}'.includes(rtf[i + 1])) i++;
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
    return { html: await docxToHtml(arrayBuffer), settings: {}, comments: {}, title: '' };
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
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  const title = stripExtension(name);
  if (ext === 'docx') {
    const r = await importDocx(await file.arrayBuffer());
    // The file name wins: Word's stored title is often left over from a template.
    return { title, html: r.html, settings: r.settings, comments: r.comments };
  }
  if (ext === 'md' || ext === 'markdown') return { title, html: await markdownToHtml(await file.text()) };
  if (ext === 'html' || ext === 'htm') {
    const raw = await file.text();
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const docTitle = doc.querySelector('title')?.textContent?.trim();
    return { title: docTitle || title, html: sanitizeHtml(doc.body.innerHTML) };
  }
  if (ext === 'rtf') return { title, html: textToHtml(rtfToText(await file.text())) };
  if (ext === 'txt' || file.type.startsWith('text/')) return { title, html: textToHtml(await file.text()) };
  if (ext === 'doc') throw new Error('Legacy .doc files are not supported. Save the file as .docx in Word and try again.');
  throw new Error(`Unsupported file type: .${ext || '?'}`);
}
