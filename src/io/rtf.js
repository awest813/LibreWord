/**
 * Native Rich Text Format reader and writer.
 *
 * rtfToHtml() turns RTF (Word, LibreOffice, WordPad, TextEdit…) into LibreWord
 * HTML in the same flavour docx-import.js emits: headings, named paragraph
 * styles, alignment/indents/spacing, character formatting, links, lists,
 * tables, page breaks and PNG/JPEG pictures.
 *
 * jsonToRtf() writes the editor's ProseMirror JSON as RTF that Word,
 * LibreOffice, WordPad and TextEdit open, covering what docx.js covers: a real
 * stylesheet (Normal, Heading 1–6, Title…), list tables with \listtext
 * fallbacks, tables with merged cells and shading, pictures, page setup,
 * header/footer and document title.
 */
import { pageGeometry, TWIPS_PER_PX } from '../editor/page-setup.js';
import { cssLengthToPx } from '../editor/paragraph-format.js';

const esc = (v = '') => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ============================================================== shared helpers

function dataUrlToBytes(src) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src || '');
  if (!m) return null;
  try {
    const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: m[1].toLowerCase() };
  } catch {
    return null;
  }
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Pixel size from a PNG or JPEG header, or null. */
function imageSize(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 8 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      // SOFn frames (but not DHT/JPG/DAC, which share the range) carry the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
      }
      i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
    }
  }
  return null;
}

// ================================================================== reader

// \fcharsetN → Windows code page. ANSI (0) and Default (1) use the document's \ansicpg.
const CHARSET_CP = {
  77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850,
};
// Code pages whose TextDecoder label isn't simply "windows-N".
const CP_LABELS = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 874: 'windows-874' };
// cp1252's 0x80–0x9F block, decoded by hand: some TextDecoder builds (Node 22) treat it as Latin-1.
const CP1252_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f'
  + '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';
const decoders = new Map();

function decodeBytes(bytes, cp) {
  if (cp && cp !== 1252) {
    if (!decoders.has(cp)) {
      let d = null;
      try { d = new TextDecoder(CP_LABELS[cp] || `windows-${cp}`); } catch { /* unsupported: cp1252 */ }
      decoders.set(cp, d);
    }
    const d = decoders.get(cp);
    if (d) return d.decode(new Uint8Array(bytes));
  }
  return bytes.map((b) => (b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b))).join('');
}

const PARAGRAPH_STYLE_IDS = { title: 'title', subtitle: 'subtitle', quote: 'quote', 'intense quote': 'intense-quote', caption: 'caption', 'no spacing': 'no-spacing' };
// Paragraph styles that become <blockquote> / <pre> (Word, LibreOffice and pandoc names).
const QUOTE_STYLES = new Set(['block text', 'quotations', 'block quote', 'blockquote']);
const CODE_STYLES = new Set(['source code', 'html preformatted', 'preformatted text', 'code', 'code block']);
const MONO_FONTS = /^(consolas|courier new|courier|menlo|monaco|lucida console|liberation mono|dejavu sans mono|source code pro|monospace)$/i;
const DEFAULT_FONT = /^(calibri)$/i; // LibreWord's own body font: no need to spell it out
const SAFE_HREF = /^(https?:|mailto:|tel:|#)/i;

// Destinations whose content is never shown. Unknown \* destinations are skipped too.
const SKIP_DESTS = new Set([
  'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'footnote', 'annotation',
  'atnid', 'atnauthor', 'atndate', 'atnref', 'atrfstart', 'atrfend', 'comment', 'xe', 'tc', 'tcn', 'txe', 'bkmkstart',
  'bkmkend', 'datafield', 'objdata', 'objclass', 'objname', 'template', 'revtbl', 'filetbl', 'rsidtbl', 'generator',
  'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'docvar',
  'nonshppict', 'pntxtb', 'pntxta', 'pnseclvl', 'ftnsep', 'ftnsepc', 'ftncn', 'aftnsep', 'aftnsepc', 'aftncn',
  'shpinst', 'do', 'nesttableprops', 'listpicture', 'fchars', 'lchars', 'keycode', 'userprops', 'private',
  'leveltext', 'levelnumbers', 'listname', 'falt', 'panose', 'blipuid', 'stylesheet_', 'wgrffmtfilter', 'passwordhash',
]);

const defaultChar = () => ({ b: false, i: false, ul: false, strike: false, sup: false, sub: false, f: null, fs: null, cf: 0, hl: 0, hidden: false });
const defaultPara = () => ({ align: null, li: 0, ri: 0, fi: 0, sb: null, sa: null, sl: 0, slmult: false, s: 0, outline: null, ls: null, ilvl: 0, intbl: false, pagebb: false, border: false, pn: null });
const newRowDef = () => ({ cells: [], pending: {}, left: 0, header: false });
const fmtKey = (c, link) => `${+c.b}${+c.i}${+c.ul}${+c.strike}${+c.sup}${+c.sub}|${c.f}|${c.fs}|${c.cf}|${c.hl}|${link || ''}`;

const MAX_DEPTH = 500; // deeper groups are dropped rather than tracked
const MAX_PICT_CHARS = 64 * 1024 * 1024; // hex characters per picture

/** Pull the target out of a HYPERLINK field instruction. */
function hyperlinkTarget(instr) {
  const m = /^\s*HYPERLINK\s+(.*)$/is.exec(instr || '');
  if (!m) return null;
  let rest = m[1];
  let anchor = null;
  const lm = /\\l\s+"([^"]*)"/.exec(rest);
  if (lm) {
    anchor = lm[1];
    rest = rest.replace(lm[0], '');
  }
  const url = (/"([^"]*)"/.exec(rest) || /^\s*([^\s\\"]+)/.exec(rest))?.[1]?.trim();
  const href = url ? url + (anchor ? `#${anchor}` : '') : anchor ? `#${anchor}` : null;
  return href && SAFE_HREF.test(href) ? href : null;
}

class RtfReader {
  constructor(src) {
    this.src = src;
    this.binary = false;
    this.fonts = new Map(); // \fN → { name, cp }
    this.colors = []; // colour table index → '#rrggbb' (null for "auto")
    this.colorCur = null;
    this.styles = new Map(); // \sN → { name, char, para }
    this.listDefs = []; // { id, levels: [{ nfc, start }] }
    this.overrides = []; // { listid, ls }
    this.title = '';
    this.ansiCp = 1252;
    this.deff = null;
    this.blocks = []; // { para } | { html } | { table }
    this.cur = { segs: [], afterBreak: false };
    this.listText = '';
    this.table = null;
    this.rowDef = newRowDef();
    this.rowCells = [];
    this.cellParas = [];
    this.bytes = [];
    this.skip = 0; // \ucN fallback units still to drop after a \uN
  }

