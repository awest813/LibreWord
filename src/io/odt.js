/**
 * OpenDocument Text (.odt, .ott and flat .fodt): LibreOffice, Collabora,
 * OnlyOffice, Google Docs and Word all read and write it.
 *
 * readOdt() turns a file into LibreWord HTML (the same flavour the .docx
 * reader produces), plus page settings and comments. writeOdt() turns editor
 * JSON into a package with real paragraph, heading, list and table styles, so
 * the document stays editable as a document, not as a pile of direct formatting.
 */
import JSZip from 'jszip';
import { PAGE_SIZES, pageGeometry } from '../editor/page-setup.js';
import { cssColorToHex, fontSizeToHalfPoints, firstFont, collectImages, xmlSafe } from './shared.js';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};
const XMLNS = Object.entries(NS).filter(([k]) => k !== 'manifest').map(([k, v]) => `xmlns:${k}="${v}"`).join(' ');
const MIME = 'application/vnd.oasis.opendocument.text';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PX_PER = { in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, px: 1 };
/** "2cm", "0.7874in", "12pt"… → CSS px (null if unparseable). */
const toPx = (len) => {
  const m = /^(-?[\d.]+)\s*(in|cm|mm|pt|pc|px)?$/.exec(String(len ?? '').trim());
  return m ? parseFloat(m[1]) * PX_PER[m[2] || 'px'] : null;
};
const inches = (px) => `${(px / 96).toFixed(4)}in`;

// =================================================================== reader

const kids = (el) => (el ? [...el.children] : []);
const kid = (el, ns, name) => kids(el).find((c) => c.namespaceURI === NS[ns] && c.localName === name) || null;
const attr = (el, ns, name) => el?.getAttributeNS(NS[ns], name) ?? null;
const is = (el, ns, name) => el.namespaceURI === NS[ns] && el.localName === name;
const parseXml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('This OpenDocument file is damaged.');
  return doc;
};

/** Paragraph/text/table styles from one or more <office:styles>/<office:automatic-styles>. */
class StyleSheet {
  constructor() {
    this.styles = new Map(); // `${family}:${name}` → { parent, auto, display, outline, props: {paragraph, text, cell, column, table} }
    this.lists = new Map(); // list style name → [{ kind: 'bullet'|'number', start }] per level
    this.fonts = new Map(); // font-face name → family
  }

  add(container, auto) {
    for (const el of kids(container)) {
      if (is(el, 'style', 'style')) {
        const props = {};
        for (const p of kids(el)) {
          const key = { 'paragraph-properties': 'paragraph', 'text-properties': 'text', 'table-cell-properties': 'cell', 'table-column-properties': 'column', 'table-properties': 'table' }[p.localName];
          if (key) props[key] = Object.fromEntries([...p.attributes].map((a) => [`${a.prefix}:${a.localName}`, a.value]));
        }
        this.styles.set(`${attr(el, 'style', 'family')}:${attr(el, 'style', 'name')}`, {
          parent: attr(el, 'style', 'parent-style-name'),
          auto,
          display: attr(el, 'style', 'display-name') || attr(el, 'style', 'name').replace(/_20_/g, ' '),
          outline: Number(attr(el, 'style', 'default-outline-level')) || 0,
          list: attr(el, 'style', 'list-style-name'),
          props,
        });
      } else if (is(el, 'text', 'list-style')) {
        const levels = [];
        for (const lvl of kids(el)) {
          const n = Number(attr(lvl, 'text', 'level')) || 1;
          if (lvl.localName === 'list-level-style-number') {
            const fmt = attr(lvl, 'style', 'num-format');
            levels[n - 1] = { kind: fmt ? 'number' : 'none', start: Number(attr(lvl, 'text', 'start-value')) || 1 };
          } else levels[n - 1] = { kind: lvl.localName === 'list-level-style-bullet' || lvl.localName === 'list-level-style-image' ? 'bullet' : 'none', start: 1 };
        }
        this.lists.set(attr(el, 'style', 'name'), levels);
      }
    }
  }

