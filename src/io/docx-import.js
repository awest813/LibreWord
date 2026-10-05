/**
 * Native .docx reader: converts WordprocessingML into LibreWord HTML plus
 * page settings and comments, keeping the formatting Word users expect
 * (fonts, sizes, colours, alignment, spacing, indents, lists, tables,
 * images, links, page/section setup, headers/footers, comments).
 */
import JSZip from 'jszip';
import { PAGE_SIZES, TWIPS_PER_PX } from '../editor/page-setup.js';
import { escapeHtml } from '../ui/dom.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W_STRICT = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const R_STRICT = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const EMU_PER_PX = 9525;

const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};
const PARAGRAPH_STYLE_IDS = { title: 'title', subtitle: 'subtitle', quote: 'quote', 'intense quote': 'intense-quote', caption: 'caption', 'no spacing': 'no-spacing' };

// ---------------------------------------------------------------- XML helpers
const esc = escapeHtml;
// Marks a hard page break inside paragraph HTML so the paragraph can be split there.
const PAGE_BREAK = '\u0000PB\u0000';
const kids = (el, name) => (el ? [...el.children].filter((c) => !name || c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
// Transitional and Strict OOXML use different namespace URIs for the same attributes.
const wattr = (el, name) => (el ? el.getAttributeNS(W, name) ?? el.getAttributeNS(W_STRICT, name) ?? el.getAttribute(`w:${name}`) : null);
const rid = (el, name) => (el ? el.getAttributeNS(R, name) ?? el.getAttributeNS(R_STRICT, name) ?? el.getAttribute(`r:${name}`) : null);
const val = (el) => wattr(el, 'val');
const num = (v) => (v == null || v === '' ? null : Number(v));
/** Twips from a measure: plain numbers are twips; Strict OOXML may add units ("72pt"). */
const twips = (v) => {
  if (v == null || v === '') return null;
  const m = /^(-?[\d.]+)\s*(pt|in|cm|mm|pc|pi)?$/i.exec(String(v).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return { pt: n * 20, in: n * 1440, cm: (n * 1440) / 2.54, mm: (n * 1440) / 25.4, pc: n * 240, pi: n * 240 }[m[2]?.toLowerCase()] ?? n;
};
/** Half-points from a font size ("22" or Strict's "11pt"). */
const halfPoints = (v) => {
  if (v == null || v === '') return null;
  return /pt$/i.test(v) ? parseFloat(v) * 2 : Number(v);
};
/** OOXML on/off properties: <w:b/> is on, <w:b w:val="0"/> or "false" is off. */
const onOff = (el) => (el ? !['0', 'false', 'off'].includes(String(val(el)).toLowerCase()) : undefined);
const parseXml = (text) => (text ? new DOMParser().parseFromString(text, 'application/xml') : null);
const deep = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
/** Children named `name`, looking through content controls and custom XML that wrap table rows/cells. */
const unwrapped = (el, name) => kids(el).flatMap((c) => {
  if (c.localName === name) return [c];
  if (c.localName === 'sdt') return unwrapped(kid(c, 'sdtContent'), name);
  return c.localName === 'customXml' ? unwrapped(c, name) : [];
});

async function readText(zip, path) {
  const f = zip.file(path);
  return f ? f.async('string') : null;
}

function readRels(xml) {
  const rels = new Map();
  if (!xml) return rels;
  for (const r of parseXml(xml).getElementsByTagName('Relationship')) {
    rels.set(r.getAttribute('Id'), { target: r.getAttribute('Target'), external: r.getAttribute('TargetMode') === 'External', type: r.getAttribute('Type') || '' });
  }
  return rels;
}

const resolvePath = (base, target) => {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
};

// ---------------------------------------------------------------- properties
function readRunProps(rPr) {
  if (!rPr) return {};
  const p = {};
  const b = onOff(kid(rPr, 'b'));
  if (b !== undefined) p.bold = b;
  const i = onOff(kid(rPr, 'i'));
  if (i !== undefined) p.italic = i;
  const u = kid(rPr, 'u');
  if (u) p.underline = val(u) !== 'none';
  // Read both so an explicit <w:strike w:val="0"/> can switch off a style's strikethrough.
  const strike = onOff(kid(rPr, 'strike'));
  const dstrike = onOff(kid(rPr, 'dstrike'));
  if (strike !== undefined || dstrike !== undefined) p.strike = Boolean(strike || dstrike);
  const caps = onOff(kid(rPr, 'caps'));
  if (caps !== undefined) p.caps = caps;
  const va = val(kid(rPr, 'vertAlign'));
  if (va === 'superscript') p.sup = true;
  if (va === 'subscript') p.sub = true;
  const color = val(kid(rPr, 'color'));
  if (color && color !== 'auto' && /^[0-9a-f]{6}$/i.test(color)) p.color = `#${color.toLowerCase()}`;
  const sz = halfPoints(val(kid(rPr, 'sz')));
  if (sz) p.size = sz / 2;
  const fonts = kid(rPr, 'rFonts');
  const font = fonts && (wattr(fonts, 'ascii') || wattr(fonts, 'hAnsi') || wattr(fonts, 'cs'));
  if (font) p.font = font;
  const hl = val(kid(rPr, 'highlight'));
  if (hl && hl !== 'none' && HIGHLIGHT[hl]) p.highlight = HIGHLIGHT[hl];
  const shd = kid(rPr, 'shd');
  const fill = shd && wattr(shd, 'fill');
  if (!p.highlight && fill && fill !== 'auto' && /^[0-9a-f]{6}$/i.test(fill) && fill.toUpperCase() !== 'FFFFFF') p.highlight = `#${fill.toLowerCase()}`;
  const vanish = onOff(kid(rPr, 'vanish'));
  if (vanish) p.hidden = true;
  return p;
}

function readParaProps(pPr) {
  if (!pPr) return {};
  const p = {};
  const style = val(kid(pPr, 'pStyle'));
  if (style) p.styleId = style;
  const jc = val(kid(pPr, 'jc'));
  if (jc) p.align = { both: 'justify', distribute: 'justify', center: 'center', right: 'right', end: 'right', left: 'left', start: 'left' }[jc];
  const sp = kid(pPr, 'spacing');
  if (sp) {
    const before = twips(wattr(sp, 'before'));
    const after = twips(wattr(sp, 'after'));
    if (before != null) p.before = before / 20;
    if (after != null) p.after = after / 20;
    const line = twips(wattr(sp, 'line'));
    const rule = wattr(sp, 'lineRule') || 'auto';
    if (line && rule === 'auto') p.lineHeight = Math.round((line / 240) * 100) / 100;
  }
  const ind = kid(pPr, 'ind');
  if (ind) {
    const left = twips(wattr(ind, 'left') ?? wattr(ind, 'start'));
    if (left != null) p.indent = left / TWIPS_PER_PX;
    const first = twips(wattr(ind, 'firstLine'));
    const hanging = twips(wattr(ind, 'hanging'));
    if (first != null) p.firstLine = first / TWIPS_PER_PX;
    if (hanging != null) p.firstLine = -hanging / TWIPS_PER_PX;
  }
  const numPr = kid(pPr, 'numPr');
  if (numPr) {
    // Either may be inherited from the paragraph style, so only set what's present.
    const numId = val(kid(numPr, 'numId'));
    const ilvl = num(val(kid(numPr, 'ilvl')));
    if (numId != null) p.numId = numId;
    if (ilvl != null) p.ilvl = ilvl;
  }
  if (onOff(kid(pPr, 'pageBreakBefore'))) p.pageBreakBefore = true;
  return p;
}

function readStyles(xml) {
  const styles = new Map();
  let defaults = { run: {}, para: {} };
  if (!xml) return { styles, defaults, resolve: () => ({ para: {}, run: {}, name: '' }) };
  const doc = parseXml(xml);
  const dd = deep(doc, 'docDefaults')[0];
  if (dd) {
    defaults = {
      run: readRunProps(kid(kid(dd, 'rPrDefault'), 'rPr')),
      para: readParaProps(kid(kid(dd, 'pPrDefault'), 'pPr')),
    };
  }
  for (const s of deep(doc, 'style')) {
    const id = wattr(s, 'styleId');
    styles.set(id, {
      id,
      type: wattr(s, 'type'),
      name: (val(kid(s, 'name')) || id || '').toLowerCase(),
      basedOn: val(kid(s, 'basedOn')),
      para: readParaProps(kid(s, 'pPr')),
      run: readRunProps(kid(s, 'rPr')),
      isDefault: wattr(s, 'default') === '1',
    });
  }
  const cache = new Map();
  const resolve = (id, depth = 0) => {
    if (!id || !styles.has(id) || depth > 20) return { para: {}, run: {}, name: '' };
    if (cache.has(id)) return cache.get(id);
    const s = styles.get(id);
    const base = resolve(s.basedOn, depth + 1);
    const out = { para: { ...base.para, ...s.para }, run: { ...base.run, ...s.run }, name: s.name, ancestry: [s.name, ...(base.ancestry || [])] };
    cache.set(id, out);
    return out;
  };
  const defaultPara = [...styles.values()].find((s) => s.type === 'paragraph' && s.isDefault)?.id;
  return { styles, defaults, resolve, defaultPara };
}

function readNumbering(xml) {
  const nums = new Map();
  if (!xml) return { kind: () => 'ul', start: () => 1, exists: () => false };
  const doc = parseXml(xml);
  const abstract = new Map();
  for (const a of deep(doc, 'abstractNum')) {
    const levels = new Map();
    for (const l of kids(a, 'lvl')) levels.set(num(wattr(l, 'ilvl')) || 0, { fmt: val(kid(l, 'numFmt')) || 'bullet', start: num(val(kid(l, 'start'))) ?? 1 });
    abstract.set(wattr(a, 'abstractNumId'), levels);
  }
  const overrides = new Map();
  for (const n of deep(doc, 'num')) {
    const levels = abstract.get(val(kid(n, 'abstractNumId')));
    if (!levels) continue;
    const id = wattr(n, 'numId');
    nums.set(id, levels);
    for (const o of kids(n, 'lvlOverride')) {
      const start = num(val(kid(o, 'startOverride')));
      if (start != null) overrides.set(`${id}:${num(wattr(o, 'ilvl')) || 0}`, start);
    }
  }
  const level = (numId, ilvl) => nums.get(numId)?.get(ilvl) || nums.get(numId)?.get(0);
  return {
    kind: (numId, ilvl) => {
      const fmt = level(numId, ilvl)?.fmt || 'bullet';
      return fmt === 'bullet' || fmt === 'none' ? 'ul' : 'ol';
    },
    start: (numId, ilvl) => overrides.get(`${numId}:${ilvl}`) ?? level(numId, ilvl)?.start ?? 1,
    exists: (numId) => nums.has(numId) && numId !== '0',
  };
}

function pageSettings(sectPr) {
  if (!sectPr) return null;
  const pgSz = kid(sectPr, 'pgSz');
  const pgMar = kid(sectPr, 'pgMar');
  const settings = {};
  if (pgSz && wattr(pgSz, 'w')) {
    let w = twips(wattr(pgSz, 'w')) / TWIPS_PER_PX;
    let ht = twips(wattr(pgSz, 'h')) / TWIPS_PER_PX;
    const landscape = wattr(pgSz, 'orient') === 'landscape' || w > ht;
    if (w > ht) [w, ht] = [ht, w];
    let best = 'letter';
    let bestErr = Infinity;
    for (const [key, s] of Object.entries(PAGE_SIZES)) {
      const err = Math.abs(s.width - w) + Math.abs(s.height - ht);
      if (err < bestErr) {
        bestErr = err;
        best = key;
      }
    }
    settings.pageSize = best;
    settings.orientation = landscape ? 'landscape' : 'portrait';
  }
  if (pgMar && wattr(pgMar, 'top') != null) {
    const m = (k) => Math.max(0, Math.round(Math.abs(twips(wattr(pgMar, k)) || 0) / TWIPS_PER_PX));
    settings.margins = { top: m('top'), right: m('right'), bottom: m('bottom'), left: m('left') };
  }
  return settings;
}

// ---------------------------------------------------------------- converter
class DocxReader {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.openComments = [];
    this.inToc = false;
    this.tocEmitted = false;
    this.fieldStack = [];
    this.pendingBlocks = [];
    this.noteList = []; // footnote/endnote texts in reference order
    this.listCounters = new Map(); // "numId:level" → next number, so lists continue across interruptions
  }

  /** Effective run formatting → HTML-wrapped text. */
  wrapRun(html, props, { inHeading }) {
    if (!html) return '';
    let out = html;
    if (props.caps) out = out.toUpperCase();
    if (props.sup) out = `<sup>${out}</sup>`;
    if (props.sub) out = `<sub>${out}</sub>`;
    if (props.strike) out = `<s>${out}</s>`;
    if (props.underline) out = `<u>${out}</u>`;
    if (props.italic) out = `<em>${out}</em>`;
    if (props.bold && !inHeading) out = `<strong>${out}</strong>`;
    const css = [];
    if (props.color) css.push(`color: ${props.color}`);
    if (props.size && Math.abs(props.size - 11) > 0.01) css.push(`font-size: ${props.size}pt`);
    const font = props.font?.replace(/['"\\;{}<>]/g, '').trim();
    if (font && !/^(calibri|\+minor|\+major)/i.test(font)) css.push(`font-family: ${esc(font.includes(' ') ? `'${font}'` : font)}`);
    if (css.length) out = `<span style="${css.join('; ')}">${out}</span>`;
    if (props.highlight) out = `<mark data-color="${props.highlight}" style="background-color: ${props.highlight}">${out}</mark>`;
    for (const id of this.openComments) out = `<span data-comment-id="${esc(id)}">${out}</span>`;
    return out;
  }

  runProps(r, base) {
    const rPr = kid(r, 'rPr');
    const charStyle = rPr && val(kid(rPr, 'rStyle'));
    const resolved = charStyle ? this.styleSheet.resolve(charStyle) : null;
    // LibreWord styles links itself; Word's Hyperlink character style would just duplicate that.
    const fromStyle = resolved && !/hyperlink/.test(resolved.name) ? resolved.run : {};
    return { ...base, ...fromStyle, ...readRunProps(rPr) };
  }

  image(el) {
    const blip = deep(el, 'blip')[0];
    const imageData = deep(el, 'imagedata')[0];
    const id = blip ? rid(blip, 'embed') : rid(imageData, 'id');
    const src = id && this.images.get(id);
    if (!src) return '';
    const extent = deep(el, 'extent')[0];
    const w = extent ? Math.round(num(extent.getAttribute('cx')) / EMU_PER_PX) : null;
    const h = extent ? Math.round(num(extent.getAttribute('cy')) / EMU_PER_PX) : null;
    const docPr = deep(el, 'docPr')[0];
    const alt = docPr?.getAttribute('descr') || docPr?.getAttribute('title') || '';
    return `<img src="${src}"${alt ? ` alt="${esc(alt)}"` : ''}${w ? ` width="${w}"` : ''}${h ? ` height="${h}"` : ''}>`;
  }

  /** Inline content of a paragraph (runs, links, fields, comments…). */
  inline(container, base, opts) {
    let out = '';
    for (const node of kids(container)) {
      switch (node.localName) {
        case 'r':
          out += this.run(node, base, opts);
          break;
        case 'hyperlink': {
          const relId = rid(node, 'id');
          const rel = relId && this.rels.get(relId);
          const anchor = wattr(node, 'anchor');
          const href = rel?.external ? rel.target : anchor ? `#${anchor}` : null;
          const inner = this.inline(node, base, opts);
          out += href && /^(https?:|mailto:|tel:|#)/i.test(href) ? `<a href="${esc(href)}">${inner}</a>` : inner;
          break;
        }
        case 'fldSimple': {
          const instr = (wattr(node, 'instr') || '').trim();
          if (/^TOC\b/i.test(instr)) this.tocFound = true;
          else out += this.inline(node, base, opts);
          break;
        }
        case 'commentRangeStart': {
          const id = this.commentIds.get(wattr(node, 'id'));
          if (id && !this.openComments.includes(id)) this.openComments.push(id);
          break;
        }
        case 'commentRangeEnd': {
          const id = this.commentIds.get(wattr(node, 'id'));
          this.openComments = this.openComments.filter((c) => c !== id);
          break;
        }
        case 'ins':
        case 'moveTo':
        case 'smartTag':
        case 'customXml':
        case 'sdtContent':
        case 'bdo':
        case 'dir':
          out += this.inline(node, base, opts);
          break;
        case 'sdt':
          out += this.inline(kid(node, 'sdtContent'), base, opts);
          break;
        default:
          break; // del, moveFrom, bookmarks, proofErr, permStart… carry no visible content
      }
    }
    return out;
  }

  run(r, base, opts) {
    const props = this.runProps(r, base);
    if (props.hidden) return '';
    let out = '';
    let text = '';
    const flush = () => {
      if (text) out += this.wrapRun(esc(text), props, opts);
      text = '';
    };
    // Markup-compatibility blocks wrap modern content (text boxes, shapes) with a fallback.
    const children = kids(r).flatMap((c) => (c.localName === 'AlternateContent' ? kids(kid(c, 'Choice') || kid(c, 'Fallback')) : [c]));
    for (const c of children) {
      switch (c.localName) {
        case 't':
          if (!this.inToc) text += c.textContent;
          break;
        case 'tab':
          if (!this.inToc) text += '\t';
          break;
        case 'noBreakHyphen':
          text += '‑';
          break;
        case 'sym': {
          const code = parseInt(wattr(c, 'char') || '', 16);
          if (code) text += String.fromCharCode(code >= 0xf000 ? code - 0xf000 : code);
          break;
        }
        case 'br':
        case 'cr':
          flush();
          if (wattr(c, 'type') === 'page') out += PAGE_BREAK;
          else if (!this.inToc) out += '<br>';
          break;
        case 'lastRenderedPageBreak':
          break;
        case 'drawing':
        case 'pict':
        case 'object': {
          flush();
          if (this.inToc) break;
          // Text boxes float in Word; keep their text as paragraphs after this one.
          const boxes = deep(c, 'txbxContent');
          if (boxes.length) boxes.forEach((b) => this.pendingBlocks.push({ html: this.blocks(kids(b)) }));
          else out += this.image(c);
          break;
        }
        case 'footnoteReference':
        case 'endnoteReference': {
          flush();
          const kind = c.localName === 'footnoteReference' ? 'footnotes' : 'endnotes';
          const note = this.notes[kind].get(wattr(c, 'id'));
          if (note != null) {
            this.noteList.push(note);
            const n = this.noteList.length;
            out += `<sup>${n}</sup>`;
          }
          break;
        }
        case 'fldChar': {
          const type = wattr(c, 'fldCharType');
          if (type === 'begin') this.fieldStack.push({ instr: '', toc: false });
          else if (type === 'separate') {
            const f = this.fieldStack[this.fieldStack.length - 1];
            if (f && /^\s*TOC\b/i.test(f.instr)) {
              f.toc = true;
              this.tocFound = true;
              this.inToc = true;
            }
          } else if (type === 'end') {
            const f = this.fieldStack.pop();
            if (f?.toc) this.inToc = this.fieldStack.some((x) => x.toc);
          }
          break;
        }
        case 'instrText': {
          const f = this.fieldStack[this.fieldStack.length - 1];
          if (f) f.instr += c.textContent;
          break;
        }
        default:
          break;
      }
    }
    flush();
    return out;
  }

  paragraph(p) {
    const direct = readParaProps(kid(p, 'pPr'));
    const styleId = direct.styleId || this.styleSheet.defaultPara;
    const style = this.styleSheet.resolve(styleId);
    const props = { ...this.styleSheet.defaults.para, ...style.para, ...direct };
    const names = style.ancestry || [];
    const headingMatch = names.map((n) => /^heading\s*([1-6])$/.exec(n)).find(Boolean);
    const level = headingMatch ? Number(headingMatch[1]) : null;
    const named = names.map((n) => PARAGRAPH_STYLE_IDS[n]).find(Boolean);
    const isTocEntry = names.some((n) => /^toc\s*\d|^table of contents|^toc heading/.test(n));

    // Run formatting baseline: docDefaults + paragraph style. Headings keep
    // LibreWord's heading look unless the run is formatted directly.
    const styled = Boolean(level || named);
    const baseRun = styled ? {} : { ...this.styleSheet.defaults.run, ...style.run };
    const opts = { inHeading: Boolean(level) };
    const wasInToc = this.inToc;
    const pending = this.pendingBlocks;
    this.pendingBlocks = [];
    const content = this.inline(p, baseRun, opts);
    const boxes = this.pendingBlocks;
    this.pendingBlocks = pending;
    // Cached TOC entries are dropped; LibreWord renders a live TOC instead.
    const tocParagraph = wasInToc || this.inToc || (isTocEntry && (this.tocFound || /toc heading/.test(names.join(' '))));

    const blocks = [];
    if (props.pageBreakBefore) blocks.push({ html: '<div data-page-break></div>' });
    if (this.tocFound && !this.tocEmitted) {
      this.tocEmitted = true;
      blocks.push({ html: '<nav data-toc></nav>' });
    }
    if (!tocParagraph) {
      // Headings and named styles (Title, Quote…) look right from LibreWord's own
      // CSS, so only their direct formatting is kept. For body text the
      // effective formatting is kept unless it matches LibreWord's defaults.
      const f = styled ? direct : props;
      const css = [];
      if (f.align && f.align !== 'left') css.push(`text-align: ${f.align}`);
      if (f.lineHeight && Math.abs(f.lineHeight - 1.15) > 0.01) css.push(`line-height: ${f.lineHeight}`);
      if (f.before != null && f.before > 0) css.push(`padding-top: ${f.before}pt`);
      if (f.after != null && Math.abs(f.after - 8) > 0.01) css.push(`margin-bottom: ${f.after}pt`);
      const listed = props.numId && this.numbering.exists(props.numId);
      // LibreWord exports checklists as ☐/☒ paragraphs; turn them back into checklists.
      const task = !level && /^(<[^>]+>)*[☐☒]\s/.test(content) ? { checked: content.includes('☒') } : null;
      if (!listed && !task && f.indent > 0) css.push(`margin-left: ${Math.round(f.indent)}px`);
      if (!listed && !task && f.firstLine) css.push(`text-indent: ${Math.round(f.firstLine)}px`);
      const style = css.length ? ` style="${css.join('; ')}"` : '';
      const tag = level ? `h${level}` : 'p';
      const dataStyle = !level && named ? ` data-style="${named}"` : '';
      const body = task ? content.replace(/[☐☒]\s/, '') : content;
      // A page break inside the paragraph splits it, so text after the break
      // starts the next page (Word often puts a chapter's break at its start).
      const parts = body.split(PAGE_BREAK);
      const isEmpty = (h) => !h.replace(/<(?!img)[^>]+>/g, '').trim();
      parts.forEach((part, i) => {
        if (i > 0) blocks.push({ html: '<div data-page-break></div>' });
        if (parts.length > 1 && isEmpty(part)) return;
        blocks.push({
          html: `<${tag}${dataStyle}${style}>${part}</${tag}>`,
          list: listed ? { numId: props.numId, ilvl: props.ilvl || 0 } : null,
          task,
        });
      });
    }
    blocks.push(...boxes);
    return blocks;
  }

  table(tbl) {
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => Math.round((twips(wattr(g, 'w')) || 0) / TWIPS_PER_PX));
    const rows = unwrapped(tbl, 'tr');
    // Build a cell matrix to turn vMerge runs into rowspans.
    const matrix = rows.map((tr) => {
      let col = num(val(kid(kid(tr, 'trPr'), 'gridBefore'))) || 0;
      return unwrapped(tr, 'tc').map((tc) => {
        const tcPr = kid(tc, 'tcPr');
        const span = num(val(kid(tcPr, 'gridSpan'))) || 1;
        const vm = kid(tcPr, 'vMerge');
        const cell = { tc, col, span, vMerge: vm ? (val(vm) === 'restart' ? 'restart' : 'continue') : null, rowspan: 1, header: Boolean(onOff(kid(kid(tr, 'trPr'), 'tblHeader'))) };
        const fill = wattr(kid(tcPr, 'shd'), 'fill');
        if (fill && fill !== 'auto' && /^[0-9a-f]{6}$/i.test(fill)) cell.bg = `#${fill.toLowerCase()}`;
        col += span;
        return cell;
      });
    });
    matrix.forEach((row, ri) => {
      for (const cell of row) {
        if (cell.vMerge !== 'restart') continue;
        for (let rj = ri + 1; rj < matrix.length; rj++) {
          const below = matrix[rj].find((c) => c.col === cell.col);
          if (below?.vMerge === 'continue') {
            cell.rowspan++;
            below.skip = true;
          } else break;
        }
      }
    });
    let html = '<table><tbody>';
    for (const row of matrix) {
      html += '<tr>';
      for (const cell of row) {
        if (cell.skip) continue;
        const tag = cell.header ? 'th' : 'td';
        const widths = grid.slice(cell.col, cell.col + cell.span);
        const attrs = [
          cell.span > 1 ? ` colspan="${cell.span}"` : '',
          cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '',
          widths.length && widths.every((w) => w > 0) ? ` colwidth="${widths.join(',')}"` : '',
          cell.bg ? ` style="background-color: ${cell.bg}"` : '',
        ].join('');
        const inner = this.blocks(kids(cell.tc));
        html += `<${tag}${attrs}>${inner || '<p></p>'}</${tag}>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }

  /** Convert block children (body, cell, sdtContent…) and assemble lists. */
  blocks(children) {
    const out = [];
    for (const el of children) {
      switch (el.localName) {
        case 'p':
          out.push(...this.paragraph(el));
          break;
        case 'tbl':
          out.push({ html: this.table(el) });
          break;
        case 'sdt':
          out.push({ html: this.blocks(kids(kid(el, 'sdtContent'))) });
          break;
        case 'customXml':
        case 'ins':
        case 'moveTo':
          out.push({ html: this.blocks(kids(el)) });
          break;
        default:
          break;
      }
    }
      return assembleLists(out, this.numbering, this.listCounters);
  }
}

/** Group consecutive list paragraphs into nested <ul>/<ol> by numId and level. */
function assembleLists(blocks, numbering, counters = new Map()) {
  let html = '';
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.task) {
      html += '<ul data-type="taskList">';
      while (i < blocks.length && blocks[i].task) {
        html += `<li data-type="taskItem" data-checked="${blocks[i].task.checked}">${blocks[i].html}</li>`;
        i++;
      }
      html += '</ul>';
      continue;
    }
    if (!b.list) {
      html += b.html;
      i++;
      continue;
    }
    const run = [];
    while (i < blocks.length && blocks[i].list) run.push(blocks[i++]);
    html += buildList(run, numbering, counters);
  }
  return html;
}

function buildList(items, numbering, counters) {
  let html = '';
  const next = (numId, level) => counters.get(`${numId}:${level}`) ?? numbering.start(numId, level);
  const stack = []; // open lists, innermost last: { tag, level, numId, hasItem }
  for (const it of items) {
    const { ilvl: level, numId } = it.list;
    while (stack.length && stack[stack.length - 1].level > level) html += `</li></${stack.pop().tag}>`;
    let top = stack[stack.length - 1];
    // A different list at the top level starts a new list.
    if (top && stack.length === 1 && top.level === level && top.numId !== numId) {
      html += `</li></${stack.pop().tag}>`;
      top = null;
    }
    if (!top || top.level < level) {
      // Opens nested inside the parent's still-open <li>.
      const tag = numbering.kind(numId, level);
      const start = tag === 'ol' ? next(numId, level) : 1;
      html += `<${tag}${start !== 1 ? ` start="${start}"` : ''}>`;
      top = { tag, level, numId, hasItem: false };
      stack.push(top);
    }
    if (top.hasItem) html += '</li>';
    html += `<li>${it.html}`;
    top.hasItem = true;
    counters.set(`${numId}:${level}`, next(numId, level) + 1);
    // As in Word, a new item restarts the numbering of the levels below it.
    for (const key of [...counters.keys()]) {
      const [id, l] = key.split(':');
      if (id === numId && Number(l) > level) counters.delete(key);
    }
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

function readNotes(xml, tag) {
  const out = new Map();
  if (!xml) return out;
  for (const n of deep(parseXml(xml), tag)) {
    const type = wattr(n, 'type');
    if (type === 'separator' || type === 'continuationSeparator') continue;
    const text = deep(n, 'p').map((p) => deep(p, 't').map((t) => t.textContent).join('')).join(' ').trim();
    out.set(wattr(n, 'id'), text);
  }
  return out;
}

/**
 * Header/footer text with fields replaced by placeholders. Page-number fields
 * (and the words around them, e.g. "Page 1 of 3" / "Seite 1 von 3") are
 * dropped because LibreWord draws its own page numbers.
 */
function headerFooterText(xml) {
  if (!xml) return { text: '', pageField: false };
  const doc = parseXml(xml);
  let pageField = false;
  const fieldToken = (instr) => {
    const m = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.exec(instr || '');
    if (!m) return null;
    pageField = true;
    return m[1].toUpperCase() === 'PAGE' ? '{PAGE}' : '{NUMPAGES}';
  };
  const paraText = (p) => {
    let text = '';
    const stack = []; // { instr, inResult }
    const walk = (el) => {
      for (const c of kids(el)) {
        const name = c.localName;
        if (name === 'fldSimple') {
          text += fieldToken(wattr(c, 'instr')) ?? deep(c, 't').map((t) => t.textContent).join('');
        } else if (name === 'fldChar') {
          const type = wattr(c, 'fldCharType');
          if (type === 'begin') stack.push({ instr: '', inResult: false });
          else if (type === 'separate' && stack.length) {
            const f = stack[stack.length - 1];
            f.inResult = true;
            const token = fieldToken(f.instr);
            if (token) {
              text += token;
              f.skip = true;
            }
          } else if (type === 'end') stack.pop();
        } else if (name === 'instrText') {
          if (stack.length) stack[stack.length - 1].instr += c.textContent;
        } else if (name === 't') {
          if (!stack.some((f) => f.skip)) text += c.textContent;
        } else if (name === 'tab') {
          text += ' ';
        } else if (!['rPr', 'pPr', 'del', 'moveFrom'].includes(name)) {
          walk(c);
        }
      }
    };
    walk(p);
    return text.trim();
  };
  let text = deep(doc, 'p').map(paraText).filter(Boolean).join('   ');
  if (pageField) {
    text = text
      .replace(/\S*\s*\{PAGE\}(\s*\S+\s*\{NUMPAGES\})?/g, '')
      .replace(/\S*\s*\{NUMPAGES\}/g, '')
      .replace(/\s{2,}/g, '   ')
      .trim();
  }
  return { text, pageField };
}

async function readComments(zip) {
  const xml = await readText(zip, 'word/comments.xml');
  const comments = {};
  const idMap = new Map();
  if (!xml) return { comments, idMap };
  const doc = parseXml(xml);
  const extXml = await readText(zip, 'word/commentsExtended.xml');
  const ext = new Map();
  if (extXml) {
    for (const e of deep(parseXml(extXml), 'commentEx')) {
      const attr = (n) => e.getAttribute(`w15:${n}`) ?? e.getAttributeNS('http://schemas.microsoft.com/office/word/2012/wordml', n);
      ext.set(attr('paraId'), { parent: attr('paraIdParent'), done: attr('done') === '1' });
    }
  }
  const byPara = new Map();
  const all = deep(doc, 'comment').map((c) => {
    const paras = deep(c, 'p');
    const last = paras[paras.length - 1];
    const paraId = last?.getAttribute('w14:paraId') ?? last?.getAttributeNS('http://schemas.microsoft.com/office/word/2010/wordml', 'paraId');
    const entry = {
      wid: wattr(c, 'id'),
      author: wattr(c, 'author') || 'Author',
      initials: wattr(c, 'initials') || '',
      date: Date.parse(wattr(c, 'date') || '') || Date.now(),
      text: paras.map((p) => deep(p, 't').map((t) => t.textContent).join('')).join('\n').trim(),
      paraId,
    };
    if (paraId) byPara.set(paraId, entry);
    return entry;
  });
  for (const c of all) {
    const meta = c.paraId ? ext.get(c.paraId) : null;
    const parent = meta?.parent ? byPara.get(meta.parent) : null;
    if (parent) {
      const p = comments[`d${parent.wid}`];
      if (p) {
        p.replies.push({ author: c.author, initials: c.initials, date: c.date, text: c.text });
        idMap.set(c.wid, null);
        continue;
      }
    }
    const id = `d${c.wid}`;
    comments[id] = { id, author: c.author, initials: c.initials, date: c.date, text: c.text, replies: [], resolved: Boolean(meta?.done) };
    idMap.set(c.wid, id);
  }
  return { comments, idMap };
}

export async function readDocx(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const mainPath = 'word/document.xml';
  const docXml = await readText(zip, mainPath);
  if (!docXml) throw new Error('This file is not a Word document.');
  const [stylesXml, numberingXml, relsXml, coreXml] = await Promise.all([
    readText(zip, 'word/styles.xml'),
    readText(zip, 'word/numbering.xml'),
    readText(zip, 'word/_rels/document.xml.rels'),
    readText(zip, 'docProps/core.xml'),
  ]);
  const rels = readRels(relsXml);

  // Embed images as data URLs.
  const images = new Map();
  await Promise.all(
    [...rels.entries()]
      .filter(([, r]) => /\/image$/.test(r.type) && !r.external)
      .map(async ([rid, r]) => {
        const path = resolvePath(mainPath, r.target);
        const file = zip.file(path);
        if (!file) return;
        const ext = path.split('.').pop().toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
        if (!mime) return; // emf/wmf aren't renderable in browsers
        images.set(rid, `data:${mime};base64,${await file.async('base64')}`);
      }),
  );

  const { comments, idMap } = await readComments(zip);
  const notes = {
    footnotes: readNotes(await readText(zip, 'word/footnotes.xml'), 'footnote'),
    endnotes: readNotes(await readText(zip, 'word/endnotes.xml'), 'endnote'),
  };
  const doc = parseXml(docXml);
  const body = deep(doc, 'body')[0];
  const reader = new DocxReader({
    styleSheet: readStyles(stylesXml),
    numbering: readNumbering(numberingXml),
    rels,
    images,
    commentIds: idMap,
    notes,
  });
  let html = reader.blocks(kids(body));
  // LibreWord has no footnote layout yet: notes are listed at the end, linked from their markers.
  if (reader.noteList.length) {
    // A bold paragraph rather than a heading, so it stays out of the TOC.
    html += '<hr><p><strong>Notes</strong></p>';
    reader.noteList.forEach((text, i) => {
      html += `<p data-style="caption"><sup>${i + 1}</sup> ${esc(text)}</p>`;
    });
  }

  const sectPr = kid(body, 'sectPr') || deep(body, 'sectPr').pop();
  const settings = pageSettings(sectPr) || {};
  const refTarget = (name) => {
    const ref = kids(sectPr, name).find((r) => (wattr(r, 'type') || 'default') === 'default') || kids(sectPr, name)[0];
    const relId = rid(ref, 'id');
    const rel = relId && rels.get(relId);
    return rel ? resolvePath(mainPath, rel.target) : null;
  };
  const headerPath = sectPr && refTarget('headerReference');
  const footerPath = sectPr && refTarget('footerReference');
  const header = headerFooterText(headerPath && (await readText(zip, headerPath)));
  const footer = headerFooterText(footerPath && (await readText(zip, footerPath)));
  settings.header = header.text;
  settings.footer = footer.text;
  settings.pageNumbers = footer.pageField || header.pageField;

  const title = coreXml ? deep(parseXml(coreXml), 'title')[0]?.textContent?.trim() || '' : '';
  return { html, settings, comments, title };
}