  // ------------------------------------------------------------- tokenizer
  run() {
    const s = this.src;
    const n = s.length;
    this.stack = [];
    this.state = { char: defaultChar(), para: defaultPara(), dest: 'body', uc: 1, fresh: false, ignorable: false };
    let i = s.indexOf('{');
    while (i >= 0 && i < n) {
      const c = s.charCodeAt(i);
      if (c === 123) { // {
        this.flushBytes();
        this.skip = 0;
        this.open();
        i++;
      } else if (c === 125) { // }
        this.flushBytes();
        this.skip = 0;
        i++;
        if (!this.close()) break; // the document group closed: ignore trailing junk
      } else if (c === 92) { // \
        i = this.control(i);
      } else if (c === 13 || c === 10) {
        i++;
      } else if (this.skip > 0) {
        this.skip--;
        i++;
      } else {
        let j = i + 1;
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 92 || d === 123 || d === 125 || d === 13 || d === 10) break;
          j++;
        }
        this.literal(s.slice(i, j));
        i = j;
      }
    }
    this.flushBytes();
    if (this.cur.segs.length) this.endParagraph();
    this.closeTable();
  }

  /** Raw text characters. In binary input, bytes above 0x7F are in the document's code page. */
  literal(str) {
    if (!this.binary || !/[\x80-\xff]/.test(str)) {
      this.flushBytes();
      this.text(str);
      return;
    }
    for (const ch of str) {
      if (ch.charCodeAt(0) >= 0x80) this.pushByte(ch.charCodeAt(0));
      else {
        this.flushBytes();
        this.text(ch);
      }
    }
  }

  control(i) {
    const s = this.src;
    const next = s[i + 1];
    if (next === undefined) return i + 1;
    if (/[a-zA-Z]/.test(next)) {
      let j = i + 1;
      while (j < s.length && j - i <= 32 && /[a-zA-Z]/.test(s[j])) j++;
      const name = s.slice(i + 1, j);
      let param = null;
      let k = j;
      const neg = s[k] === '-';
      const start = neg ? k + 1 : k;
      let m = start;
      while (m < s.length && m - start < 10 && s.charCodeAt(m) >= 48 && s.charCodeAt(m) <= 57) m++;
      if (m > start) {
        param = Number(s.slice(start, m)) * (neg ? -1 : 1);
        k = m;
      }
      if (s[k] === ' ') k++;
      if (name === 'bin') {
        // \binN: N raw bytes follow (only meaningful inside a picture).
        const len = Math.max(0, Math.min(param || 0, s.length - k));
        this.flushBytes();
        if (this.skip > 0) this.skip--;
        else if (this.state.dest === 'pict' && this.state.pict) this.state.pict.bin = s.slice(k, k + len);
        return k + len;
      }
      if (this.skip > 0) {
        // A control word counts as one fallback character.
        this.skip--;
        return k;
      }
      this.flushBytes();
      this.word(name, param);
      return k;
    }
    if (next === "'") {
      const hex = s.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return i + 2;
      if (this.skip > 0) this.skip--;
      else this.pushByte(parseInt(hex, 16));
      return i + 4;
    }
    if (this.skip > 0) {
      this.skip--;
      return i + 2;
    }
    this.flushBytes();
    if (next === '\r' || next === '\n') this.word('par', null);
    else this.symbol(next);
    return i + 2;
  }

  pushByte(b) {
    this.bytes.push(b);
  }

  /** Decode buffered \'hh bytes together, so double-byte code pages work. */
  flushBytes() {
    if (!this.bytes.length) return;
    const bytes = this.bytes;
    this.bytes = [];
    const st = this.state;
    const font = this.fonts.get(st.dest === 'fonttbl' ? st.fontIdx : st.char.f ?? this.deff);
    this.text(decodeBytes(bytes, font?.cp || this.ansiCp));
  }

  // ---------------------------------------------------------------- groups
  open() {
    const parent = this.state;
    this.stack.push(parent);
    const st = {
      ...parent, char: { ...parent.char }, para: { ...parent.para }, fresh: true, ignorable: false, owner: null,
      uprChild: Boolean(parent.inUpr), inUpr: false,
    };
    if (this.stack.length > MAX_DEPTH) st.dest = 'skip';
    else if (parent.dest === 'stylesheet') {
      // Each style definition starts from plain formatting.
      st.dest = 'style';
      st.char = defaultChar();
      st.para = defaultPara();
      st.entry = { n: 0, name: '', kind: 'p', done: false };
      st.owner = 'style';
    }
    this.state = st;
  }

  close() {
    if (!this.stack.length) return false;
    const st = this.state;
    this.state = this.stack.pop();
    switch (st.owner) {
      case 'pict': this.finishPict(st.pict); break;
      case 'style': this.finishStyle(st); break;
      case 'sp':
        if (st.pict && st.prop.sn.trim() === 'wzDescription') st.pict.alt = st.prop.sv.trim();
        break;
      // Old-style (Word 95 / WordPad) list properties belong to the enclosing paragraph.
      case 'pn': this.state.para.pn = st.pnInfo; break;
      default: break;
    }
    return this.stack.length > 0;
  }

  /** The first control word of a group may start a destination. Returns true when consumed. */
  destination(name) {
    const st = this.state;
    st.fresh = false;
    if (st.dest === 'skip') return true;
    if (st.uprChild) {
      // {\upr{ANSI version}{\*\ud{Unicode version}}}: keep only the Unicode one.
      if (name !== 'ud') st.dest = 'skip';
      return true;
    }
    if (st.dest === 'info') {
      st.dest = name === 'title' ? 'title' : 'skip';
      return true;
    }
    if (st.dest === 'listtable') {
      if (name === 'list') {
        st.listDef = { id: null, levels: [] };
        this.listDefs.push(st.listDef);
        return true;
      }
      if (name === 'listlevel') {
        st.levelDef = { nfc: 0, start: 1 };
        st.listDef?.levels.push(st.levelDef);
        return true;
      }
    }
    if (st.dest === 'lot' && name === 'listoverride') {
      st.override = { listid: null, ls: null };
      this.overrides.push(st.override);
      return true;
    }
    if (st.dest === 'picprop' || st.dest === 'sp') {
      if (name === 'sp') {
        st.prop = { sn: '', sv: '' };
        st.owner = 'sp';
        st.dest = 'sp';
        return true;
      }
      if ((name === 'sn' || name === 'sv') && st.prop) {
        st.dest = name;
        return true;
      }
    }
    switch (name) {
      case 'fonttbl': st.dest = 'fonttbl'; return true;
      case 'colortbl': st.dest = 'colortbl'; this.colorCur = { set: false, red: 0, green: 0, blue: 0 }; return true;
      case 'stylesheet': st.dest = 'stylesheet'; return true;
      case 'info': st.dest = 'info'; return true;
      case 'listtable': st.dest = 'listtable'; return true;
      case 'listoverridetable': st.dest = 'lot'; return true;
      case 'pict':
        if (st.dest !== 'body') {
          st.dest = 'skip';
        } else {
          st.dest = 'pict';
          st.pict = { type: null, hex: [], len: 0, bin: null, wgoal: 0, hgoal: 0, sx: 100, sy: 100, alt: '' };
          st.owner = 'pict';
        }
        return true;
      case 'picprop': st.dest = st.dest === 'pict' ? 'picprop' : 'skip'; return true;
      // Containers whose content is shown as usual.
      case 'shppict': case 'result': case 'shprslt': case 'ud': return true;
      case 'upr': st.inUpr = true; return true;
      case 'fldinst': st.dest = st.dest === 'body' && st.field ? 'fldinst' : 'skip'; return true;
      case 'fldrslt':
        if (st.dest === 'body' && st.field) st.link = hyperlinkTarget(st.field.instr) || st.link || null;
        return true;
      case 'listtext':
      case 'pntext':
        // The rendered bullet or number; the list itself comes from \ls or \pn.
        if (st.dest === 'body') {
          st.dest = 'listtext';
          this.listText = '';
        } else st.dest = 'skip';
        return true;
      case 'pn':
        if (st.dest === 'body') {
          st.dest = 'pn';
          st.pnInfo = { kind: 'ol', level: 0, start: 1 };
          st.owner = 'pn';
        } else st.dest = 'skip';
        return true;
      default:
        if (SKIP_DESTS.has(name) || st.ignorable) {
          st.dest = 'skip';
          return true;
        }
        return false;
    }
  }

  symbol(ch) {
    const st = this.state;
    if (ch === '*') {
      if (st.fresh) st.ignorable = true;
      return;
    }
    if (st.fresh && st.uprChild) this.destination('');
    st.fresh = false;
    switch (ch) {
      case '\\': case '{': case '}': this.text(ch); break;
      case '~': this.text('\u00a0'); break;
      case '_': this.text('\u2011'); break;
      case '\t': this.text('\t'); break;
      default: break; // \- optional hyphen, \| \: formula/index marks
    }
  }

  // ------------------------------------------------------------------ text
  text(str) {
    const st = this.state;
    if (st.fresh) {
      if (st.uprChild) this.destination('');
      else if (st.ignorable) st.dest = 'skip';
      st.fresh = false;
    }
    switch (st.dest) {
      case 'body':
        if (!st.char.hidden) this.addText(str);
        break;
      case 'fonttbl': {
        const font = this.fonts.get(st.fontIdx);
        if (!font || font.done) break;
        const semi = str.indexOf(';');
        font.name += semi >= 0 ? str.slice(0, semi) : str;
        if (semi >= 0) {
          font.done = true;
          font.name = font.name.trim();
        }
        break;
      }
      case 'colortbl':
        for (const ch of str) {
          if (ch !== ';') continue;
          const c = this.colorCur;
          this.colors.push(c.set ? `#${[c.red, c.green, c.blue].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}` : null);
          this.colorCur = { set: false, red: 0, green: 0, blue: 0 };
        }
        break;
      case 'style': {
        const e = st.entry;
        if (e.done) break;
        const semi = str.indexOf(';');
        e.name += semi >= 0 ? str.slice(0, semi) : str;
        if (semi >= 0) this.finishStyle(st);
        break;
      }
      case 'title': this.title += str; break;
      case 'fldinst': st.field.instr += str; break;
      case 'listtext': this.listText += str; break;
      case 'pict':
        if (st.pict.len < MAX_PICT_CHARS) {
          st.pict.hex.push(str);
          st.pict.len += str.length;
        }
        break;
      case 'sn': st.prop.sn += str; break;
      case 'sv': st.prop.sv += str; break;
      default: break;
    }
  }

  addText(str) {
    const st = this.state;
    const segs = this.cur.segs;
    const last = segs[segs.length - 1];
    const key = fmtKey(st.char, st.link);
    if (last && last.key === key) last.text += str;
    else segs.push({ text: str, fmt: { ...st.char }, link: st.link || null, key });
  }

  // ------------------------------------------------------------- control words
  word(name, param) {
    const st = this.state;
    if (st.fresh && this.destination(name)) return;
    if (st.dest === 'skip') return;

    // Document-wide settings and characters, valid in any destination.
    switch (name) {
      case 'ansi': this.ansiCp = 1252; return;
      case 'mac': this.ansiCp = 10000; return;
      case 'pc': this.ansiCp = 437; return;
      case 'pca': this.ansiCp = 850; return;
      case 'ansicpg': if (param > 0) this.ansiCp = param; return;
      case 'deff': this.deff = param; return;
      case 'uc': st.uc = Math.max(0, Math.min(param ?? 1, 10)); return;
      case 'u':
        if (param == null) return;
        this.text(String.fromCharCode(param < 0 ? param + 65536 : param));
        this.skip = st.uc;
        return;
      case 'emdash': this.text('\u2014'); return;
      case 'endash': this.text('\u2013'); return;
      case 'bullet': this.text('\u2022'); return;
      case 'lquote': this.text('\u2018'); return;
      case 'rquote': this.text('\u2019'); return;
      case 'ldblquote': this.text('\u201c'); return;
      case 'rdblquote': this.text('\u201d'); return;
      case 'emspace': this.text('\u2003'); return;
      case 'enspace': this.text('\u2002'); return;
      case 'qmspace': this.text('\u2005'); return;
      case 'zwj': this.text('\u200d'); return;
      case 'zwnj': this.text('\u200c'); return;
      case 'zwbo': this.text('\u200b'); return;
      case 'tab': if (st.dest === 'body' || st.dest === 'listtext') this.text('\t'); return;
      default: break;
    }

    switch (st.dest) {
      case 'fonttbl':
        if (name === 'f' && param != null) {
          st.fontIdx = param;
          if (!this.fonts.has(param)) this.fonts.set(param, { name: '', cp: null, done: false });
        } else if (name === 'fcharset') {
          const font = this.fonts.get(st.fontIdx);
          if (font) font.cp = CHARSET_CP[param] ?? null;
        } else if (name === 'cpg') {
          const font = this.fonts.get(st.fontIdx);
          if (font && param > 0) font.cp = param;
        }
        return;
      case 'colortbl':
        if ((name === 'red' || name === 'green' || name === 'blue') && param != null) {
          this.colorCur[name] = param;
          this.colorCur.set = true;
        }
        return;
      case 'listtable':
        if ((name === 'levelnfc' || name === 'levelnfcn') && st.levelDef) st.levelDef.nfc = param ?? 0;
        else if (name === 'levelstartat' && st.levelDef) st.levelDef.start = param ?? 1;
        else if (name === 'listid' && st.listDef) st.listDef.id = param;
        return;
      case 'lot':
        if (st.override && (name === 'listid' || name === 'ls')) st.override[name] = param;
        return;
      case 'pict': {
        const p = st.pict;
        switch (name) {
          case 'pngblip': p.type = 'png'; break;
          case 'jpegblip': p.type = 'jpeg'; break;
          case 'emfblip': case 'wmetafile': case 'macpict': case 'pmmetafile': case 'dibitmap': case 'wbitmap': p.type = 'other'; break;
          case 'picwgoal': p.wgoal = param || 0; break;
          case 'pichgoal': p.hgoal = param || 0; break;
          case 'picscalex': p.sx = param > 0 ? param : 100; break;
          case 'picscaley': p.sy = param > 0 ? param : 100; break;
          default: break;
        }
        return;
      }
      case 'pn': {
        const pn = st.pnInfo;
        if (name === 'pnlvlblt') pn.kind = 'ul';
        else if (name === 'pnlvlbody' || name === 'pnlvlcont') pn.kind = pn.kind === 'ul' ? 'ul' : 'ol';
        else if (name === 'pnlvl' && param > 0) pn.level = Math.min(8, param - 1);
        else if (name === 'pnstart' && param != null) pn.start = param;
        return;
      }
      case 'style':
        if (name === 's') { st.entry.n = param ?? 0; return; }
        if (name === 'cs' || name === 'ds' || name === 'ts') { st.entry.kind = 'other'; return; }
        this.formatting(name, param);
        return;
      case 'body':
        break;
      default:
        // Formatting inside \listtext, fldinst… doesn't matter.
        return;
    }

    if (this.formatting(name, param)) return;
    const row = this.rowDef;
    switch (name) {
      case 'par': this.endParagraph(); break;
      case 'line': this.cur.segs.push({ br: true, link: st.link || null, key: 'br' }); break;
      case 'page': this.pageBreak(); break;
      case 'sect': if (this.cur.segs.length) this.endParagraph(); break;
      case 'cell': this.endCell(); break;
      case 'nestcell': this.endParagraph(true); break; // nested tables are flattened into the outer cell
      case 'row': this.endRow(); break;
      case 'trowd': this.rowDef = newRowDef(); break;
      case 'trhdr': row.header = true; break;
      case 'trleft': row.left = param || 0; break;
      case 'cellx': row.cells.push({ ...row.pending, right: param ?? 0 }); row.pending = {}; break;
      case 'clmgf': case 'clmrg': case 'clvmgf': case 'clvmrg': row.pending[name] = true; break;
      case 'clcbpat': row.pending.bg = param; break;
      case 'field': st.field = { instr: '' }; break;
      default: break;
    }
  }

  /** Character and paragraph formatting; shared by the body and style definitions. */
  formatting(name, param) {
    const st = this.state;
    const c = st.char;
    const p = st.para;
    const on = param !== 0;
    switch (name) {
      case 'plain': st.char = defaultChar(); break;
      case 'b': c.b = on; break;
      case 'i': c.i = on; break;
      case 'ul': case 'uld': case 'uldash': case 'uldashd': case 'uldashdd': case 'uldb': case 'ulth': case 'ulw':
      case 'ulwave': case 'ulhwave': case 'ululdbwave': case 'ulthd': case 'ulthdash': case 'ulthdashd':
      case 'ulthdashdd': case 'ulldash': case 'ulthldash':
        c.ul = on;
        break;
      case 'ulnone': c.ul = false; break;
      case 'strike': case 'striked': c.strike = on; break;
      case 'super': c.sup = on; if (on) c.sub = false; break;
      case 'sub': c.sub = on; if (on) c.sup = false; break;
      case 'up': c.sup = param > 0; if (c.sup) c.sub = false; break; // LibreOffice's raised text
      case 'dn': c.sub = param > 0; if (c.sub) c.sup = false; break;
      case 'nosupersub': c.sup = false; c.sub = false; break;
      case 'f': c.f = param; break;
      case 'fs': c.fs = param > 0 ? param : null; break;
      case 'cf': c.cf = param || 0; break;
      case 'highlight': case 'cb': case 'chcbpat': c.hl = param || 0; break;
      case 'v': c.hidden = on; break;
      case 'pard': st.para = defaultPara(); break;
      case 'ql': p.align = null; break;
      case 'qc': p.align = 'center'; break;
      case 'qr': p.align = 'right'; break;
      case 'qj': case 'qd': p.align = 'justify'; break;
      case 'li': case 'lin': p.li = param || 0; break;
      case 'ri': case 'rin': p.ri = param || 0; break;
      case 'fi': p.fi = param || 0; break;
      case 'sb': p.sb = param ?? 0; break;
      case 'sa': p.sa = param ?? 0; break;
      case 'sl': p.sl = param || 0; break;
      case 'slmult': p.slmult = param === 1; break;
      case 's': p.s = param ?? 0; break;
      case 'outlinelevel': p.outline = param; break;
      case 'ls': p.ls = param; break;
      case 'ilvl': p.ilvl = Math.max(0, Math.min(8, param || 0)); break;
      case 'intbl': p.intbl = true; break;
      case 'itap': p.intbl = param > 0; break;
      case 'pagebb': p.pagebb = on; break;
      case 'brdrb': p.border = true; break;
      default: return false;
    }
    return true;
  }

  finishStyle(st) {
    const e = st.entry;
    // Skipped entries ({\*\cs…} character styles, table styles) aren't paragraph styles.
    if (!e || e.done || st.dest !== 'style') return;
    e.done = true;
    if (e.kind === 'p') this.styles.set(e.n, { name: e.name.trim(), char: { ...st.char }, para: { ...st.para } });
  }

  finishPict(pict) {
    if (this.state.dest !== 'body' || (pict.type !== 'png' && pict.type !== 'jpeg')) return; // WMF/EMF can't be shown
    let bytes;
    if (pict.bin != null) {
      bytes = new Uint8Array(pict.bin.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = pict.bin.charCodeAt(i) & 0xff;
    } else {
      const hex = pict.hex.join('').replace(/[^0-9a-fA-F]/g, '');
      bytes = new Uint8Array(hex.length >> 1);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    if (!bytes.length) return;
    const natural = imageSize(bytes);
    // Display size: \picwgoal (twips) scaled by \picscalex (%), else the pixel size.
    let w = pict.wgoal ? (pict.wgoal * pict.sx) / 100 / TWIPS_PER_PX : natural ? (natural.width * pict.sx) / 100 : 0;
    let h = pict.hgoal ? (pict.hgoal * pict.sy) / 100 / TWIPS_PER_PX : natural ? (natural.height * pict.sy) / 100 : 0;
    w = Math.round(w);
    h = Math.round(h);
    const src = `data:image/${pict.type};base64,${bytesToBase64(bytes)}`;
    const img = `<img src="${src}"${pict.alt ? ` alt="${esc(pict.alt)}"` : ''}${w > 0 ? ` width="${w}"` : ''}${h > 0 ? ` height="${h}"` : ''}>`;
    this.cur.segs.push({ img, link: this.state.link || null, key: 'img' });
  }

  // ------------------------------------------------------- paragraphs/tables
  endParagraph(inCell = false) {
    const para = { ...this.state.para };
    const p = { segs: this.cur.segs, para, listText: this.listText };
    const afterBreak = this.cur.afterBreak;
    this.cur = { segs: [], afterBreak: false };
    this.listText = '';
    // The empty paragraph a page break often leaves behind.
    if (afterBreak && !p.segs.length) return;
    if (para.intbl || inCell) {
      this.cellParas.push(p);
      return;
    }
    this.closeTable();
    this.blocks.push({ para: p });
  }

  pageBreak() {
    if (this.state.para.intbl) return;
    // Text before the break stays on the old page; the paragraph continues on the next.
    if (this.cur.segs.length) this.endParagraph();
    this.closeTable();
    this.blocks.push({ html: '<div data-page-break></div>' });
    this.cur.afterBreak = true;
  }

  endCell() {
    if (this.cur.segs.length || !this.cellParas.length) this.endParagraph(true);
    else this.cur = { segs: [], afterBreak: false };
    this.rowCells.push(this.cellParas);
    this.cellParas = [];
  }

  endRow() {
    if (this.cur.segs.length || this.cellParas.length) this.endCell();
    if (!this.table) this.table = { rows: [] };
    this.table.rows.push({ cells: this.rowCells, def: this.rowDef });
    this.rowCells = [];
  }

  closeTable() {
    if (this.rowCells.length || this.cellParas.length) this.endRow(); // a row missing its \row
    if (!this.table) return;
    this.blocks.push({ table: this.table });
    this.table = null;
  }

  // ------------------------------------------------------------------- HTML
  html() {
    const items = [];
    for (const b of this.blocks) {
      if (b.para) items.push(...this.paragraphItems(b.para, {}));
      else if (b.table) items.push({ html: this.tableHtml(b.table) });
      else items.push({ html: b.html });
    }
    return assemble(items) || '<p></p>';
  }

  listInfo(p) {
    const f = p.para;
    if (f.pn) return { id: `pn:${f.pn.kind}`, level: f.pn.level, kind: f.pn.kind, start: f.pn.start };
    if (f.ls == null || f.ls <= 0) return null;
    const listid = this.overrides.find((o) => o.ls === f.ls)?.listid;
    const def = this.listDefs.find((d) => d.id != null && d.id === listid);
    const lvl = def?.levels[f.ilvl] || def?.levels[0];
    // Without a list table, guess from the rendered number ("1.", "a)", "iv.").
    const kind = lvl ? (lvl.nfc === 23 || lvl.nfc === 255 ? 'ul' : 'ol') : /^\s*(\d+|[a-z]|[ivxlcdm]+)[.)]/i.test(p.listText) ? 'ol' : 'ul';
    return { id: `ls:${f.ls}`, level: f.ilvl, kind, start: lvl?.start ?? 1 };
  }

  /** One paragraph → items for assemble(): { html, list?, task?, quote?, code? }. */
  paragraphItems(p, ctx) {
    const f = p.para;
    const out = [];
    if (f.pagebb && !f.intbl) out.push({ html: '<div data-page-break></div>' });
    const style = this.styles.get(f.s);
    const sname = (style?.name || '').toLowerCase();
    let level = Number(/^heading\s*([1-6])$/.exec(sname)?.[1]) || 0;
    if (!level) {
      const outline = f.outline ?? style?.para.outline;
      if (outline != null && outline >= 0 && outline <= 5) level = outline + 1;
    }
    const named = !level ? PARAGRAPH_STYLE_IDS[sname] : null;
    const quote = !level && QUOTE_STYLES.has(sname);
    const code = !level && CODE_STYLES.has(sname);
    // Headings and named styles look right from LibreWord's own CSS, so only
    // formatting that differs from the style definition is kept.
    const styled = level || named || quote || code ? style : null;
    const sp = styled?.para || {};
    const list = level ? null : this.listInfo(p);

    if (code) {
      const text = p.segs.map((s) => (s.br ? '\n' : s.text || '')).join('');
      out.push({ code: true, text });
      return out;
    }
    const hasContent = p.segs.some((s) => s.img || s.br || (s.text && s.text.trim()));
    if (f.border && !hasContent && !list) {
      out.push({ html: '<hr>' });
      return out;
    }

    // LibreWord exports checklists as ☐/☒ paragraphs; turn them back into checklists.
    let segs = p.segs;
    let task = null;
    const first = segs[0];
    if (!list && !level && first?.text && /^[☐☒]\s/.test(first.text)) {
      task = { checked: first.text[0] === '☒' };
      segs = [{ ...first, text: first.text.replace(/^[☐☒]\s/, '') }, ...segs.slice(1)];
    }

    const css = [];
    if (f.align && f.align !== sp.align) css.push(`text-align: ${f.align}`);
    if (f.slmult && f.sl > 0 && !(f.sl === sp.sl && sp.slmult)) {
      const lh = Math.round((f.sl / 240) * 100) / 100;
      if (Math.abs(lh - 1.15) > 0.01) css.push(`line-height: ${lh}`);
    }
    if (f.sb > 0 && f.sb !== sp.sb) css.push(`padding-top: ${f.sb / 20}pt`);
    if (f.sa != null && f.sa !== sp.sa && Math.abs(f.sa / 20 - 8) > 0.01) css.push(`margin-bottom: ${f.sa / 20}pt`);
    if (!list && !task && !quote) {
      if (f.li > 0 && f.li !== sp.li) css.push(`margin-left: ${Math.round(f.li / TWIPS_PER_PX)}px`);
      if (f.fi && f.fi !== sp.fi) css.push(`text-indent: ${Math.round(f.fi / TWIPS_PER_PX)}px`);
    }
    const textSegs = segs.filter((s) => s.text && s.text.trim());
    const isMono = (s) => MONO_FONTS.test(this.fonts.get(s.fmt.f)?.name || '');
    // Monospaced runs are inline code, unless the whole paragraph is monospaced (a typescript).
    const monoAsCode = textSegs.some(isMono) && !textSegs.every(isMono);
    const inline = this.inlineHtml(segs, { strip: styled?.char, header: ctx.header, monoAsCode });
    const styleAttr = css.length ? ` style="${css.join('; ')}"` : '';
    const tag = level ? `h${level}` : 'p';
    const dataStyle = named ? ` data-style="${named}"` : '';
    out.push({ html: `<${tag}${dataStyle}${styleAttr}>${inline}</${tag}>`, list, task, quote });
    return out;
  }

  inlineHtml(segs, ctx) {
    let html = '';
    let i = 0;
    while (i < segs.length) {
      const link = segs[i].link;
      let inner = '';
      while (i < segs.length && segs[i].link === link) inner += this.segHtml(segs[i++], ctx, Boolean(link));
      html += link ? `<a href="${esc(link)}">${inner}</a>` : inner;
    }
    return html;
  }

  segHtml(seg, ctx, inLink) {
    if (seg.br) return '<br>';
    if (seg.img) return seg.img;
    if (!seg.text) return '';
    const f = seg.fmt;
    const strip = ctx.strip || {};
    const fontName = f.f != null ? this.fonts.get(f.f)?.name : null;
    const code = ctx.monoAsCode && MONO_FONTS.test(fontName || '');
    let out = esc(seg.text);
    if (code) out = `<code>${out}</code>`;
    if (f.sup) out = `<sup>${out}</sup>`;
    if (f.sub) out = `<sub>${out}</sub>`;
    if (f.strike) out = `<s>${out}</s>`;
    // Links get their underline and colour from LibreWord's CSS.
    if (f.ul && !inLink && !strip.ul) out = `<u>${out}</u>`;
    if (f.i && !strip.i) out = `<em>${out}</em>`;
    // Bold that comes from the heading style is dropped by `strip`; header rows are bold anyway.
    if (f.b && !strip.b && !ctx.header) out = `<strong>${out}</strong>`;
    const css = [];
    const color = f.cf && f.cf !== strip.cf && !inLink ? this.colors[f.cf] : null;
    if (color) css.push(`color: ${color}`);
    if (f.fs && f.fs !== strip.fs && f.fs !== 22) css.push(`font-size: ${f.fs / 2}pt`);
    const font = !code && f.f !== strip.f ? fontName?.replace(/['"\\;{}<>]/g, '').trim() : null;
    if (font && !DEFAULT_FONT.test(font)) css.push(`font-family: ${esc(font.includes(' ') ? `'${font}'` : font)}`);
    if (css.length) out = `<span style="${css.join('; ')}">${out}</span>`;
    const hl = f.hl && f.hl !== strip.hl ? this.colors[f.hl] : null;
    if (hl && hl !== '#ffffff') out = `<mark data-color="${hl}" style="background-color: ${hl}">${out}</mark>`;
    return out;
  }

  tableHtml(table) {
    // Cell edges in twips; a cell's left edge is the previous cell's \cellx.
    const rows = table.rows.map((row) => {
      const defs = row.def.cells;
      let left = row.def.left || 0;
      const cells = [];
      row.cells.forEach((paras, ci) => {
        const d = defs[ci] || {};
        const right = d.right ?? null;
        if (d.clmrg && cells.length) {
          // Legacy horizontal merge: widen the previous cell, drop this one.
          if (right != null) cells[cells.length - 1].right = right;
          left = right ?? left;
          return;
        }
        cells.push({ paras, left: right != null ? left : null, right, bg: d.bg, vfirst: d.clvmgf, vmerge: d.clvmrg, header: row.def.header });
        if (right != null) left = right;
      });
      return cells;
    });
    // Column grid: the union of every row's cell edges (close edges snap together).
    const edges = [];
    for (const row of rows) {
      for (const c of row) {
        if (c.right == null) continue;
        for (const x of [c.left, c.right]) if (!edges.some((e) => Math.abs(e - x) <= 20)) edges.push(x);
      }
    }
    edges.sort((a, b) => a - b);
    const edgeIndex = (x) => {
      let best = 0;
      edges.forEach((e, i) => { if (Math.abs(e - x) < Math.abs(edges[best] - x)) best = i; });
      return best;
    };
    for (const row of rows) {
      let col = 0;
      for (const c of row) {
        if (c.right != null && edges.length > 1) {
          c.col = edgeIndex(c.left);
          c.span = Math.max(1, edgeIndex(c.right) - c.col);
        } else {
          c.col = col;
          c.span = 1;
        }
        col = c.col + c.span;
      }
    }
    // Vertical merges become rowspans.
    rows.forEach((row, ri) => {
      for (const c of row) {
        if (!c.vfirst) continue;
        c.rowspan = 1;
        for (let rj = ri + 1; rj < rows.length; rj++) {
          const below = rows[rj].find((b) => b.col === c.col);
          if (!below?.vmerge || below.vfirst) break;
          below.skip = true;
          c.rowspan++;
        }
      }
    });
    let html = '<table><tbody>';
    for (const row of rows) {
      html += '<tr>';
      for (const c of row) {
        if (c.skip) continue;
        const tag = c.header ? 'th' : 'td';
        const widths = c.right != null && edges.length > 1
          ? Array.from({ length: c.span }, (_, k) => Math.round((edges[c.col + k + 1] - edges[c.col + k]) / TWIPS_PER_PX))
          : [];
        const bg = c.bg ? this.colors[c.bg] : null;
        const attrs = [
          c.span > 1 ? ` colspan="${c.span}"` : '',
          c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : '',
          widths.length && widths.every((w) => w > 0) ? ` colwidth="${widths.join(',')}"` : '',
          bg ? ` style="background-color: ${bg}"` : '',
        ].join('');
        const inner = assemble(c.paras.flatMap((p) => this.paragraphItems(p, { header: c.header })));
        html += `<${tag}${attrs}>${inner || '<p></p>'}</${tag}>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }
}

/** Group list paragraphs into nested lists, checklists, quotes and code blocks. */
function assemble(items) {
  let html = '';
  const counters = new Map();
  let i = 0;
  while (i < items.length) {
    const b = items[i];
    if (b.task) {
      html += '<ul data-type="taskList">';
      while (i < items.length && items[i].task) {
        html += `<li data-type="taskItem" data-checked="${items[i].task.checked}">${items[i].html}</li>`;
        i++;
      }
      html += '</ul>';
    } else if (b.code) {
      const lines = [];
      while (i < items.length && items[i].code) lines.push(items[i++].text);
      html += `<pre><code>${esc(lines.join('\n'))}</code></pre>`;
    } else if (b.list) {
      const run = [];
      while (i < items.length && items[i].list) run.push(items[i++]);
      html += buildList(run, counters);
    } else if (b.quote) {
      let inner = '';
      while (i < items.length && items[i].quote && !items[i].list) inner += items[i++].html;
      html += `<blockquote>${inner}</blockquote>`;
    } else {
      html += b.html;
      i++;
    }
  }
  return html;
}

/** Nest consecutive list paragraphs by level, as docx-import's buildList does. */
function buildList(items, counters) {
  let html = '';
  const stack = []; // open lists, innermost last: { tag, level, id, hasItem }
  for (const it of items) {
    const { level, id, kind, start } = it.list;
    const key = `${id}:${level}`;
    while (stack.length && stack[stack.length - 1].level > level) html += `</li></${stack.pop().tag}>`;
    let top = stack[stack.length - 1];
    if (top && top.level === level && top.id !== id) {
      html += `</li></${stack.pop().tag}>`;
      top = null;
    }
    if (!top || top.level < level) {
      const first = kind === 'ol' ? (counters.get(key) ?? start) : 1;
      html += `<${kind}${first !== 1 ? ` start="${first}"` : ''}>`;
      top = { tag: kind, level, id, hasItem: false };
      stack.push(top);
    }
    if (top.hasItem) html += '</li>';
    html += `<li>${it.html}`;
    top.hasItem = true;
    counters.set(key, (counters.get(key) ?? start) + 1);
    // A new item restarts the numbering of the levels below it.
    for (const k of [...counters.keys()]) {
      const [kid, kl] = [k.slice(0, k.lastIndexOf(':')), Number(k.slice(k.lastIndexOf(':') + 1))];
      if (kid === id && kl > level) counters.delete(k);
    }
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/**
 * Convert an RTF document into LibreWord HTML.
 * @param {string|ArrayBuffer|Uint8Array} rtf the file's text, or its raw bytes
 *   (then bytes above 0x7F are read in the document's code page).
 * @returns {{ html: string, title: string }}
 * @throws {Error} when the input isn't RTF at all.
 */
export function rtfToHtml(rtf) {
  let src = rtf;
  let binary = false;
  if (rtf instanceof ArrayBuffer || ArrayBuffer.isView(rtf)) {
    const bytes = rtf instanceof ArrayBuffer ? new Uint8Array(rtf) : new Uint8Array(rtf.buffer, rtf.byteOffset, rtf.byteLength);
    src = '';
    for (let i = 0; i < bytes.length; i += 0x8000) src += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    binary = true;
  }
  src = String(src ?? '').replace(/^\uFEFF/, '');
  if (!/^\s*\{\\rtf/.test(src)) throw Object.assign(new Error('This file is not in Rich Text Format.'), { code: 'not-rtf' });
  const reader = new RtfReader(src);
  reader.binary = binary;
  try {
    reader.run();
  } catch (err) {
    // Malformed input: keep whatever was read before the problem.
    console.warn('RTF import stopped early', err);
  }
  let html;
  try {
    html = reader.html();
  } catch (err) {
    console.warn('RTF import could not lay out the document', err);
    html = reader.blocks.filter((b) => b.para).map((b) => `<p>${esc(b.para.segs.map((s) => s.text || '').join(''))}</p>`).join('') || '<p></p>';
  }
  return { html, title: reader.title.replace(/\s+/g, ' ').trim() };
}

// ================================================================== writer

const NAMED_COLORS = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', orange: 'FFA500',
  purple: '800080', gray: '808080', grey: '808080', pink: 'FFC0CB', cyan: '00FFFF', magenta: 'FF00FF', lime: '00FF00',
  navy: '000080', teal: '008080', maroon: '800000', olive: '808000', silver: 'C0C0C0', brown: 'A52A2A',
};

/** CSS colour → 'RRGGBB' (same rules as docx.js). */
function cssColorToHex(value) {
  if (!value) return undefined;
  const v = String(value).trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return m[1].split('').map((c) => c + c).join('').toUpperCase();
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return m[1].toUpperCase();
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (m) return [m[1], m[2], m[3]].map((n) => Math.min(255, +n).toString(16).padStart(2, '0')).join('').toUpperCase();
  return undefined;
}

function fontSizeToHalfPoints(value) {
  if (!value) return undefined;
  const v = String(value).trim();
  // Bare numbers are points; anything else is a CSS length (px, pt, em, rem…).
  const pt = /^[\d.]+$/.test(v) ? parseFloat(v) : (cssLengthToPx(v) ?? NaN) * 0.75;
  if (!(pt > 0)) return undefined;
  return Math.round(pt * 2);
}

const firstFont = (stack) => (stack ? stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '') : undefined);

/**
 * Escape text for RTF: specials get a backslash, everything outside ASCII is
 * written as \uN? (signed 16-bit; characters beyond the BMP as their two
 * UTF-16 surrogates), so the file is pure 7-bit ASCII.
 */
export function rtfText(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c === 0x5c || c === 0x7b || c === 0x7d) out += `\\${str[i]}`;
    else if (c === 9) out += '\\tab ';
    else if (c === 10) out += '\\line ';
    else if (c === 0xa0) out += '\\~';
    else if (c < 0x20) continue;
    else if (c < 0x80) out += str[i];
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return out;
}

// Word's highlighter colours (others don't survive \highlight).
const HIGHLIGHTER = new Set(['FFFF00', '00FF00', '00FFFF', 'FF00FF', '0000FF', 'FF0000', '000080', '008080', '008000', '800080', '800000', '808000', '808080', 'C0C0C0', '000000']);
const BULLETS = ['•', '◦', '▪', '•', '◦', '▪', '•', '◦', '▪'];
const ORDERED_NFC = [0, 4, 2]; // decimal, lower letter, lower roman — as docx.js
const HEADINGS = [null,
  { fs: 32, color: '2F5496', sb: 240 }, { fs: 26, color: '2F5496', sb: 40 }, { fs: 24, color: '1F3763', sb: 40 },
  { fs: 22, color: '2F5496', sb: 40, i: true }, { fs: 22, color: '2F5496', sb: 40 }, { fs: 22, color: '1F3763', sb: 40 },
];
// Paragraph style numbers (\sN) in the stylesheet below.
const S = { normal: 0, title: 7, subtitle: 8, quote: 9, 'intense-quote': 10, caption: 11, 'no-spacing': 12, blockquote: 13, code: 14 };
const ALIGN = { left: '\\ql', center: '\\qc', right: '\\qr', justify: '\\qj' };
const FONT_BODY = 0;
const FONT_HEADING = 1;
const FONT_CODE = 2;

function lowerLetter(n) {
  let s = '';
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) s = String.fromCharCode(97 + ((v - 1) % 26)) + s;
  return s || 'a';
}

function lowerRoman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of table) while (n >= v) { s += r; n -= v; }
  return s;
}

const numberLabel = (n, level) => [String(n), lowerLetter(n), lowerRoman(n)][level % 3];

class RtfWriter {
  constructor(geometry) {
    this.geometry = geometry;
    this.fonts = ['Calibri', 'Calibri Light', 'Consolas'];
    this.colors = []; // 'RRGGBB', written from index 1 (0 is "auto")
    this.lists = []; // list definitions: { id, ordered, start }
    this.bulletList = null;
    this.styles = this.buildStyles();
  }

  font(name) {
    const clean = String(name).replace(/[;{}\\]/g, '').trim();
    if (!clean) return FONT_BODY;
    const i = this.fonts.findIndex((f) => f.toLowerCase() === clean.toLowerCase());
    if (i >= 0) return i;
    this.fonts.push(clean);
    return this.fonts.length - 1;
  }

  color(hex) {
    const i = this.colors.indexOf(hex);
    if (i >= 0) return i + 1;
    this.colors.push(hex);
    return this.colors.length;
  }

  /** Style number → { name, para, char } as RTF control words, repeated on every paragraph that uses it. */
  buildStyles() {
    const styles = {};
    const body = `\\f${FONT_BODY}\\fs22`;
    styles[S.normal] = { name: 'Normal', para: '\\sa160\\sl276\\slmult1', char: body };
    for (let level = 1; level <= 6; level++) {
      const h = HEADINGS[level];
      styles[level] = {
        name: `heading ${level}`,
        para: `\\keepn\\sb${h.sb}\\sa0\\sl259\\slmult1\\outlinelevel${level - 1}`,
        char: `\\f${FONT_HEADING}\\fs${h.fs}\\cf${this.color(h.color)}${h.i ? '\\i' : ''}`,
      };
    }
    styles[S.title] = { name: 'Title', para: '\\sa80\\sl240\\slmult1', char: `\\f${FONT_HEADING}\\fs56` };
    styles[S.subtitle] = { name: 'Subtitle', para: '\\sa160\\sl276\\slmult1', char: `${body}\\cf${this.color('5A5A5A')}` };
    styles[S.quote] = { name: 'Quote', para: '\\qc\\li864\\ri864\\sb200\\sa160\\sl276\\slmult1', char: `${body}\\i\\cf${this.color('404040')}` };
    styles[S['intense-quote']] = { name: 'Intense Quote', para: '\\qc\\li864\\ri864\\sb360\\sa360\\sl276\\slmult1', char: `${body}\\i\\cf${this.color('2F5496')}` };
    styles[S.caption] = { name: 'Caption', para: '\\sa200\\sl240\\slmult1', char: `\\f${FONT_BODY}\\fs18\\i\\cf${this.color('44546A')}` };
    styles[S['no-spacing']] = { name: 'No Spacing', para: '\\sa0\\sl240\\slmult1', char: body };
    styles[S.blockquote] = { name: 'Block Text', para: '\\li720\\ri720\\sa160\\sl276\\slmult1', char: body };
    styles[S.code] = { name: 'Source Code', para: `\\sa0\\sl240\\slmult1\\cbpat${this.color('F5F5F5')}`, char: `\\f${FONT_CODE}\\fs20` };
    this.linkColor = this.color('0563C1');
    this.borderColor = this.color('BFBFBF');
    this.ruleColor = this.color('A6A6A6');
    return styles;
  }

  // ------------------------------------------------------------------ runs
  marks(n, base = '') {
    let props = base;
    for (const m of n.marks || []) {
      switch (m.type) {
        case 'bold': props += '\\b'; break;
        case 'italic': props += '\\i'; break;
        case 'underline': props += '\\ul'; break;
        case 'strike': props += '\\strike'; break;
        case 'subscript': props += '\\sub'; break;
        case 'superscript': props += '\\super'; break;
        case 'code': props += `\\f${FONT_CODE}`; break;
        case 'highlight': {
          // Word and LibreOffice snap \highlight to their 16 highlighter colours,
          // so other colours are written as exact character shading instead.
          const fill = cssColorToHex(m.attrs?.color) || 'FFFF00';
          props += HIGHLIGHTER.has(fill) ? `\\highlight${this.color(fill)}` : `\\chshdng0\\chcbpat${this.color(fill)}`;
          break;
        }
        case 'textStyle': {
          const color = cssColorToHex(m.attrs?.color);
          if (color) props += `\\cf${this.color(color)}`;
          const size = fontSizeToHalfPoints(m.attrs?.fontSize);
          if (size) props += `\\fs${size}`;
          const font = firstFont(m.attrs?.fontFamily);
          if (font) props += `\\f${this.font(font)}`;
          break;
        }
        default: break; // links are fields (see runs()); comments aren't exported
      }
    }
    return props;
  }

  runs(nodes = [], base = '') {
    let out = '';
    const linkOf = (n) => (n.type === 'text' ? n.marks?.find((m) => m.type === 'link')?.attrs?.href : null) || null;
    for (let i = 0; i < nodes.length;) {
      const href = linkOf(nodes[i]);
      if (href) {
        // Consecutive text with the same link becomes one HYPERLINK field.
        let inner = '';
        while (i < nodes.length && linkOf(nodes[i]) === href) inner += this.run(nodes[i++], `${base}\\ul\\cf${this.linkColor}`);
        const target = rtfText(String(href).replace(/"/g, '%22'));
        out += `{\\field{\\*\\fldinst{HYPERLINK "${target}"}}{\\fldrslt{${inner}}}}`;
      } else {
        out += this.run(nodes[i++], base);
      }
    }
    return out;
  }

  run(n, base) {
    if (n.type === 'hardBreak') return '\\line ';
    if (n.type === 'image') return this.image(n);
    if (n.type !== 'text' || !n.text) return '';
    const props = this.marks(n, base);
    return props ? `{${props} ${rtfText(n.text)}}` : rtfText(n.text);
  }

  image(n) {
    const alt = n.attrs?.alt || '';
    const data = dataUrlToBytes(n.attrs?.src);
    const blip = data && { 'image/png': 'pngblip', 'image/jpeg': 'jpegblip', 'image/jpg': 'jpegblip' }[data.mime];
    // RTF readers only reliably show PNG and JPEG; anything else keeps its alt text.
    if (!blip) return alt ? `{\\i ${rtfText(`[${alt}]`)}}` : '';
    const natural = imageSize(data.bytes) || { width: Number(n.attrs?.width) || 100, height: Number(n.attrs?.height) || 100 };
    let width = Number(n.attrs?.width) || natural.width;
    let height = Number(n.attrs?.height) || Math.round((width / natural.width) * natural.height);
    // Fit the text area, keeping the proportions, as the editor shows it.
    const fit = Math.min(1, this.geometry.contentWidth / width, this.geometry.contentHeight / height);
    if (fit < 1) {
      width = Math.round(width * fit);
      height = Math.round(height * fit);
    }
    let hex = '';
    for (let i = 0; i < data.bytes.length; i++) {
      hex += data.bytes[i].toString(16).padStart(2, '0');
      if (i % 64 === 63) hex += '\n';
    }
    const picprop = alt ? `{\\*\\picprop{\\sp{\\sn wzDescription}{\\sv ${rtfText(alt)}}}}` : '';
    return `{\\pict${picprop}\\${blip}\\picw${natural.width}\\pich${natural.height}`
      + `\\picwgoal${Math.round(width * TWIPS_PER_PX)}\\pichgoal${Math.round(height * TWIPS_PER_PX)}\n${hex}}`;
  }

  // ------------------------------------------------------------ paragraphs
  paragraphAttrs(attrs = {}) {
    let out = '';
    if (attrs.textAlign && ALIGN[attrs.textAlign]) out += ALIGN[attrs.textAlign];
    if (attrs.indent) out += `\\li${Math.round(attrs.indent * TWIPS_PER_PX)}`;
    if (attrs.firstLineIndent) out += `\\fi${Math.round(attrs.firstLineIndent * TWIPS_PER_PX)}`;
    if (attrs.spaceBefore != null) out += `\\sb${Math.round(attrs.spaceBefore * 20)}`;
    if (attrs.spaceAfter != null) out += `\\sa${Math.round(attrs.spaceAfter * 20)}`;
    if (attrs.lineHeight && parseFloat(attrs.lineHeight) > 0) out += `\\sl${Math.round(parseFloat(attrs.lineHeight) * 240)}\\slmult1`;
    return out;
  }

  /** \pard…: style, paragraph and base character formatting, ending in a space. */
  paragraphStart(style, ctx, extra = '') {
    const s = this.styles[style];
    return `\\pard\\plain${ctx.inTable ? '\\intbl' : ''}\\s${style}${s.para}${extra}${s.char} `;
  }

  para(rtf) {
    return { rtf, para: true };
  }

  blocks(nodes = [], ctx = {}) {
    const out = [];
    for (const n of nodes) out.push(...this.block(n, ctx));
    return out;
  }

  /** One node → units: { rtf, para: true } (needs a \par or \cell) or { rtf } (complete). */
  block(n, ctx) {
    switch (n.type) {
      case 'paragraph': {
        const style = n.attrs?.styleId && S[n.attrs.styleId] && n.attrs.styleId !== 'normal' ? S[n.attrs.styleId] : ctx.style ?? S.normal;
        const prefix = ctx.taskPrefix ? rtfText(ctx.taskPrefix) : '';
        return [this.para(this.paragraphStart(style, ctx, (ctx.paragraph || '') + this.paragraphAttrs(n.attrs)) + (ctx.listText || '') + prefix + this.runs(n.content, ctx.run))];
      }
      case 'heading': {
        const level = Math.min(6, Math.max(1, n.attrs?.level || 1));
        return [this.para(this.paragraphStart(level, ctx, this.paragraphAttrs(n.attrs)) + this.runs(n.content, ctx.run))];
      }
      case 'blockquote':
        return this.blocks(n.content, { ...ctx, style: S.blockquote });
      case 'codeBlock': {
        const lines = (n.content || []).map((t) => t.text || '').join('').split('\n');
        return lines.map((line) => this.para(this.paragraphStart(S.code, ctx) + rtfText(line)));
      }
      case 'horizontalRule':
        return [this.para(this.paragraphStart(S.normal, ctx, `\\brdrb\\brdrs\\brdrw6\\brsp20\\brdrcf${this.ruleColor}`))];
      case 'pageBreak':
        // Written as \pagebb on the next paragraph by joinUnits(): LibreOffice
        // ignores a \page that directly follows a table row.
        return ctx.inTable ? [] : [{ pageBreak: true }];
      case 'tableOfContents':
        return this.toc(ctx);
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return this.list(n, ctx);
      case 'table':
        return ctx.inTable ? this.flatTable(n, ctx) : [{ rtf: this.table(n) }];
      default:
        return n.content ? this.blocks(n.content, ctx) : [];
    }
  }

  toc(ctx) {
    const entries = [];
    const text = (n) => (n.content || []).map((c) => (c.type === 'text' ? c.text : text(c))).join('');
    const walk = (n) => {
      if (n.type === 'heading') {
        const t = text(n).trim();
        if (t && (n.attrs?.level || 1) <= 3) entries.push({ t, level: n.attrs?.level || 1 });
        return;
      }
      if (n.type !== 'table') (n.content || []).forEach(walk);
    };
    walk(this.doc);
    return [
      this.para(this.paragraphStart(S.normal, ctx, '\\sb240\\sa120') + `{\\f${FONT_HEADING}\\fs32\\cf${this.color('2F5496')} Contents}`),
      ...entries.map((e) => this.para(this.paragraphStart(S.normal, ctx, `\\sa100\\li${220 * (e.level - 1)}`) + rtfText(e.t))),
    ];
  }

  /** A list definition for \listtable; bullets share one, each numbered list gets its own so it restarts. */
  listDef(ordered, start) {
    if (!ordered && this.bulletList) return this.bulletList;
    const def = { id: this.lists.length + 1, ordered, start };
    this.lists.push(def);
    if (!ordered) this.bulletList = def;
    return def;
  }

  list(n, ctx) {
    const level = Math.min(ctx.listLevel ?? 0, 8);
    const ordered = n.type === 'orderedList';
    const start = Number.isInteger(n.attrs?.start) && n.attrs.start >= 0 ? n.attrs.start : 1;
    const def = n.type === 'taskList' ? null : this.listDef(ordered, start);
    const out = [];
    let number = start;
    for (const item of n.content || []) {
      const [first, ...rest] = item.content || [];
      if (first) {
        let itemCtx;
        if (def) {
          const label = ordered ? `${numberLabel(number++, level)}.` : BULLETS[level];
          itemCtx = {
            ...ctx,
            style: S.normal,
            paragraph: `\\ls${def.id}\\ilvl${level}\\fi-360\\li${720 * (level + 1)}`,
            // Shown by readers without list support (WordPad, TextEdit); others use \ls.
            listText: `{\\listtext\\pard\\plain\\f${FONT_BODY}\\fs22 ${rtfText(label)}\\tab}`,
            taskPrefix: null,
          };
        } else {
          itemCtx = { ...ctx, style: S.normal, paragraph: `\\fi-360\\li${360 * (level + 1)}`, taskPrefix: item.attrs?.checked ? '☒ ' : '☐ ' };
        }
        // A list item's first child is a paragraph; anything else is written as it is.
        out.push(...this.block(first, first.type === 'paragraph' ? itemCtx : { ...ctx, listLevel: level }));
      }
      for (const child of rest) {
        const nested = ['bulletList', 'orderedList', 'taskList'].includes(child.type);
        out.push(...this.block(child, nested
          ? { ...ctx, listLevel: level + 1, paragraph: '', listText: '', taskPrefix: null }
          : { ...ctx, paragraph: `\\li${720 * (level + 1)}`, listText: '', taskPrefix: null }));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- tables
  table(n) {
    const rows = n.content || [];
    const firstRow = rows[0]?.content || [];
    const widths = [];
    for (const c of firstRow) {
      const span = c.attrs?.colspan || 1;
      for (let i = 0; i < span; i++) widths.push(c.attrs?.colwidth?.[i] || null);
    }
    const known = widths.filter(Boolean).reduce((a, b) => a + b, 0);
    const unknown = widths.filter((w) => !w).length;
    const fill = unknown ? Math.max(36, (this.geometry.contentWidth - known) / unknown) : 0;
    const colTwips = widths.map((w) => Math.round((w || fill) * TWIPS_PER_PX));
    const fallback = Math.round(Math.max(36, fill || this.geometry.contentWidth / Math.max(1, widths.length)) * TWIPS_PER_PX);
    // Right edge of column k (exclusive), extending the grid for rows wider than the first.
    const edge = (k) => {
      let x = 0;
      for (let i = 0; i < k; i++) x += colTwips[i] ?? fallback;
      return x;
    };
    // Leading rows of header cells repeat at the top of each page, as in the editor.
    let headerRows = 0;
    while (headerRows < rows.length - 1 && (rows[headerRows].content || []).length && rows[headerRows].content.every((c) => c.type === 'tableHeader')) headerRows++;

    const border = `\\brdrs\\brdrw4\\brdrcf${this.borderColor}`;
    const cellBorders = `\\clbrdrt${border}\\clbrdrl${border}\\clbrdrb${border}\\clbrdrr${border}`;
    const carried = []; // rowspans still open: { col, span, rowsLeft, bg }
    let out = '';
    rows.forEach((row, ri) => {
      const cells = []; // { col, span, first, merged, bg, content }
      let col = 0;
      const takeCarried = () => {
        for (;;) {
          const c = carried.find((x) => x.col === col && x.rowsLeft > 0);
          if (!c) return;
          cells.push({ col, span: c.span, merged: true, bg: c.bg });
          c.rowsLeft--;
          col += c.span;
        }
      };
      for (const cell of row.content || []) {
        takeCarried();
        const span = Math.max(1, cell.attrs?.colspan || 1);
        const rowspan = Math.max(1, cell.attrs?.rowspan || 1);
        const bg = cssColorToHex(cell.attrs?.backgroundColor);
        cells.push({ col, span, first: rowspan > 1, bg, node: cell });
        if (rowspan > 1) carried.push({ col, span, rowsLeft: rowspan - 1, bg });
        col += span;
      }
      takeCarried();
      // Any rowspan reaching past the last cell of this row.
      for (const c of carried) {
        if (c.rowsLeft > 0 && c.col >= col) {
          cells.push({ col: c.col, span: c.span, merged: true, bg: c.bg });
          c.rowsLeft--;
        }
      }
      cells.sort((a, b) => a.col - b.col);

      out += `\\trowd\\trgaph108\\trleft0${ri < headerRows ? '\\trhdr' : ''}`;
      for (const c of cells) {
        out += `${c.first ? '\\clvmgf' : c.merged ? '\\clvmrg' : ''}${cellBorders}${c.bg ? `\\clcbpat${this.color(c.bg)}` : ''}\\cellx${edge(c.col + c.span)}`;
      }
      out += '\n';
      for (const c of cells) {
        const header = c.node?.type === 'tableHeader';
        const units = c.node ? this.blocks(c.node.content, { inTable: true, run: header ? '\\b' : '' }) : [];
        out += joinUnits(units, true, this.paragraphStart(S.normal, { inTable: true }));
      }
      out += '\\row\n';
    });
    return out;
  }

  /** Tables inside table cells are written as tab-separated rows. */
  flatTable(n, ctx) {
    const text = (node) => (node.type === 'text' ? node.text : (node.content || []).map(text).join(node.type === 'tableCell' || node.type === 'tableHeader' ? ' ' : ''));
    return (n.content || []).map((row) => this.para(this.paragraphStart(S.normal, ctx) + rtfText((row.content || []).map(text).join('\t'))));
  }

  // -------------------------------------------------------------- document
  fontTable() {
    const families = ['\\fswiss', '\\fswiss', '\\fmodern'];
    return `{\\fonttbl${this.fonts.map((f, i) => `{\\f${i}${families[i] || '\\fnil'}\\fcharset0 ${rtfText(f)};}`).join('')}}`;
  }

  colorTable() {
    const rgb = (hex) => `\\red${parseInt(hex.slice(0, 2), 16)}\\green${parseInt(hex.slice(2, 4), 16)}\\blue${parseInt(hex.slice(4, 6), 16)};`;
    return `{\\colortbl;${this.colors.map(rgb).join('')}}`;
  }

  styleSheet() {
    const entries = Object.entries(this.styles).map(([n, s]) => {
      const based = Number(n) === S.normal ? '' : '\\sbasedon0';
      const next = Number(n) === S.code || Number(n) === S.blockquote ? `\\snext${n}` : '\\snext0';
      return `{\\s${n}${based}${next}${Number(n) >= 1 && Number(n) <= 6 ? '\\sqformat' : ''}${s.para}${s.char} ${s.name};}`;
    });
    return `{\\stylesheet\n${entries.join('\n')}\n}`;
  }

  listTables() {
    if (!this.lists.length) return '';
    const levels = (def) => Array.from({ length: 9 }, (_, l) => {
      const indent = `\\fi-360\\li${720 * (l + 1)}\\lin${720 * (l + 1)}`;
      if (!def.ordered) {
        return `{\\listlevel\\levelnfc23\\levelnfcn23\\leveljc0\\leveljcn0\\levelfollow0\\levelstartat1`
          + `{\\leveltext\\'01${rtfText(BULLETS[l])};}{\\levelnumbers;}${indent}}`;
      }
      const nfc = ORDERED_NFC[l % 3];
      return `{\\listlevel\\levelnfc${nfc}\\levelnfcn${nfc}\\leveljc0\\leveljcn0\\levelfollow0\\levelstartat${def.start}`
        + `{\\leveltext\\'02\\'0${l}.;}{\\levelnumbers\\'01;}${indent}}`;
    }).join('');
    const lists = this.lists.map((def) => `{\\list\\listtemplateid${def.id}\\listhybrid${levels(def)}{\\listname ;}\\listid${def.id}}`);
    const overrides = this.lists.map((def) => `{\\listoverride\\listid${def.id}\\listoverridecount0\\ls${def.id}}`);
    return `{\\*\\listtable\n${lists.join('\n')}}\n{\\*\\listoverridetable${overrides.join('')}}\n`;
  }

  headerFooter(settings) {
    const grey = this.color('595959');
    const start = (align) => `\\pard\\plain${align}\\f${FONT_BODY}\\fs18\\cf${grey} `;
    let out = '';
    if (settings.header) out += `{\\header${start('\\qr')}${rtfText(settings.header)}\\par}\n`;
    if (settings.footer || settings.pageNumbers) {
      let text = settings.footer ? rtfText(settings.footer) : '';
      if (settings.pageNumbers) {
        const field = (instr) => `{\\field{\\*\\fldinst{ ${instr} }}{\\fldrslt{1}}}`;
        text += `${text ? '   ' : ''}Page ${field('PAGE')} of ${field('NUMPAGES')}`;
      }
      out += `{\\footer${start('\\qc')}${text}\\par}\n`;
    }
    return out;
  }
}

/**
 * Join block units into RTF: paragraphs end with \par, or with \cell for the
 * last one in a table cell (which must end in a paragraph).
 */
function joinUnits(units, inCell = false, emptyCell = '') {
  let out = '';
  let breakBefore = false;
  units.forEach((u, i) => {
    const last = i === units.length - 1;
    if (u.pageBreak) {
      breakBefore = true;
      return;
    }
    if (breakBefore) {
      // "Page break before" on the paragraph that starts the new page; a table
      // or the end of the document gets a plain \page instead.
      if (u.para) u = { ...u, rtf: u.rtf.replace(/^\\pard\\plain/, '\\pard\\plain\\pagebb') };
      else out += '\\pard\\plain\\page\n';
      breakBefore = false;
    }
    if (u.para) out += `${u.rtf}${inCell && last ? '\\cell' : '\\par'}\n`;
    else out += `${u.rtf}\n`;
  });
  if (breakBefore) out += '\\pard\\plain\\page\n';
  if (inCell && (!units.length || !units[units.length - 1].para)) out += `${emptyCell}\\cell\n`;
  return out;
}

const FALLBACK_SETTINGS = { pageSize: 'letter', orientation: 'portrait', margins: { top: 96, right: 96, bottom: 96, left: 96 } };

/**
 * Write the editor's ProseMirror JSON as an RTF document.
 * @param {object} json `editor.getJSON()`
 * @param {{ title?: string, settings?: object }} options page settings as
 *   stored with the document (page size, orientation, margins, header,
 *   footer, page numbers).
 * @returns {string} 7-bit ASCII RTF
 */
export function jsonToRtf(json, { title = '', settings } = {}) {
  settings = { ...FALLBACK_SETTINGS, ...(settings || {}) };
  settings.margins = { ...FALLBACK_SETTINGS.margins, ...(settings.margins || {}) };
  const geometry = pageGeometry(settings);
  const writer = new RtfWriter(geometry);
  writer.doc = json || { type: 'doc', content: [] };
  const units = writer.blocks(writer.doc.content || []);
  const body = joinUnits(units.length ? units : [writer.para(writer.paragraphStart(S.normal, {}))]);
  const headerFooter = writer.headerFooter(settings);
  const twips = (px) => Math.round(px * TWIPS_PER_PX);
  const m = settings.margins;
  // pageGeometry() already swaps width and height for landscape.
  const page = `\\paperw${twips(geometry.width)}\\paperh${twips(geometry.height)}\\margl${twips(m.left)}\\margr${twips(m.right)}`
    + `\\margt${twips(m.top)}\\margb${twips(m.bottom)}${settings.orientation === 'landscape' ? '\\landscape' : ''}`;
  const section = `\\sectd\\pgwsxn${twips(geometry.width)}\\pghsxn${twips(geometry.height)}\\marglsxn${twips(m.left)}\\margrsxn${twips(m.right)}`
    + `\\margtsxn${twips(m.top)}\\margbsxn${twips(m.bottom)}\\headery708\\footery708${settings.orientation === 'landscape' ? '\\lndscpsxn' : ''}`;
  return [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033\\uc1',
    writer.fontTable(),
    writer.colorTable(),
    writer.styleSheet(),
    writer.listTables() + '{\\*\\generator LibreWord;}',
    `{\\info{\\title ${rtfText(String(title || ''))}}}`,
    `${page}\\widowctrl\\viewkind1`,
    section,
    headerFooter + body + '}',
  ].join('\n');
}