  addFonts(decls) {
    for (const f of kids(decls)) if (is(f, 'style', 'font-face')) this.fonts.set(attr(f, 'style', 'name'), (attr(f, 'svg', 'font-family') || '').replace(/^['"]|['"]$/g, ''));
  }

  chain(family, name) {
    const out = [];
    const seen = new Set();
    while (name && !seen.has(name)) {
      seen.add(name);
      const s = this.styles.get(`${family}:${name}`);
      if (!s) break;
      out.push(s);
      name = s.parent;
    }
    return out;
  }

  /** Merged properties of a style; `directOnly` stops at the first named (non-automatic) style. */
  props(family, name, kind, { directOnly = false } = {}) {
    const merged = {};
    for (const s of this.chain(family, name).reverse()) {
      if (directOnly && !s.auto) continue;
      Object.assign(merged, s.props[kind] || {});
    }
    return merged;
  }

  /** Display names of the named styles a style is based on, nearest first. */
  names(family, name) {
    return this.chain(family, name).filter((s) => !s.auto).map((s) => s.display.toLowerCase());
  }

  outline(name) {
    for (const s of this.chain('paragraph', name)) if (s.outline) return s.outline;
    return 0;
  }
}

const NAMED_PARAGRAPHS = { title: 'title', subtitle: 'subtitle', quotations: 'quote', quote: 'quote', 'intense quote': 'intense-quote', caption: 'caption', 'no spacing': 'no-spacing' };

/** Inline CSS + wrapping tags for ODF text properties. */
function textMarkup(p, fonts) {
  const tags = [];
  const css = [];
  const weight = p['fo:font-weight'];
  if (weight === 'bold' || Number(weight) >= 600) tags.push('strong');
  if (p['fo:font-style'] === 'italic' || p['fo:font-style'] === 'oblique') tags.push('em');
  if (p['style:text-underline-style'] && p['style:text-underline-style'] !== 'none') tags.push('u');
  if (p['style:text-line-through-style'] && p['style:text-line-through-style'] !== 'none') tags.push('s');
  const pos = p['style:text-position'];
  if (pos && /^(super|[1-9])/.test(pos)) tags.push('sup');
  else if (pos && /^(sub|-)/.test(pos)) tags.push('sub');
  const color = p['fo:color'];
  if (color && /^#[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== '#000000') css.push(`color: ${color.toLowerCase()}`);
  const size = p['fo:font-size'];
  if (size && /pt$/.test(size)) css.push(`font-size: ${parseFloat(size)}pt`);
  const font = (p['style:font-name'] && fonts.get(p['style:font-name'])) || (p['fo:font-family'] || '').replace(/^['"]|['"]$/g, '');
  if (font) css.push(`font-family: ${esc(font.includes(' ') ? `'${font}'` : font)}`);
  const bg = p['fo:background-color'];
  const highlight = bg && /^#[0-9a-f]{6}$/i.test(bg) && bg.toLowerCase() !== '#ffffff' ? bg.toLowerCase() : null;
  return { tags, css, highlight };
}

function wrap(html, { tags, css, highlight }) {
  if (!html) return html;
  let out = html;
  for (const t of [...tags].reverse()) out = `<${t}>${out}</${t}>`;
  if (css.length) out = `<span style="${css.join('; ')}">${out}</span>`;
  if (highlight) out = `<mark data-color="${highlight}" style="background-color: ${highlight}">${out}</mark>`;
  return out;
}

class OdtReader {
  constructor(sheet, files) {
    this.sheet = sheet;
    this.files = files; // path → data URL for embedded pictures
    this.comments = {};
    this.openComments = []; // ids whose annotation range is open
    this.commentNames = new Map(); // office:name → id
    this.pendingComment = null; // unnamed annotation: anchors the next run
    this.notes = [];
    this.listCounters = new Map();
  }

  // ---- inline content
  inline(el, style = null) {
    let out = '';
    const fmt = (html) => {
      let h = style ? wrap(html, style) : html;
      for (const id of this.openComments) h = `<span data-comment-id="${esc(id)}">${h}</span>`;
      if (this.pendingComment && html) {
        h = `<span data-comment-id="${esc(this.pendingComment)}">${h}</span>`;
        this.pendingComment = null;
      }
      return h;
    };
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        // XML source whitespace collapses; real spaces and tabs are <text:s>/<text:tab>.
        const text = node.nodeValue.replace(/[\t\n\r ]+/g, ' ');
        if (text) out += fmt(esc(text));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const n = node;
      if (n.namespaceURI === NS.text) {
        switch (n.localName) {
          case 's': out += fmt(' '.repeat(Math.min(1000, Number(attr(n, 'text', 'c')) || 1))); break;
          case 'tab': out += fmt('\t'); break;
          case 'line-break': out += '<br>'; break;
          case 'span': {
            const name = attr(n, 'text', 'style-name');
            const own = name ? textMarkup(this.sheet.props('text', name, 'text'), this.sheet.fonts) : null;
            out += this.inline(n, merge(style, own));
            break;
          }
          case 'a': {
            const href = attr(n, 'xlink', 'href');
            const inner = this.inline(n, style);
            out += href && !/^\s*javascript:/i.test(href) ? `<a href="${esc(href)}">${inner}</a>` : inner;
            break;
          }
          case 'note': {
            const body = kid(n, 'text', 'note-body');
            this.notes.push((body?.textContent || '').replace(/\s+/g, ' ').trim());
            out += `<sup>${this.notes.length}</sup>`;
            break;
          }
          case 'soft-page-break': case 'bookmark': case 'bookmark-start': case 'bookmark-end':
          case 'reference-mark': case 'reference-mark-start': case 'reference-mark-end':
          case 'change-start': case 'change-end': case 'change': case 'alphabetical-index-mark':
          case 'toc-mark': case 'toc-mark-start': case 'toc-mark-end':
            break;
          default:
            // Fields (page number, date, title…), sequences, ruby: their current text.
            out += this.inline(n, style);
        }
      } else if (n.namespaceURI === NS.office && n.localName === 'annotation') {
        this.annotation(n);
      } else if (n.namespaceURI === NS.office && n.localName === 'annotation-end') {
        const id = this.commentNames.get(attr(n, 'office', 'name'));
        this.openComments = this.openComments.filter((c) => c !== id);
      } else if (n.namespaceURI === NS.draw && n.localName === 'frame') {
        out += this.frame(n);
      } else if (n.namespaceURI === NS.draw && n.localName === 'a') {
        out += this.inline(n, style);
      }
    }
    return out;
  }

  annotation(n) {
    const id = `o${Object.keys(this.comments).length + 1}`;
    const paras = kids(n).filter((c) => is(c, 'text', 'p') || is(c, 'text', 'list'));
    const date = Date.parse(kid(n, 'dc', 'date')?.textContent || '');
    const author = kid(n, 'dc', 'creator')?.textContent?.trim() || 'Author';
    this.comments[id] = {
      id, author, initials: author.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase(),
      date: Number.isFinite(date) ? date : Date.now(),
      text: paras.map((p) => p.textContent).join('\n').trim(),
      replies: [],
      resolved: attr(n, 'loext', 'resolved') === 'true',
    };
    const name = attr(n, 'office', 'name');
    if (name) {
      this.commentNames.set(name, id);
      this.openComments.push(id);
    } else this.pendingComment = id;
  }

  frame(n) {
    const img = kid(n, 'draw', 'image');
    const box = kid(n, 'draw', 'text-box');
    if (box) return ` ${kids(box).map((c) => this.inline(c)).join(' ')} `;
    if (!img) return '';
    let src = null;
    const href = attr(img, 'xlink', 'href');
    if (href) src = this.files[href.replace(/^\.\//, '')] || null;
    const bin = kid(img, 'office', 'binary-data');
    if (!src && bin) {
      const b64 = bin.textContent.replace(/\s+/g, '');
      const mime = b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('R0lG') ? 'image/gif' : null;
      if (mime) src = `data:${mime};base64,${b64}`;
    }
    const alt = (kid(n, 'svg', 'title') || kid(n, 'svg', 'desc'))?.textContent?.trim() || attr(n, 'draw', 'name') || '';
    if (!src) return alt ? `<em>[${esc(alt)}]</em>` : '';
    const w = toPx(attr(n, 'svg', 'width'));
    const h = toPx(attr(n, 'svg', 'height'));
    return `<img src="${esc(src)}" alt="${esc(alt)}"${w ? ` width="${Math.round(w)}"` : ''}${h ? ` height="${Math.round(h)}"` : ''}>`;
  }

  // ---- blocks
  paragraph(el, { inList = false, header = false } = {}) {
    const name = attr(el, 'text', 'style-name');
    const names = this.sheet.names('paragraph', name);
    let level = is(el, 'text', 'h') ? Number(attr(el, 'text', 'outline-level')) || 1 : this.sheet.outline(name);
    // LibreOffice's own "Heading N" styles don't always carry an outline level.
    if (!level) level = Number(names.map((n) => /^heading (\d)$/.exec(n)?.[1]).find(Boolean)) || 0;
    if (names.some((n) => /^(contents heading|index heading)$/.test(n))) level = 0;
    const direct = this.sheet.props('paragraph', name, 'paragraph', { directOnly: true });
    const all = this.sheet.props('paragraph', name, 'paragraph');
    const textStyle = textMarkup(this.sheet.props('paragraph', name, 'text', { directOnly: true }), this.sheet.fonts);
    if (header) textStyle.tags = textStyle.tags.filter((t) => t !== 'strong');
    let content = this.inline(el, textStyle.tags.length || textStyle.css.length || textStyle.highlight ? textStyle : null);
    const before = all['fo:break-before'] === 'page' ? '<div data-page-break></div>' : '';
    const after = all['fo:break-after'] === 'page' ? '<div data-page-break></div>' : '';

    if (names.some((n) => n === 'horizontal line') && !content.replace(/<[^>]+>/g, '').trim()) return { html: `${before}<hr>${after}` };
    if (names.some((n) => n === 'preformatted text' || n === 'source text')) {
      return { code: el.textContent.replace(/[\n\r]+/g, ' '), codeRaw: this.codeText(el), before, after };
    }

    const css = [];
    const align = { start: 'left', left: 'left', center: 'center', end: 'right', right: 'right', justify: 'justify' }[direct['fo:text-align'] || (level ? null : all['fo:text-align'])];
    if (align && align !== 'left') css.push(`text-align: ${align}`);
    if (!inList) {
      const ml = toPx(direct['fo:margin-left']);
      if (ml > 1) css.push(`margin-left: ${Math.round(ml)}px`);
      const ti = toPx(direct['fo:text-indent']);
      if (ti && Math.abs(ti) > 1) css.push(`text-indent: ${Math.round(ti)}px`);
    }
    const lh = direct['fo:line-height'];
    if (lh && /%$/.test(lh) && parseFloat(lh) !== 100) css.push(`line-height: ${(parseFloat(lh) / 100).toFixed(2).replace(/\.?0+$/, '')}`);
    const style = css.length ? ` style="${css.join('; ')}"` : '';
    const named = Object.entries(NAMED_PARAGRAPHS).find(([n]) => names.includes(n))?.[1];
    if (level) return { html: `${before}<h${Math.min(6, level)}${style}>${content}</h${Math.min(6, level)}>${after}` };
    // LibreWord writes checklists as ☐/☒ paragraphs; read them back as checklists.
    const task = !inList && /^(<[^>]+>)*[☐☒]\s/.test(content) ? { checked: content.includes('☒') } : null;
    if (task) content = content.replace(/[☐☒]\s/, '');
    const dataStyle = named && !inList ? ` data-style="${named}"` : '';
    return { html: `${before}<p${dataStyle}${style}>${content}</p>${after}`, task };
  }

  /** Text of a preformatted paragraph with its spaces and tabs. */
  codeText(el) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.nodeValue.replace(/[\n\r]+/g, '');
      else if (node.nodeType === 1) {
        if (is(node, 'text', 's')) out += ' '.repeat(Number(attr(node, 'text', 'c')) || 1);
        else if (is(node, 'text', 'tab')) out += '\t';
        else if (is(node, 'text', 'line-break')) out += '\n';
        else if (!is(node, 'office', 'annotation')) out += this.codeText(node);
      }
    }
    return out;
  }

  list(el, depth = 0, styleName = null) {
    const name = attr(el, 'text', 'style-name') || styleName;
    const levels = this.sheet.lists.get(name) || [];
    const lvl = levels[Math.min(depth, levels.length - 1)] || { kind: 'bullet', start: 1 };
    const tag = lvl.kind === 'number' ? 'ol' : 'ul';
    const key = `${name}:${depth}`;
    const continues = attr(el, 'text', 'continue-numbering') === 'true' || attr(el, 'text', 'continue-list');
    let n = continues && this.listCounters.has(key) ? this.listCounters.get(key) : lvl.start;
    let start = n;
    let html = '';
    let first = true;
    for (const item of kids(el)) {
      if (!is(item, 'text', 'list-item') && !is(item, 'text', 'list-header')) continue;
      const sv = attr(item, 'text', 'start-value');
      if (sv != null && first) start = n = Number(sv) || n;
      first = false;
      let inner = '';
      for (const c of kids(item)) {
        if (is(c, 'text', 'list')) inner += this.list(c, depth + 1, name);
        else if (is(c, 'text', 'p') || is(c, 'text', 'h')) inner += this.paragraph(c, { inList: true }).html;
        else inner += this.blocks([c]);
      }
      html += `<li>${inner || '<p></p>'}</li>`;
      n += 1;
    }
    this.listCounters.set(key, n);
    if (!html) return '';
    return `<${tag}${tag === 'ol' && start !== 1 ? ` start="${start}"` : ''}>${html}</${tag}>`;
  }

  table(el) {
    const widths = [];
    const rows = [];
    const collect = (container, header) => {
      for (const c of kids(container)) {
        if (is(c, 'table', 'table-column')) {
          const w = toPx(this.sheet.props('table-column', attr(c, 'table', 'style-name'), 'column')['style:column-width']);
          const rep = Math.min(64, Number(attr(c, 'table', 'number-columns-repeated')) || 1);
          for (let i = 0; i < rep; i++) widths.push(w || 0);
        } else if (is(c, 'table', 'table-row')) {
          const rep = Math.min(100, Number(attr(c, 'table', 'number-rows-repeated')) || 1);
          for (let i = 0; i < rep; i++) rows.push({ el: c, header });
        } else if (is(c, 'table', 'table-header-rows')) collect(c, true);
        else if (['table-columns', 'table-column-group', 'table-header-columns', 'table-rows', 'table-row-group'].includes(c.localName)) collect(c, header);
      }
    };
    collect(el, false);
    const tableName = attr(el, 'table', 'style-name');
    const breakBefore = this.sheet.props('table', tableName, 'table')['fo:break-before'] === 'page';
    let html = breakBefore ? '<div data-page-break></div><table>' : '<table>';
    for (const { el: row, header } of rows) {
      html += '<tr>';
      let col = 0;
      for (const cell of kids(row)) {
        const span = Math.max(1, Math.min(64, Number(attr(cell, 'table', 'number-columns-spanned')) || 1));
        const reps = Math.min(64, Number(attr(cell, 'table', 'number-columns-repeated')) || 1);
        if (is(cell, 'table', 'covered-table-cell')) {
          col += reps;
          continue;
        }
        if (!is(cell, 'table', 'table-cell')) continue;
        for (let r = 0; r < reps; r++) {
          const rowspan = Math.max(1, Number(attr(cell, 'table', 'number-rows-spanned')) || 1);
          const bg = this.sheet.props('table-cell', attr(cell, 'table', 'style-name'), 'cell')['fo:background-color'];
          const cw = widths.slice(col, col + span);
          const tag = header ? 'th' : 'td';
          html += `<${tag}${span > 1 ? ` colspan="${span}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${cw.length === span && cw.every((w) => w > 0) ? ` colwidth="${cw.map(Math.round).join(',')}"` : ''}${bg && /^#[0-9a-f]{6}$/i.test(bg) ? ` style="background-color: ${bg.toLowerCase()}"` : ''}>${this.blocks(kids(cell), { header }) || '<p></p>'}</${tag}>`;
          col += span;
        }
      }
      html += '</tr>';
    }
    return `${html}</table>`;
  }

  blocks(elements, opts = {}) {
    const out = [];
    const flushCode = (buf) => {
      if (buf.length) out.push({ html: `<pre><code>${esc(buf.join('\n'))}</code></pre>` });
    };
    let code = [];
    for (const el of elements) {
      if (is(el, 'text', 'p') || is(el, 'text', 'h')) {
        const r = this.paragraph(el, opts);
        if (r.code != null) {
          if (r.before) { flushCode(code); code = []; out.push({ html: r.before }); }
          code.push(r.codeRaw);
          if (r.after) { flushCode(code); code = []; out.push({ html: r.after }); }
          continue;
        }
        flushCode(code);
        code = [];
        out.push(r);
        continue;
      }
      flushCode(code);
      code = [];
      if (is(el, 'text', 'list')) out.push({ html: this.list(el) });
      else if (is(el, 'table', 'table')) out.push({ html: this.table(el) });
      else if (is(el, 'text', 'table-of-content')) out.push({ html: '<nav data-toc></nav>' });
      else if (is(el, 'text', 'section') || is(el, 'text', 'index-body') || el.localName.endsWith('-index') || is(el, 'text', 'bibliography')) {
        const body = kid(el, 'text', 'index-body');
        out.push({ html: this.blocks(kids(body || el), opts) });
      }
      // Declarations, tracked-change records, forms… carry no visible text.
    }
    flushCode(code);
    // Consecutive ☐/☒ paragraphs form a checklist.
    let html = '';
    for (let i = 0; i < out.length; i++) {
      if (!out[i].task) {
        html += out[i].html;
        continue;
      }
      html += '<ul data-type="taskList">';
      for (; i < out.length && out[i].task; i++) html += `<li data-type="taskItem" data-checked="${out[i].task.checked}">${out[i].html}</li>`;
      i -= 1;
      html += '</ul>';
    }
    return html;
  }
}

const merge = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return { tags: [...new Set([...a.tags, ...b.tags])], css: [...a.css.filter((c) => !b.css.some((d) => d.split(':')[0] === c.split(':')[0])), ...b.css], highlight: b.highlight || a.highlight };
};

/** Header/footer text and page setup from the master page used by the document. */
function pageSettings(sheet, masterStyles, layouts) {
  const settings = {};
  const master = kids(masterStyles).find((m) => is(m, 'style', 'master-page') && attr(m, 'style', 'name') === 'Standard')
    || kids(masterStyles).find((m) => is(m, 'style', 'master-page'));
  if (!master) return settings;
  const layout = layouts.get(attr(master, 'style', 'page-layout-name'));
  if (layout) {
    let w = toPx(layout['fo:page-width']);
    let h = toPx(layout['fo:page-height']);
    if (w && h) {
      const landscape = layout['style:print-orientation'] === 'landscape' || w > h;
      if (w > h) [w, h] = [h, w];
      let best = 'letter';
      let bestErr = Infinity;
      for (const [key, s] of Object.entries(PAGE_SIZES)) {
        const err = Math.abs(s.width - w) + Math.abs(s.height - h);
        if (err < bestErr) [best, bestErr] = [key, err];
      }
      settings.pageSize = best;
      settings.orientation = landscape ? 'landscape' : 'portrait';
    }
    const m = (k) => Math.max(0, Math.round(toPx(layout[`fo:margin-${k}`]) || 0));
    if (layout['fo:margin-top'] != null) settings.margins = { top: m('top'), right: m('right'), bottom: m('bottom'), left: m('left') };
  }
  const hf = (el) => {
    if (!el) return { text: '', pages: false };
    const pages = el.getElementsByTagNameNS(NS.text, 'page-number').length > 0;
    const clone = el.cloneNode(true);
    for (const tag of ['page-number', 'page-count']) [...clone.getElementsByTagNameNS(NS.text, tag)].forEach((f) => f.remove());
    for (const tag of ['tab', 's', 'line-break']) [...clone.getElementsByTagNameNS(NS.text, tag)].forEach((f) => f.replaceWith(' '));
    let text = clone.textContent.replace(/\s+/g, ' ').trim();
    // "Page of" left behind by the removed fields.
    if (pages) text = text.replace(/(^|\s)(page|seite|página|pagina)(\s+(of|von|de|di))?$/i, '').trim();
    return { text, pages };
  };
  const header = hf(kid(master, 'style', 'header'));
  const footer = hf(kid(master, 'style', 'footer'));
  settings.header = header.text;
  settings.footer = footer.text;
  settings.pageNumbers = header.pages || footer.pages;
  return settings;
}

/** Read an .odt/.ott package or a flat .fodt document. Resolves to { html, title, settings, comments }. */
export async function readOdt(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let content;
  let styles = null;
  let meta = null;
  const files = {};
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = await JSZip.loadAsync(arrayBuffer);
    const mimetype = (await zip.file('mimetype')?.async('string'))?.trim();
    if (mimetype && !/opendocument\.text/.test(mimetype)) {
      const kind = /spreadsheet/.test(mimetype) ? 'a spreadsheet' : /presentation/.test(mimetype) ? 'a presentation' : /graphics|drawing/.test(mimetype) ? 'a drawing' : 'not a text document';
      throw new Error(`This OpenDocument file is ${kind}, not a text document.`);
    }
    const text = await zip.file('content.xml')?.async('string');
    if (!text) throw new Error('This file is not an OpenDocument text document.');
    content = parseXml(text);
    const s = await zip.file('styles.xml')?.async('string');
    if (s) styles = parseXml(s);
    const m = await zip.file('meta.xml')?.async('string');
    if (m) meta = parseXml(m);
    await Promise.all(Object.keys(zip.files).filter((p) => /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(p)).map(async (p) => {
      const ext = p.split('.').pop().toLowerCase();
      const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml' }[ext] || `image/${ext}`;
      files[p] = `data:${mime};base64,${await zip.file(p).async('base64')}`;
    }));
  } else {
    content = parseXml(new TextDecoder().decode(bytes));
    if (!content.documentElement || content.documentElement.namespaceURI !== NS.office) throw new Error('This file is not an OpenDocument text document.');
  }
  const root = content.documentElement;
  const sheet = new StyleSheet();
  const layouts = new Map();
  for (const doc of [styles?.documentElement, root].filter(Boolean)) {
    sheet.addFonts(kid(doc, 'office', 'font-face-decls'));
    sheet.add(kid(doc, 'office', 'styles'), false);
    const autos = kid(doc, 'office', 'automatic-styles');
    sheet.add(autos, true);
    for (const pl of kids(autos)) {
      if (is(pl, 'style', 'page-layout')) {
        const props = kid(pl, 'style', 'page-layout-properties');
        if (props) layouts.set(attr(pl, 'style', 'name'), Object.fromEntries([...props.attributes].map((a) => [`${a.prefix}:${a.localName}`, a.value])));
      }
    }
  }
  const body = kid(kid(root, 'office', 'body'), 'office', 'text');
  if (!body) throw new Error('This OpenDocument file has no text body.');
  const reader = new OdtReader(sheet, files);
  let html = reader.blocks(kids(body));
  if (reader.notes.length) {
    html += '<hr><p><strong>Notes</strong></p>';
    reader.notes.forEach((t, i) => { html += `<p data-style="caption"><sup>${i + 1}</sup> ${esc(t)}</p>`; });
  }
  const masterStyles = kid(styles?.documentElement || root, 'office', 'master-styles');
  const metaRoot = meta?.documentElement || root;
  const title = kid(kid(metaRoot, 'office', 'meta'), 'dc', 'title')?.textContent?.trim() || null;
  return { html: html || '<p></p>', title, settings: pageSettings(sheet, masterStyles, layouts), comments: reader.comments };
}

// =================================================================== writer

/** Automatic styles, de-duplicated by their properties. */
class AutoStyles {
  constructor() {
    this.map = new Map();
    this.xml = [];
    this.counts = {};
  }

  get(family, prefix, parent, props, extraXml = '') {
    const key = `${family}|${parent}|${props}|${extraXml}`;
    if (this.map.has(key)) return this.map.get(key);
    this.counts[prefix] = (this.counts[prefix] || 0) + 1;
    const name = `${prefix}${this.counts[prefix]}`;
    this.map.set(key, name);
    this.xml.push(`<style:style style:name="${name}" style:family="${family}"${parent ? ` style:parent-style-name="${parent}"` : ''}>${props}${extraXml}</style:style>`);
    return name;
  }
}

const NAMED_STYLE = { title: 'Title', subtitle: 'Subtitle', quote: 'Quote', 'intense-quote': 'Intense_20_Quote', caption: 'Caption', 'no-spacing': 'No_20_Spacing' };
const LIST_TYPES = ['bulletList', 'orderedList', 'taskList'];

class OdtWriter {
  constructor(images, geometry, comments) {
    this.images = images; // src → { bytes, type, width, height }
    this.geometry = geometry;
    this.auto = new AutoStyles();
    this.pictures = new Map(); // src → path in the package
    this.textIndex = 0;
    this.comments = comments;
    this.spans = new Map(); // comment id → { first, last, name }
    this.pendingBreak = false;
    this.tables = 0;
    this.frames = 0;
  }

  /** First/last text node (in writing order) of every comment, so ranges open and close in the right places. */
  scanComments(doc) {
    let i = 0;
    const walk = (n) => {
      if (n.type === 'codeBlock') return;
      if (n.type === 'text') {
        for (const m of n.marks || []) {
          if (m.type !== 'comment' || !this.comments[m.attrs?.id]) continue;
          const s = this.spans.get(m.attrs.id) || { first: i, name: `__Annotation__${this.spans.size + 1}` };
          s.last = i;
          this.spans.set(m.attrs.id, s);
        }
        i += 1;
      }
      (n.content || []).forEach(walk);
    };
    walk(doc);
  }

  /** ODF collapses spaces like HTML: any space not between two other characters becomes <text:s/>. */
  text(str) {
    let out = '';
    const parts = String(str).split(/(\t| {2,}|^ | $)/);
    for (const p of parts) {
      if (!p) continue;
      if (p === '\t') out += '<text:tab/>';
      else if (/^ +$/.test(p)) out += p.length === 1 ? '<text:s/>' : `<text:s text:c="${p.length}"/>`;
      else out += esc(p);
    }
    return out;
  }

  textStyle(marks) {
    const p = [];
    let link = null;
    for (const m of marks || []) {
      switch (m.type) {
        case 'bold': p.push('fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"'); break;
        case 'italic': p.push('fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"'); break;
        case 'underline': p.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"'); break;
        case 'strike': p.push('style:text-line-through-style="solid" style:text-line-through-type="single"'); break;
        case 'subscript': p.push('style:text-position="sub 58%"'); break;
        case 'superscript': p.push('style:text-position="super 58%"'); break;
        case 'code': p.push('fo:font-family="\'Liberation Mono\'" style:font-family-generic="modern" style:font-pitch="fixed" fo:background-color="#f2f2f2"'); break;
        case 'highlight': p.push(`fo:background-color="#${(cssColorToHex(m.attrs?.color) || 'FFFF00').toLowerCase()}"`); break;
        case 'textStyle': {
          const color = cssColorToHex(m.attrs?.color);
          if (color) p.push(`fo:color="#${color.toLowerCase()}"`);
          const size = fontSizeToHalfPoints(m.attrs?.fontSize);
          if (size) p.push(`fo:font-size="${size / 2}pt" style:font-size-asian="${size / 2}pt" style:font-size-complex="${size / 2}pt"`);
          const font = firstFont(m.attrs?.fontFamily);
          if (font) p.push(`fo:font-family="${esc(font.includes(' ') ? `'${font}'` : font)}"`);
          break;
        }
        case 'link': link = m.attrs?.href; break;
        default: break;
      }
    }
    return { props: p.length ? `<style:text-properties ${p.join(' ')}/>` : '', link };
  }

  inline(nodes = []) {
    let out = '';
    for (const n of nodes) {
      if (n.type === 'hardBreak') {
        out += '<text:line-break/>';
        continue;
      }
      if (n.type === 'image') {
        out += this.image(n);
        continue;
      }
      if (n.type !== 'text') continue;
      const index = this.textIndex++;
      for (const [id, s] of this.spans) {
        if (s.first !== index) continue;
        const c = this.comments[id];
        const replies = (c.replies || []).map((r) => `<text:p>${esc(`${r.author || 'Author'}: ${r.text || ''}`)}</text:p>`).join('');
        out += `<office:annotation office:name="${s.name}"${c.resolved ? ' loext:resolved="true"' : ''}><dc:creator>${esc(c.author || 'Author')}</dc:creator><dc:date>${new Date(c.date || Date.now()).toISOString().replace(/\.\d+Z$/, '')}</dc:date>${String(c.text || '').split('\n').map((l) => `<text:p>${esc(l)}</text:p>`).join('')}${replies}</office:annotation>`;
      }
      const { props, link } = this.textStyle(n.marks);
      let t = this.text(n.text);
      if (props) t = `<text:span text:style-name="${this.auto.get('text', 'T', null, props)}">${t}</text:span>`;
      if (link) t = `<text:a xlink:type="simple" xlink:href="${esc(link)}" text:style-name="Internet_20_link" text:visited-style-name="Visited_20_Internet_20_Link">${t}</text:a>`;
      out += t;
      for (const s of this.spans.values()) if (s.last === index) out += `<office:annotation-end office:name="${s.name}"/>`;
    }
    return out;
  }

  image(n) {
    const img = this.images.get(n.attrs?.src);
    if (!img) return n.attrs?.alt ? `<text:span>[${esc(n.attrs.alt)}]</text:span>` : '';
    if (!this.pictures.has(n.attrs.src)) this.pictures.set(n.attrs.src, `Pictures/image${this.pictures.size + 1}.${img.type === 'jpg' ? 'jpg' : img.type}`);
    const path = this.pictures.get(n.attrs.src);
    let width = Number(n.attrs?.width) || img.width;
    let height = Number(n.attrs?.height) || Math.round((width / img.width) * img.height);
    const fit = Math.min(1, this.geometry.contentWidth / width, this.geometry.contentHeight / height);
    width *= fit;
    height *= fit;
    const style = this.auto.get('graphic', 'fr', 'Graphics', '<style:graphic-properties style:vertical-pos="top" style:vertical-rel="baseline" style:horizontal-pos="center" style:horizontal-rel="paragraph"/>');
    const mime = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp' }[img.type] || 'image/png';
    const alt = n.attrs?.alt ? `<svg:title>${esc(n.attrs.alt)}</svg:title>` : '';
    return `<draw:frame draw:style-name="${style}" draw:name="Image${++this.frames}" text:anchor-type="as-char" svg:width="${inches(width)}" svg:height="${inches(height)}" draw:z-index="0"><draw:image xlink:href="${path}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="${mime}"/>${alt}</draw:frame>`;
  }

  paragraphStyle(attrs = {}, parent = 'Standard', { level = null } = {}) {
    const p = [];
    if (attrs.textAlign && attrs.textAlign !== 'left') p.push(`fo:text-align="${attrs.textAlign === 'justify' ? 'justify' : attrs.textAlign === 'center' ? 'center' : 'end'}"`);
    if (attrs.indent) p.push(`fo:margin-left="${inches(attrs.indent)}"`);
    if (attrs.firstLineIndent) p.push(`fo:text-indent="${inches(attrs.firstLineIndent)}"`);
    if (attrs.spaceBefore != null) p.push(`fo:margin-top="${attrs.spaceBefore}pt"`);
    if (attrs.spaceAfter != null) p.push(`fo:margin-bottom="${attrs.spaceAfter}pt"`);
    if (attrs.lineHeight) p.push(`fo:line-height="${Math.round(parseFloat(attrs.lineHeight) * 100)}%"`);
    if (this.pendingBreak) {
      p.push('fo:break-before="page"');
      this.pendingBreak = false;
    }
    if (level != null) p.push(`fo:margin-left="${inches(24 + 24 * level)}"`);
    if (!p.length) return parent;
    return this.auto.get('paragraph', 'P', parent, `<style:paragraph-properties ${p.join(' ')}/>`);
  }

  blocks(nodes = [], ctx = {}) {
    return nodes.map((n) => this.block(n, ctx)).join('');
  }

  block(n, ctx) {
    switch (n.type) {
      case 'paragraph': {
        const parent = ctx.parent || NAMED_STYLE[n.attrs?.styleId] || 'Standard';
        const style = this.paragraphStyle(n.attrs, parent, { level: ctx.taskLevel });
        return `<text:p text:style-name="${style}">${ctx.taskPrefix || ''}${this.inline(n.content)}</text:p>`;
      }
      case 'heading': {
        const level = n.attrs?.level || 1;
        const style = this.paragraphStyle(n.attrs, `Heading_20_${level}`);
        return `<text:h text:style-name="${style}" text:outline-level="${level}">${this.inline(n.content)}</text:h>`;
      }
      case 'blockquote':
        return this.blocks(n.content, { ...ctx, parent: 'Quote' });
      case 'codeBlock': {
        const lines = (n.content || []).map((t) => t.text || '').join('').split('\n');
        return lines.map((line) => `<text:p text:style-name="${this.paragraphStyle({}, 'Preformatted_20_Text')}">${this.text(line)}</text:p>`).join('');
      }
      case 'horizontalRule':
        return `<text:p text:style-name="${this.paragraphStyle({}, 'Horizontal_20_Line')}"/>`;
      case 'pageBreak':
        // Carried by the next block as "break before"; two in a row need an empty page.
        if (this.pendingBreak) {
          const empty = `<text:p text:style-name="${this.paragraphStyle({})}"/>`; // takes the pending break
          this.pendingBreak = true;
          return empty;
        }
        this.pendingBreak = true;
        return '';
      case 'tableOfContents':
        return this.toc();
      case 'bulletList':
      case 'orderedList':
        return this.list(n, ctx);
      case 'taskList': {
        const level = ctx.taskLevel != null ? ctx.taskLevel + 1 : 0;
        return (n.content || []).map((item) => {
          const [first, ...rest] = item.content || [];
          const prefix = item.attrs?.checked ? '☒ ' : '☐ ';
          return (first ? this.block(first, { ...ctx, taskPrefix: prefix, taskLevel: level }) : '')
            + this.blocks(rest, { ...ctx, taskPrefix: null, taskLevel: level });
        }).join('');
      }
      case 'table':
        return this.table(n);
      default:
        return n.content ? this.blocks(n.content, ctx) : '';
    }
  }

  list(n, ctx) {
    const flush = this.pendingBreak ? `<text:p text:style-name="${this.paragraphStyle({})}"/>` : '';
    const style = n.type === 'orderedList' ? 'LibreWord_20_Numbering' : 'LibreWord_20_Bullets';
    const start = Number.isInteger(n.attrs?.start) ? n.attrs.start : 1;
    const items = (n.content || []).map((item, i) => {
      const inner = (item.content || []).map((c) => (LIST_TYPES.includes(c.type) && c.type !== 'taskList' ? this.list(c, { ...ctx, inList: true }) : this.block(c, { ...ctx, taskLevel: null, inList: false }))).join('');
      return `<text:list-item${i === 0 && n.type === 'orderedList' && start !== 1 ? ` text:start-value="${start}"` : ''}>${inner || '<text:p/>'}</text:list-item>`;
    }).join('');
    // Every list names its style, so a numbered list nested in a bulleted one stays numbered.
    return `${flush}<text:list text:style-name="${style}">${items}</text:list>`;
  }

  table(n) {
    const rows = n.content || [];
    const index = ++this.tables;
    const name = `Table${index}`;
    // Column widths from the first row (colwidth is per spanned column).
    const widths = [];
    for (const cell of rows[0]?.content || []) {
      const span = cell.attrs?.colspan || 1;
      for (let i = 0; i < span; i++) widths.push(cell.attrs?.colwidth?.[i] || 0);
    }
    const known = widths.filter(Boolean).reduce((a, b) => a + b, 0);
    const unknown = widths.filter((w) => !w).length;
    const total = this.geometry.contentWidth;
    const fill = unknown ? Math.max(36, (total - known) / unknown) : 0;
    const cols = widths.map((w) => w || fill);
    const sum = cols.reduce((a, b) => a + b, 0) || total;
    const breakBefore = this.pendingBreak ? ' fo:break-before="page"' : '';
    this.pendingBreak = false;
    const tableStyle = this.auto.get('table', 'Tbl', null, `<style:table-properties style:width="${inches(sum)}" table:align="left"${breakBefore}/>`);
    const columns = cols.map((w) => `<table:table-column table:style-name="${this.auto.get('table-column', 'Col', null, `<style:table-column-properties style:column-width="${inches(w)}"/>`)}"/>`).join('');
    const border = 'fo:border="0.5pt solid #bfbfbf" fo:padding="0.04in"';
    let headerRows = 0;
    while (headerRows < rows.length - 1 && (rows[headerRows].content || []).length && rows[headerRows].content.every((c) => c.type === 'tableHeader')) headerRows++;
    // Cells covered by row spans from above, per row: column → true.
    const covered = rows.map(() => new Set());
    const rowXml = rows.map((row, ri) => {
      let col = 0;
      let xml = '';
      const skipCovered = () => {
        while (covered[ri].has(col)) {
          xml += '<table:covered-table-cell/>';
          col += 1;
        }
      };
      for (const cell of row.content || []) {
        skipCovered();
        const colspan = cell.attrs?.colspan || 1;
        const rowspan = cell.attrs?.rowspan || 1;
        for (let r = 1; r < rowspan && ri + r < rows.length; r++) for (let c = 0; c < colspan; c++) covered[ri + r].add(col + c);
        const bg = cssColorToHex(cell.attrs?.backgroundColor) || (cell.type === 'tableHeader' ? 'F2F2F2' : null);
        const cellStyle = this.auto.get('table-cell', 'Cell', null, `<style:table-cell-properties ${border}${bg ? ` fo:background-color="#${bg.toLowerCase()}"` : ''}/>`);
        const content = this.blocks(cell.content, { parent: cell.type === 'tableHeader' ? 'Table_20_Heading' : 'Table_20_Contents', inList: false });
        xml += `<table:table-cell table:style-name="${cellStyle}" office:value-type="string"${colspan > 1 ? ` table:number-columns-spanned="${colspan}"` : ''}${rowspan > 1 ? ` table:number-rows-spanned="${rowspan}"` : ''}>${content || '<text:p/>'}</table:table-cell>`;
        for (let c = 1; c < colspan; c++) xml += '<table:covered-table-cell/>';
        col += colspan;
      }
      skipCovered();
      return `<table:table-row>${xml}</table:table-row>`;
    });
    const head = headerRows ? `<table:table-header-rows>${rowXml.slice(0, headerRows).join('')}</table:table-header-rows>` : '';
    return `<table:table table:name="${name}" table:style-name="${tableStyle}">${columns}${head}${rowXml.slice(headerRows).join('')}</table:table>`;
  }

  toc() {
    const entries = this.tocEntries || [];
    const templates = [1, 2, 3].map((l) => `<text:table-of-content-entry-template text:outline-level="${l}" text:style-name="Contents_20_${l}"><text:index-entry-link-start text:style-name="Index_20_Link"/><text:index-entry-text/><text:index-entry-tab-stop style:type="right" style:leader-char="."/><text:index-entry-page-number/><text:index-entry-link-end/></text:table-of-content-entry-template>`).join('');
    const body = entries.map((e) => `<text:p text:style-name="Contents_20_${e.level}">${esc(e.text)}<text:tab/>${e.page ?? ''}</text:p>`).join('');
    return `<text:table-of-content text:name="Table of Contents1" text:protected="true"><text:table-of-content-source text:outline-level="3"><text:index-title-template text:style-name="Contents_20_Heading">Contents</text:index-title-template>${templates}</text:table-of-content-source><text:index-body><text:index-title text:name="Table of Contents1_Head"><text:p text:style-name="Contents_20_Heading">Contents</text:p></text:index-title>${body}</text:index-body></text:table-of-content>`;
  }
}

const listStyle = (name, ordered) => `<text:list-style style:name="${name}" style:display-name="${name.replace(/_20_/g, ' ')}">${Array.from({ length: 10 }, (_, i) => {
  const level = i + 1;
  const pos = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${inches(48 * level)}" fo:text-indent="-0.25in" fo:margin-left="${inches(48 * level)}"/></style:list-level-properties>`;
  return ordered
    ? `<text:list-level-style-number text:level="${level}" style:num-suffix="." style:num-format="${['1', 'a', 'i'][i % 3]}">${pos}</text:list-level-style-number>`
    : `<text:list-level-style-bullet text:level="${level}" text:bullet-char="${['•', '◦', '▪'][i % 3]}">${pos}</text:list-level-style-bullet>`;
}).join('')}</text:list-style>`;

function stylesXml(settings, geometry) {
  const heading = (n, size, color, extra = '') => `<style:style style:name="Heading_20_${n}" style:display-name="Heading ${n}" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Standard" style:default-outline-level="${n}" style:class="text"><style:paragraph-properties fo:margin-top="${n === 1 ? 12 : 2}pt" fo:margin-bottom="0pt" fo:keep-with-next="always"/><style:text-properties fo:font-size="${size}pt" fo:color="${color}"${extra}/></style:style>`;
  const pageNum = settings.pageNumbers ? `${settings.footer ? '<text:tab/>' : ''}Page <text:page-number text:select-page="current">1</text:page-number> of <text:page-count>1</text:page-count>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${XMLNS} office:version="1.3">
<office:styles>
<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="8pt" fo:line-height="115%"/><style:text-properties style:font-name="Calibri" fo:font-family="Calibri, Carlito" fo:font-size="11pt" style:font-size-asian="11pt" style:font-size-complex="11pt" fo:language="en" fo:country="US"/></style:default-style>
<style:style style:name="Standard" style:family="paragraph" style:class="text"/>
<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Standard" style:class="text"><style:text-properties fo:font-family="'Calibri Light', Carlito" fo:color="#2f5496"/></style:style>
${heading(1, 16, '#2f5496')}${heading(2, 13, '#2f5496')}${heading(3, 12, '#1f3763')}${heading(4, 11, '#2f5496', ' fo:font-style="italic"')}${heading(5, 11, '#2f5496')}${heading(6, 11, '#1f3763')}
<style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard" style:class="chapter"><style:paragraph-properties fo:margin-bottom="4pt" fo:line-height="100%"/><style:text-properties fo:font-family="'Calibri Light', Carlito" fo:font-size="28pt"/></style:style>
<style:style style:name="Subtitle" style:family="paragraph" style:parent-style-name="Standard" style:class="chapter"><style:text-properties fo:color="#5a5a5a" fo:letter-spacing="0.0104in"/></style:style>
<style:style style:name="Quote" style:display-name="Quote" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-left="0.6in" fo:margin-right="0.6in" fo:margin-top="10pt" fo:text-align="center"/><style:text-properties fo:font-style="italic" fo:color="#404040"/></style:style>
<style:style style:name="Intense_20_Quote" style:display-name="Intense Quote" style:family="paragraph" style:parent-style-name="Quote"><style:paragraph-properties fo:padding="0.07in" fo:border-top="0.5pt solid #2f5496" fo:border-bottom="0.5pt solid #2f5496" fo:border-left="none" fo:border-right="none"/><style:text-properties fo:color="#2f5496"/></style:style>
<style:style style:name="Caption" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:text-properties fo:font-size="9pt" fo:font-style="italic" fo:color="#44546a"/></style:style>
<style:style style:name="No_20_Spacing" style:display-name="No Spacing" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:margin-bottom="0pt" fo:line-height="100%"/></style:style>
<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-top="0pt" fo:margin-bottom="0pt" fo:line-height="100%" fo:background-color="#f5f5f5"/><style:text-properties fo:font-family="'Liberation Mono', Consolas" style:font-family-generic="modern" style:font-pitch="fixed" fo:font-size="10pt"/></style:style>
<style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-bottom="8pt" fo:border-bottom="0.75pt solid #a6a6a6" fo:padding-bottom="0in" fo:border-top="none" fo:border-left="none" fo:border-right="none"/><style:text-properties fo:font-size="6pt"/></style:style>
<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:margin-bottom="0pt"/></style:style>
<style:style style:name="Table_20_Heading" style:display-name="Table Heading" style:family="paragraph" style:parent-style-name="Table_20_Contents" style:class="extra"><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="Header" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:text-align="end" fo:margin-bottom="0pt"/><style:text-properties fo:font-size="9pt" fo:color="#595959"/></style:style>
<style:style style:name="Footer" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0pt"/><style:text-properties fo:font-size="9pt" fo:color="#595959"/></style:style>
<style:style style:name="Contents_20_Heading" style:display-name="Contents Heading" style:family="paragraph" style:parent-style-name="Heading" style:class="index"><style:text-properties fo:font-size="16pt"/></style:style>
${[1, 2, 3].map((l) => `<style:style style:name="Contents_20_${l}" style:display-name="Contents ${l}" style:family="paragraph" style:parent-style-name="Standard" style:class="index"><style:paragraph-properties fo:margin-left="${inches(20 * (l - 1))}"><style:tab-stops><style:tab-stop style:position="${inches(geometry.contentWidth - 20 * (l - 1))}" style:type="right" style:leader-style="dotted" style:leader-text="."/></style:tab-stops></style:paragraph-properties></style:style>`).join('')}
<style:style style:name="Internet_20_link" style:display-name="Internet link" style:family="text"><style:text-properties fo:color="#0563c1" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="Visited_20_Internet_20_Link" style:display-name="Visited Internet Link" style:family="text"><style:text-properties fo:color="#954f72" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>
<style:style style:name="Index_20_Link" style:display-name="Index Link" style:family="text"/>
<style:style style:name="Graphics" style:family="graphic"><style:graphic-properties text:anchor-type="as-char" svg:y="0in" style:vertical-pos="top" style:vertical-rel="baseline"/></style:style>
${listStyle('LibreWord_20_Bullets', false)}
${listStyle('LibreWord_20_Numbering', true)}
</office:styles>
<office:automatic-styles>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="${inches(geometry.width)}" fo:page-height="${inches(geometry.height)}" style:print-orientation="${settings.orientation === 'landscape' ? 'landscape' : 'portrait'}" fo:margin-top="${inches(settings.margins.top)}" fo:margin-bottom="${inches(settings.margins.bottom)}" fo:margin-left="${inches(settings.margins.left)}" fo:margin-right="${inches(settings.margins.right)}" style:num-format="1" style:writing-mode="lr-tb"/>
<style:header-style><style:header-footer-properties fo:min-height="0in" fo:margin-bottom="0.1in"/></style:header-style>
<style:footer-style><style:header-footer-properties fo:min-height="0in" fo:margin-top="0.1in"/></style:footer-style></style:page-layout>
</office:automatic-styles>
<office:master-styles>
<style:master-page style:name="Standard" style:page-layout-name="pm1">${settings.header ? `<style:header><text:p text:style-name="Header">${esc(settings.header)}</text:p></style:header>` : ''}${settings.footer || pageNum ? `<style:footer><text:p text:style-name="Footer">${esc(settings.footer || '')}${pageNum}</text:p></style:footer>` : ''}</style:master-page>
</office:master-styles>
</office:document-styles>`;
}

/**
 * Build an .odt package. `meta`: { title, comments, tocPages } as for the
 * .docx writer. Resolves to a Uint8Array (or a Blob with `{ blob: true }`).
 */
export async function writeOdt(json, settings, { title = 'Document', comments = {}, tocPages = [], blob = false } = {}) {
  json = xmlSafe(json);
  settings = xmlSafe(settings);
  comments = xmlSafe(comments);
  title = xmlSafe(title);
  const geometry = pageGeometry(settings);
  const images = await collectImages(json);
  const w = new OdtWriter(images, geometry, comments);
  w.scanComments(json);
  const headings = [];
  // The same headings, in the same order, as the editor's contents (and tocPages): none inside tables, none empty.
  const walk = (n) => {
    if (n.type === 'heading') {
      const text = (n.content || []).map((c) => c.text || '').join('').trim();
      if (text && (n.attrs?.level || 1) <= 3) headings.push({ level: n.attrs?.level || 1, text });
      return;
    }
    if (n.type !== 'table') (n.content || []).forEach(walk);
  };
  walk(json);
  w.tocEntries = headings.map((h, i) => ({ ...h, page: tocPages[i] ?? null }));
  let body = w.blocks(json.content || []);
  if (w.pendingBreak) body += `<text:p text:style-name="${w.paragraphStyle({})}"/>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${XMLNS} office:version="1.3">
<office:font-face-decls><style:font-face style:name="Calibri" svg:font-family="Calibri" style:font-family-generic="swiss"/></office:font-face-decls>
<office:automatic-styles>${w.auto.xml.join('')}</office:automatic-styles>
<office:body><office:text><text:sequence-decls><text:sequence-decl text:display-outline-level="0" text:name="Illustration"/><text:sequence-decl text:display-outline-level="0" text:name="Table"/></text:sequence-decls>${body || '<text:p/>'}</office:text></office:body>
</office:document-content>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  const meta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta ${XMLNS} office:version="1.3"><office:meta><meta:generator>LibreWord</meta:generator><dc:title>${esc(title)}</dc:title><dc:date>${now}</dc:date></office:meta></office:document-meta>`;
  const zip = new JSZip();
  // The mimetype entry must come first and be stored uncompressed.
  zip.file('mimetype', MIME, { compression: 'STORE' });
  zip.file('content.xml', content);
  zip.file('styles.xml', stylesXml(settings, geometry));
  zip.file('meta.xml', meta);
  const pictures = [];
  for (const [src, path] of w.pictures) {
    zip.file(path, images.get(src).bytes);
    pictures.push(`<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${{ jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }[images.get(src).type] || 'image/png'}"/>`);
  }
  zip.file('META-INF/manifest.xml', `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIME}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>${pictures.join('')}</manifest:manifest>`);
  return zip.generateAsync({ type: blob ? 'blob' : 'uint8array', mimeType: MIME, compression: 'DEFLATE' });
}
