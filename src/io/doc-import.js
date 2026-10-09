/**
 * Native reader for legacy Word 97–2003 binary documents (.doc).
 *
 * A .doc is an OLE Compound File (CFB) holding several streams. The
 * WordDocument stream starts with the FIB, which points into the table stream
 * (0Table or 1Table) where the piece table (CLX), the formatting tables
 * (CHPX/PAPX FKP bin tables), the style sheet (STSH), the font table and the
 * list tables live. This module reads all of that and produces the same HTML
 * flavour as docx-import.js: paragraphs, headings, bold/italic/underline/
 * strike/colour/size/font runs, alignment, lists, tables (with merged cells),
 * line and page breaks and hyperlinks. Pictures, footnotes, headers/footers
 * and comments are not imported.
 *
 * References: [MS-CFB] and [MS-DOC] (structure names below follow the spec).
 */
import { escapeHtml } from '../ui/dom.js';

const esc = escapeHtml;

/** An Error with a machine-readable `code`, so the caller can pick a message. */
const docError = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------- byte helpers
// Bounds-checked little-endian reads: out-of-range reads return 0 instead of
// throwing, and every length read from the file is clamped before use.
const u8 = (b, o) => (o >= 0 && o < b.length ? b[o] : 0);
const u16 = (b, o) => (o >= 0 && o + 1 < b.length ? b[o] | (b[o + 1] << 8) : 0);
const u32 = (b, o) => (o >= 0 && o + 3 < b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);
const i16 = (b, o) => (u16(b, o) << 16) >> 16;
const i32 = (b, o) => u32(b, o) | 0;
const slice = (b, start, len) => b.subarray(Math.max(0, Math.min(start, b.length)), Math.max(0, Math.min(start + len, b.length)));
const utf16 = (b, o, chars) => {
  let s = '';
  for (let i = 0; i < chars && o + i * 2 + 1 < b.length; i++) s += String.fromCharCode(u16(b, o + i * 2));
  return s;
};

// Windows-1252 code points for bytes 0x80–0x9F (the rest map to themselves).
// [MS-DOC] uses this table for "compressed" (8-bit) text pieces.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];
const cp1252 = (byte) => (byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : byte);
const decode1252 = (b) => String.fromCharCode(...Array.from(b, cp1252));

// ---------------------------------------------------------------- CFB container
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAXREGSECT = 0xfffffffa; // larger sector numbers are markers (free, end of chain…)

/**
 * Read an OLE Compound File and return its top-level streams by name.
 * Handles 512- and 4096-byte sectors, the DIFAT, the mini FAT and mini stream.
 */
function readCfb(bytes) {
  if (bytes.length < 512 || !CFB_SIGNATURE.every((v, i) => bytes[i] === v)) {
    const head = decode1252(slice(bytes, 0, 8));
    if (head.startsWith('{\\rtf')) throw docError('rtf', 'This .doc file is really an RTF document.');
    if (head.startsWith('PK')) throw docError('docx', 'This .doc file is really a .docx (Word 2007+) document.');
    throw docError('not-cfb', 'This is not a Word 97–2003 document (no OLE compound file header).');
  }
  const shift = u16(bytes, 0x1e);
  if (shift !== 9 && shift !== 12) throw docError('corrupt', 'Unsupported or damaged compound file (bad sector size).');
  const sectorSize = 1 << shift;
  const miniShift = u16(bytes, 0x20);
  const miniSize = miniShift > 0 && miniShift < shift ? 1 << miniShift : 64;
  const miniCutoff = u32(bytes, 0x38) || 4096;
  const sectorCount = Math.ceil((bytes.length - sectorSize) / sectorSize);
  const sector = (n) => slice(bytes, (n + 1) * sectorSize, sectorSize);
  const perSector = sectorSize / 4;

  // FAT sector list: 109 entries in the header, then a chain of DIFAT sectors.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(bytes, 0x4c + i * 4);
    if (s < MAXREGSECT && s < sectorCount) fatSectors.push(s);
  }
  const seenDifat = new Set();
  for (let d = u32(bytes, 0x44); d < MAXREGSECT && d < sectorCount && !seenDifat.has(d);) {
    seenDifat.add(d);
    const sec = sector(d);
    for (let i = 0; i < perSector - 1; i++) {
      const s = u32(sec, i * 4);
      if (s < MAXREGSECT && s < sectorCount) fatSectors.push(s);
    }
    d = u32(sec, (perSector - 1) * 4);
  }
  const fat = new Uint32Array(fatSectors.length * perSector).fill(0xffffffff);
  fatSectors.forEach((s, k) => {
    const sec = sector(s);
    for (let i = 0; i < perSector; i++) if (i * 4 + 3 < sec.length) fat[k * perSector + i] = u32(sec, i * 4);
  });

  /** Concatenate a sector chain (guarded against loops and out-of-range links). */
  const readChain = (table, start, size, unit, getUnit) => {
    const chunks = [];
    let total = 0;
    const seen = new Set();
    for (let s = start; s < MAXREGSECT && s < table.length && !seen.has(s) && total < size;) {
      seen.add(s);
      const chunk = getUnit(s);
      if (!chunk.length) break;
      chunks.push(chunk);
      total += chunk.length;
      s = table[s];
    }
    const out = new Uint8Array(Math.min(total, size));
    let pos = 0;
    for (const c of chunks) {
      if (pos >= out.length) break;
      out.set(c.subarray(0, out.length - pos), pos);
      pos += c.length;
    }
    return out;
  };
  const regular = (start, size) => readChain(fat, start, size, sectorSize, sector);

  // Directory: 128-byte entries. Entry 0 is the root storage, whose stream is the mini stream.
  const dir = regular(u32(bytes, 0x30), Infinity);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = Math.min(u16(dir, o + 0x40), 64);
    entries.push({
      name: utf16(dir, o, Math.max(0, nameLen / 2 - 1)),
      type: dir[o + 0x42],
      left: u32(dir, o + 0x44),
      right: u32(dir, o + 0x48),
      child: u32(dir, o + 0x4c),
      start: u32(dir, o + 0x74),
      // Version 3 files (512-byte sectors) may leave garbage in the high size word.
      size: shift === 9 ? u32(dir, o + 0x78) : u32(dir, o + 0x78) + u32(dir, o + 0x7c) * 2 ** 32,
    });
  }
  const root = entries[0];
  if (!root || root.type !== 5) throw docError('corrupt', 'Damaged compound file (no root directory entry).');
  const miniStream = regular(root.start, root.size);
  const miniFatBytes = regular(u32(bytes, 0x3c), u32(bytes, 0x40) * sectorSize);
  const miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = u32(miniFatBytes, i * 4);
  const miniSector = (n) => slice(miniStream, n * miniSize, miniSize);

  // Top-level streams only: embedded objects carry their own "WordDocument" streams.
  const streams = new Map();
  const stack = [root.child];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id >= entries.length || seen.has(id)) continue;
    seen.add(id);
    const e = entries[id];
    stack.push(e.left, e.right);
    if (e.type !== 2) continue;
    streams.set(e.name, () => (e.size < miniCutoff ? readChain(miniFat, e.start, e.size, miniSize, miniSector) : regular(e.start, e.size)));
  }
  return { stream: (name) => streams.get(name)?.() ?? null };
}

// ---------------------------------------------------------------- sprms
/** Operand size of a sprm at `i` (just past its 2-byte opcode), from its spra bits. */
function operandSize(sprm, b, i) {
  switch (sprm >> 13) {
    case 0:
    case 1:
      return 1;
    case 2:
    case 4:
    case 5:
      return 2;
    case 3:
      return 4;
    case 7:
      return 3;
    default: // 6: variable length
      // sprmTDefTable(10): a 2-byte count that is one more than the bytes that follow it.
      if (sprm === 0xd608 || sprm === 0xd606) return 2 + Math.max(0, u16(b, i) - 1);
      // sprmPChgTabs: 255 means "compute from the tab counts".
      if (sprm === 0xc615 && u8(b, i) === 255) {
        const del = u8(b, i + 1);
        const add = u8(b, i + 2 + del * 4);
        return 1 + 1 + del * 4 + 1 + add * 3;
      }
      return 1 + u8(b, i);
  }
}

/** Call fn(sprm, operandOffset, operandSize) for every sprm in a grpprl. */
function eachSprm(b, fn) {
  let i = 0;
  while (i + 2 <= b.length) {
    const sprm = u16(b, i);
    i += 2;
    const size = operandSize(sprm, b, i);
    if (i + size > b.length) break;
    fn(sprm, i, size);
    i += size;
  }
}

// Word's 16-colour palette (ico), index 0 = auto.
const ICO = [null, '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#ffff00', '#ffffff',
  '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0'];
const hex2 = (n) => n.toString(16).padStart(2, '0');

/**
 * Apply character sprms to `props`. Toggle properties (bold…) can say "same
 * as" (0x80) or "opposite of" (0x81) the style's value, so `base` is the style.
 */
function applyChp(props, grpprl, base) {
  const toggle = (key, v) => {
    props[key] = v === 0x80 ? Boolean(base[key]) : v === 0x81 ? !base[key] : Boolean(v);
  };
  eachSprm(grpprl, (sprm, o) => {
    const v = grpprl[o];
    switch (sprm) {
      case 0x0835: toggle('bold', v); break; // sprmCFBold
      case 0x0836: toggle('italic', v); break; // sprmCFItalic
      case 0x0837: toggle('strike', v); break; // sprmCFStrike
      case 0x2a53: toggle('strike', v); break; // sprmCFDStrike
      case 0x083b: toggle('caps', v); break; // sprmCFCaps
      case 0x083c: toggle('hidden', v); break; // sprmCFVanish
      case 0x2a3e: props.underline = v !== 0; break; // sprmCKul
      case 0x4a43: props.size = u16(grpprl, o) / 2; break; // sprmCHps (half-points)
      case 0x2a48: props.sup = v === 1; props.sub = v === 2; break; // sprmCIss
      case 0x2a42: props.ico = ICO[v] ?? null; break; // sprmCIco
      case 0x6870: // sprmCCv: COLORREF (r, g, b, fAuto)
        props.cv = grpprl[o + 3] === 0xff ? null : `#${hex2(grpprl[o])}${hex2(grpprl[o + 1])}${hex2(grpprl[o + 2])}`;
        break;
      case 0x2a0c: props.highlight = ICO[v] ?? null; break; // sprmCHighlight
      case 0x4a4f: props.ftc = u16(grpprl, o); break; // sprmCRgFtc0 (ASCII font)
      case 0x4a30: props.charStyle = u16(grpprl, o); break; // sprmCIstd
      default: break;
    }
  });
  return props;
}

const JC = ['left', 'center', 'right', 'justify', 'justify', 'center', 'justify', 'justify', 'justify', 'justify'];

/** Apply paragraph sprms to `props`. */
function applyPap(props, grpprl) {
  eachSprm(grpprl, (sprm, o, size) => {
    const v = grpprl[o];
    switch (sprm) {
      case 0x2403: // sprmPJc80
      case 0x2461: // sprmPJc
        props.align = JC[v] || 'left';
        break;
      case 0x260a: props.ilvl = v; break; // sprmPIlvl
      case 0x460b: props.ilfo = u16(grpprl, o); break; // sprmPIlfo
      case 0x2416: props.inTable = v !== 0; break; // sprmPFInTable
      case 0x2417: props.ttp = v !== 0; break; // sprmPFTtp (row-end mark)
      case 0x6649: props.itap = i32(grpprl, o); break; // sprmPItap (table depth)
      case 0x244c: props.innerTtp = v !== 0; break; // sprmPFInnerTtp
      case 0x2407: props.pageBreakBefore = v !== 0; break; // sprmPPageBreakBefore
      case 0x2640: props.outline = v; break; // sprmPOutLvl
      case 0xd608: props.tdef = slice(grpprl, o, size); break; // sprmTDefTable
      default: break;
    }
  });
  return props;
}

// ---------------------------------------------------------------- tables in the table stream
/** A PLC: (n + 1) 4-byte positions followed by n `size`-byte data elements. */
function readPlc(b, fc, lcb, size) {
  const avail = Math.min(lcb, Math.max(0, b.length - fc)); // a damaged FIB may claim more than the stream holds
  const n = avail >= 4 ? Math.floor((avail - 4) / (4 + size)) : 0;
  const pos = [];
  for (let i = 0; i <= n; i++) pos.push(u32(b, fc + i * 4));
  const data = (i) => fc + (n + 1) * 4 + i * size;
  return { n, pos, data };
}

/** The piece table: which runs of character positions live where, 8-bit or UTF-16. */
function readPieces(table, fc, lcb) {
  const end = Math.min(fc + lcb, table.length);
  let p = fc;
  // Skip the Prc entries (property modifiers for fast-saved files) to reach the Pcdt.
  while (p < end && table[p] === 0x01) p += 3 + Math.max(0, i16(table, p + 1));
  if (p >= end || table[p] !== 0x02) return null;
  const plc = readPlc(table, p + 5, Math.min(u32(table, p + 1), end - p - 5), 8);
  const pieces = [];
  for (let i = 0; i < plc.n; i++) {
    const raw = u32(table, plc.data(i) + 2);
    const compressed = (raw & 0x40000000) !== 0;
    const fcPiece = raw & 0x3fffffff;
    pieces.push({ cpStart: plc.pos[i], cpEnd: plc.pos[i + 1], fc: compressed ? fcPiece / 2 : fcPiece, compressed });
  }
  return pieces;
}

/**
 * Read a CHPX or PAPX bin table and its 512-byte FKP pages into a sorted list
 * of { start, end, grpprl, istd } runs keyed by file offset (FC).
 */
function readFkpRuns(table, wd, fc, lcb, kind) {
  const plc = readPlc(table, fc, lcb, 4);
  const runs = [];
  const pages = new Set();
  for (let i = 0; i < plc.n; i++) {
    const page = u32(table, plc.data(i)) & 0x3fffff;
    if (pages.has(page)) continue;
    pages.add(page);
    const off = page * 512;
    if (off + 512 > wd.length) continue;
    const count = wd[off + 511];
    for (let k = 0; k < count; k++) {
      const run = { start: u32(wd, off + k * 4), end: u32(wd, off + (k + 1) * 4), grpprl: new Uint8Array(0), istd: 0 };
      if (kind === 'chp') {
        const b = wd[off + (count + 1) * 4 + k];
        if (b) run.grpprl = slice(wd, off + b * 2 + 1, wd[off + b * 2]);
      } else {
        const b = wd[off + (count + 1) * 4 + k * 13];
        if (b) {
          const o = off + b * 2;
          const cb = wd[o];
          const start = cb ? o + 1 : o + 2;
          const len = Math.min(cb ? cb * 2 - 1 : wd[o + 1] * 2, off + 511 - start);
          if (len >= 2) {
            run.istd = u16(wd, start);
            run.grpprl = slice(wd, start + 2, len - 2);
          }
        }
      }
      runs.push(run);
    }
  }
  runs.sort((a, b) => a.start - b.start);
  runs.forEach((r, i) => { r.id = i; }); // stable ids for caching resolved properties
  return {
    /** The run containing file offset `pos`, or null. */
    find(pos) {
      let lo = 0;
      let hi = runs.length - 1;
      let hit = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (runs[mid].start <= pos) {
          hit = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return hit >= 0 && pos < runs[hit].end ? runs[hit] : null;
    },
  };
}

/** The style sheet (STSH): one entry per istd with its base style and property grpprls. */
function readStyles(table, fc, lcb) {
  const b = slice(table, fc, lcb);
  const cbStshi = u16(b, 0);
  const cstd = u16(b, 2);
  const cbStdBase = u16(b, 4) || 10;
  const ftcAsci = u16(b, 2 + 12);
  const styles = [];
  let p = 2 + cbStshi;
  for (let istd = 0; istd < cstd && p + 2 <= b.length; istd++) {
    const cb = u16(b, p);
    const std = slice(b, p + 2, cb);
    p += 2 + cb;
    if (cb < 10) {
      styles.push(null);
      continue;
    }
    const style = { sti: u16(std, 0) & 0x0fff, stk: u16(std, 2) & 0x000f, base: u16(std, 2) >> 4, papx: null, chpx: null };
    const cupx = u16(std, 4) & 0x000f;
    let q = cbStdBase;
    const cch = u16(std, q);
    style.name = utf16(std, q + 2, cch);
    q += 2 + cch * 2 + 2;
    // UPXs: paragraph styles have (istd + PAPX grpprl) then CHPX; character styles only CHPX.
    for (let k = 0; k < cupx && q + 2 <= std.length; k++) {
      const cbUpx = u16(std, q);
      const upx = slice(std, q + 2, cbUpx);
      q += 2 + cbUpx + (cbUpx & 1);
      if (style.stk === 1 && k === 0) style.papx = upx.subarray(2);
      else if ((style.stk === 1 && k === 1) || (style.stk === 2 && k === 0)) style.chpx = upx;
    }
    styles.push(style);
  }
  return { styles, ftcAsci };
}

/** Font names (SttbfFfn) by font index (ftc). */
function readFonts(table, fc, lcb) {
  const b = slice(table, fc, lcb);
  const fonts = [];
  let count = u16(b, 0);
  let p = 4;
  if (count === 0xffff) {
    count = u16(b, 2);
    p = 6;
  }
  for (let i = 0; i < count && p < b.length; i++) {
    const len = b[p];
    const ffn = slice(b, p + 1, len);
    let name = '';
    for (let o = 39; o + 1 < ffn.length; o += 2) {
      const c = u16(ffn, o);
      if (!c) break;
      name += String.fromCharCode(c);
    }
    fonts.push(name);
    p += 1 + len;
  }
  return fonts;
}

const NFC_BULLET = 23;
const NFC_NONE = 255;

/** List definitions: ilfo (1-based LFO index) → { lists by level: { tag, start } }. */
function readLists(table, fib) {
  const lst = fib.fcLcb(73);
  const lfo = fib.fcLcb(74);
  const byLsid = new Map();
  if (lst.lcb >= 2) {
    const count = Math.min(Math.max(0, i16(table, lst.fc)), 4096);
    let p = lst.fc + 2 + count * 28; // the LVLs follow all the LSTFs
    for (let i = 0; i < count && p < table.length; i++) {
      const f = lst.fc + 2 + i * 28;
      const simple = (table[f + 26] & 1) !== 0;
      const levels = [];
      for (let l = 0; l < (simple ? 1 : 9) && p + 28 <= table.length; l++) {
        const nfc = table[p + 4];
        levels.push({ tag: nfc === NFC_BULLET || nfc === NFC_NONE ? 'ul' : 'ol', start: i32(table, p) });
        const cbChpx = table[p + 24];
        const cbPapx = table[p + 25];
        p += 28 + cbPapx + cbChpx;
        p += 2 + u16(table, p) * 2; // xst: the number text
      }
      byLsid.set(i32(table, f), levels);
    }
  }
  const lfos = [];
  if (lfo.lcb >= 4) {
    const count = Math.min(u32(table, lfo.fc), 4096);
    for (let i = 0; i < count; i++) lfos.push(byLsid.get(i32(table, lfo.fc + 4 + i * 16)) || null);
  }
  return {
    /** { tag, start } for a paragraph's list, or null when it isn't in one. */
    get(ilfo, ilvl) {
      if (!ilfo || ilfo > 0x7ff) return null; // 0 = none; 0xF801… = "no numbering" overrides
      const levels = lfos[ilfo - 1];
      // A list we can't resolve (bad or missing list tables) isn't shown as one, like Word.
      return levels?.length ? levels[Math.min(ilvl, levels.length - 1)] : null;
    },
  };
}

/** Section ends (CP of each section's last character) and whether the next section starts a new page. */
function readSections(table, wd, fib) {
  const { fc, lcb } = fib.fcLcb(6); // PlcfSed
  const plc = readPlc(table, fc, lcb, 12);
  const breaks = new Map();
  for (let i = 0; i < plc.n; i++) {
    let newPage = true;
    const next = i + 1 < plc.n ? u32(table, plc.data(i + 1) + 2) : 0xffffffff;
    if (next !== 0xffffffff && next < wd.length) {
      eachSprm(slice(wd, next + 2, Math.max(0, i16(wd, next))), (sprm, o) => {
        if (sprm === 0x3009) newPage = wd[next + 2 + o] >= 2; // sprmSBkc: 0 continuous, 1 new column
      });
    }
    breaks.set(plc.pos[i + 1] - 1, newPage);
  }
  return breaks;
}

/** Document title from the \x05SummaryInformation property set, or null. */
function readTitle(b) {
  if (!b || b.length < 48 || u16(b, 0) !== 0xfffe) return null;
  const set = u32(b, 44);
  const n = Math.min(u32(b, set + 4), 1000);
  let codepage = 1252;
  let title = null;
  const props = [];
  for (let i = 0; i < n; i++) props.push([u32(b, set + 8 + i * 8), set + u32(b, set + 12 + i * 8)]);
  for (const [id, off] of props) if (id === 1 && u16(b, off) === 2) codepage = u16(b, off + 4);
  for (const [id, off] of props) {
    if (id !== 2) continue; // PIDSI_TITLE
    const type = u16(b, off);
    const len = Math.min(u32(b, off + 4), b.length);
    if (type === 0x1f) title = utf16(b, off + 8, len);
    else if (type === 0x1e) {
      const raw = slice(b, off + 8, len);
      if (codepage === 1200) title = utf16(raw, 0, raw.length / 2);
      else if (codepage === 1252) title = decode1252(raw);
      else {
        try {
          title = new TextDecoder(codepage === 65001 ? 'utf-8' : `windows-${codepage}`).decode(raw);
        } catch {
          title = decode1252(raw);
        }
      }
    }
  }
  title = title?.replace(/\0[\s\S]*$/, '').trim();
  return title || null;
}

// ---------------------------------------------------------------- FIB
/** Parse the FIB at the start of the WordDocument stream. */
function readFib(wd) {
  const ident = u16(wd, 0);
  const nFib = u16(wd, 2);
  // Word 6.0/95 files use wIdent 0xA5DC and nFib 101–105; Word 97 and later
  // use 0xA5EC with nFib 0xC1 (a few writers put 0xC0/0xC2 or newer values).
  if (wd.length < 0x22 || (ident !== 0xa5ec && ident !== 0xa5dc)) throw docError('not-word', 'This file is not a Word document.');
  if (ident === 0xa5dc || nFib < 0xc0) throw docError('old-format', 'This document was saved by Word 6.0/95 or older, which LibreWord cannot open. Re-save it as .docx or Word 97–2003 .doc.');
  const flags = u16(wd, 0x0a);
  if (flags & 0x0100) throw docError('encrypted', 'This document is password-protected or encrypted. Remove the password in Word, then open it again.');
  const csw = u16(wd, 0x20);
  const lw = 0x22 + csw * 2 + 2;
  const cslw = u16(wd, lw - 2);
  const fcLcbAt = lw + cslw * 4 + 2;
  const cbRgFcLcb = u16(wd, fcLcbAt - 2);
  return {
    flags,
    tableName: flags & 0x0200 ? '1Table' : '0Table',
    ccpText: Math.max(0, i32(wd, lw + 12)),
    fcLcb: (i) => (i < cbRgFcLcb ? { fc: u32(wd, fcLcbAt + i * 8), lcb: u32(wd, fcLcbAt + i * 8 + 4) } : { fc: 0, lcb: 0 }),
  };
}

// ---------------------------------------------------------------- converter
const PARAGRAPH_STYLE_IDS = { title: 'title', subtitle: 'subtitle', quote: 'quote', 'intense quote': 'intense-quote', caption: 'caption', 'no spacing': 'no-spacing' };
const SAFE_HREF = /^(https?:|mailto:|tel:|#)/i;
const LINE_BREAK = { br: true };
const PAGE_BREAK = { pageBreak: true };

/** Parse a field instruction's link: HYPERLINK "url" [\l "bookmark"] [\o "tooltip"]… */
function hyperlinkTarget(instr) {
  const m = /^\s*HYPERLINK\b(.*)$/is.exec(instr);
  if (!m) return null;
  const anchor = /\\l\s*"([^"]*)"/i.exec(m[1]);
  // Drop the switches (and the quoted arguments of \l, \o, \t); what is left is the address.
  const rest = m[1].replace(/\\[lot]\s*"[^"]*"/gi, '').replace(/\\[a-z]\b/gi, '');
  const url = /"([^"]*)"|(\S+)/.exec(rest);
  const href = (url ? url[1] ?? url[2] : '') + (anchor ? `#${anchor[1]}` : '');
  return SAFE_HREF.test(href) ? href : null;
}

class DocReader {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.chpCache = new Map();
    this.styleCache = new Map();
  }

  style(istd) {
    return this.styleSheet.styles[istd] || null;
  }

  /** Resolved { pap, chp } of a style, following istdBase (guarded against loops). */
  resolveStyle(istd, depth = 0) {
    if (this.styleCache.has(istd)) return this.styleCache.get(istd);
    const s = this.style(istd);
    const root = { pap: {}, chp: { size: 10, ftc: this.styleSheet.ftcAsci } };
    if (!s || depth > 20) return root;
    const base = s.base !== 0x0fff && s.base !== istd ? this.resolveStyle(s.base, depth + 1) : root;
    const out = { pap: { ...base.pap }, chp: { ...base.chp } };
    if (s.papx) applyPap(out.pap, s.papx);
    if (s.chpx) applyChp(out.chp, s.chpx, base.chp);
    this.styleCache.set(istd, out);
    return out;
  }

  /** Heading level (1–6) or a LibreWord named style for a paragraph style. */
  paragraphKind(istd) {
    const s = this.style(istd);
    if (!s) return {};
    const byName = /^heading\s*([1-9])$/i.exec(s.name || '');
    const level = s.sti >= 1 && s.sti <= 9 ? s.sti : byName ? Number(byName[1]) : null;
    if (level) return { level: Math.min(level, 6) };
    return { named: PARAGRAPH_STYLE_IDS[(s.name || '').toLowerCase()] || null };
  }

  /** Effective run properties for a CHPX run in a paragraph of style `istd`. */
  runProps(chpx, istd, styled) {
    const key = `${chpx ? chpx.id : -1}:${istd}:${styled}`;
    if (this.chpCache.has(key)) return this.chpCache.get(key);
    const para = this.resolveStyle(istd).chp;
    let base = para;
    // A character style (sprmCIstd) layers on the paragraph style; Word's
    // hyperlink style is skipped because LibreWord styles links itself.
    let charIstd = null;
    if (chpx) eachSprm(chpx.grpprl, (sprm, o) => { if (sprm === 0x4a30) charIstd = u16(chpx.grpprl, o); });
    const cs = charIstd != null ? this.style(charIstd) : null;
    if (cs && cs.stk === 2 && cs.chpx && !/hyperlink|internet link/i.test(cs.name || '')) base = applyChp({ ...para }, cs.chpx, para);
    const direct = chpx ? applyChp({}, chpx.grpprl, base) : {};
    // Headings and named styles keep LibreWord's own look, plus direct formatting.
    const p = styled ? { ...direct } : { ...base, ...direct };
    p.color = (direct.cv !== undefined ? direct.cv : direct.ico !== undefined ? direct.ico : null) ?? (styled ? null : p.cv ?? p.ico ?? null);
    p.font = p.ftc != null && (!styled || direct.ftc != null) ? this.fonts[p.ftc] || null : null;
    // Only what wrapRun() renders decides whether neighbouring runs can be merged.
    p.key = ['bold', 'italic', 'underline', 'strike', 'sup', 'sub', 'caps', 'hidden', 'color', 'size', 'font', 'highlight'].map((k) => p[k] ?? '').join('|');
    this.chpCache.set(key, p);
    return p;
  }

  /** Effective run formatting → HTML-wrapped text (same nesting as docx-import). */
  wrapRun(html, props, link, inHeading) {
    let out = html;
    if (props.sup) out = `<sup>${out}</sup>`;
    if (props.sub) out = `<sub>${out}</sub>`;
    if (props.strike) out = `<s>${out}</s>`;
    if (props.underline) out = `<u>${out}</u>`;
    if (props.italic) out = `<em>${out}</em>`;
    if (props.bold && !inHeading) out = `<strong>${out}</strong>`;
    const css = [];
    if (props.color && props.color !== '#000000') css.push(`color: ${props.color}`);
    if (props.size && Math.abs(props.size - 11) > 0.01) css.push(`font-size: ${props.size}pt`);
    const font = props.font?.replace(/['"\\;{}<>]/g, '').trim();
    if (font && !/^calibri/i.test(font)) css.push(`font-family: ${esc(font.includes(' ') ? `'${font}'` : font)}`);
    if (css.length) out = `<span style="${css.join('; ')}">${out}</span>`;
    if (props.highlight) out = `<mark data-color="${props.highlight}" style="background-color: ${props.highlight}">${out}</mark>`;
    if (link) out = `<a href="${esc(link)}">${out}</a>`;
    return out;
  }

  /**
   * Walk the main document text through the piece table, splitting it into
   * paragraphs of segments ({ text, chpx, link } or a break marker).
   */
  readParagraphs() {
    const { wd, pieces, ccpText, chpRuns, papRuns, sections } = this;
    const paras = [];
    const fields = []; // open fields: { instr, sep, href, outer } (outer: the enclosing link)
    let unseparated = 0; // open fields still in their instruction text
    let segs = [];
    let cur = null;
    // Every character comes from the WordDocument stream, so a sane piece
    // table never yields more characters than it has bytes.
    let budget = wd.length;
    // Constant time per character, however deeply (or maliciously) fields nest.
    const link = () => {
      const f = fields[fields.length - 1];
      return f ? f.href || f.outer : null;
    };
    const end = (fc, endChar) => {
      paras.push({ segs, papx: papRuns.find(fc), endChar });
      segs = [];
      cur = null;
    };
    for (const piece of pieces) {
      const step = piece.compressed ? 1 : 2;
      const stop = Math.min(piece.cpEnd, ccpText);
      for (let cp = Math.max(piece.cpStart, 0); cp < stop; cp++) {
        const fc = piece.fc + (cp - piece.cpStart) * step;
        if (fc + step > wd.length || budget-- <= 0) break;
        const code = piece.compressed ? cp1252(wd[fc]) : u16(wd, fc);
        if (code === 0x0d) {
          end(fc, '\r');
          continue;
        }
        if (code === 0x07) {
          end(fc, '\x07');
          continue;
        }
        if (code === 0x13) {
          fields.push({ instr: '', sep: false, href: null, outer: link() });
          unseparated++;
          continue;
        }
        if (code === 0x14 || code === 0x15) {
          const f = fields[fields.length - 1];
          if (f && code === 0x14 && !f.sep) {
            f.sep = true;
            f.href = hyperlinkTarget(f.instr);
            unseparated--;
          }
          if (code === 0x15 && fields.pop()?.sep === false) unseparated--;
          cur = null;
          continue;
        }
        if (unseparated) {
          // Field instruction text: hidden; collected for the innermost field.
          const f = fields[fields.length - 1];
          if (!f.sep) f.instr += String.fromCharCode(code);
          continue;
        }
        if (code === 0x0c) {
          // A section's last character is \x0C in place of its paragraph mark.
          if (sections.has(cp)) {
            end(fc, '\r');
            if (sections.get(cp)) segs.push(PAGE_BREAK);
          } else segs.push(PAGE_BREAK);
          cur = null;
          continue;
        }
        if (code === 0x0b) {
          segs.push(LINE_BREAK);
          cur = null;
          continue;
        }
        let ch;
        if (code === 0x09) ch = '\t';
        else if (code === 0x1e) ch = '\u2011'; // non-breaking hyphen
        else if (code === 0x1f) ch = '\u00ad'; // optional hyphen
        else if (code < 0x20) continue; // pictures, drawn objects, note/annotation refs…
        else ch = String.fromCharCode(code);
        const chpx = chpRuns.find(fc);
        const href = link();
        if (!cur || cur.chpx !== chpx || cur.link !== href) {
          cur = { text: '', chpx, link: href };
          segs.push(cur);
        }
        cur.text += ch;
      }
    }
    if (segs.length) paras.push({ segs, papx: null, endChar: '\r' });
    return paras;
  }

  /** Paragraph → { pap, blocks } with its HTML (several blocks if it has page breaks). */
  renderParagraph(para) {
    const istd = para.papx?.istd ?? 0;
    const pap = { ...this.resolveStyle(istd).pap };
    if (para.papx) applyPap(pap, para.papx.grpprl);
    const { level, named } = this.paragraphKind(istd);
    const styled = Boolean(level || named);
    const tag = level ? `h${level}` : 'p';
    const css = pap.align && pap.align !== 'left' ? ` style="text-align: ${pap.align}"` : '';
    const dataStyle = named ? ` data-style="${named}"` : '';
    const list = this.lists.get(pap.ilfo, pap.ilvl || 0);

    // Merge segments whose effective formatting is the same, then split at page breaks.
    const parts = [[]];
    for (const s of para.segs) {
      if (s === PAGE_BREAK) {
        parts.push([]);
        continue;
      }
      const part = parts[parts.length - 1];
      if (s === LINE_BREAK) {
        part.push(s);
        continue;
      }
      const props = this.runProps(s.chpx, istd, styled);
      if (props.hidden) continue;
      const text = props.caps ? s.text.toUpperCase() : s.text;
      const last = part[part.length - 1];
      if (last && last !== LINE_BREAK && last.props.key === props.key && last.link === s.link) last.text += text;
      else part.push({ text, props, link: s.link });
    }
    const blocks = [];
    if (pap.pageBreakBefore && !pap.inTable) blocks.push({ html: '<div data-page-break></div>' });
    parts.forEach((part, i) => {
      if (i > 0) blocks.push({ html: '<div data-page-break></div>' });
      const html = part.map((r) => (r === LINE_BREAK ? '<br>' : this.wrapRun(esc(r.text), r.props, r.link, Boolean(level)))).join('');
      if (parts.length > 1 && !html.replace(/<[^>]+>/g, '').trim()) return;
      blocks.push({ html: `<${tag}${dataStyle}${css}>${html}</${tag}>`, list: list && !level ? { ...list, ilfo: pap.ilfo, ilvl: pap.ilvl || 0 } : null });
    });
    return { pap, blocks, endChar: para.endChar };
  }

  /** Paragraphs that belong to one table → <table> HTML. */
  renderTable(paras) {
    const rows = [];
    let cells = [];
    let cell = [];
    for (const p of paras) {
      if (p.pap.innerTtp) continue; // a nested table's row mark: its cells are kept as paragraphs
      if (p.pap.ttp) {
        if (cell.length) cells.push(cell);
        rows.push({ cells, tdef: parseTDef(p.pap.tdef) });
        cells = [];
        cell = [];
        continue;
      }
      cell.push(...p.blocks);
      if (p.endChar === '\x07') {
        cells.push(cell);
        cell = [];
      }
    }
    if (cell.length) cells.push(cell);
    if (cells.length) rows.push({ cells, tdef: null });
    if (!rows.length) return '';

    // Column grid from the cell boundaries of every row, so wider cells get a colspan.
    const edges = [...new Set(rows.flatMap((r) => (r.tdef && r.tdef.centers.length === r.cells.length + 1 ? r.tdef.centers : [])))].sort((a, b) => a - b);
    const grid = [];
    for (const x of edges) if (!grid.length || x - grid[grid.length - 1] > 20) grid.push(x);
    const column = (x) => grid.reduce((best, g, i) => (Math.abs(g - x) < Math.abs(grid[best] - x) ? i : best), 0);
    const matrix = rows.map((r) => {
      const fit = grid.length > 1 && r.tdef && r.tdef.centers.length === r.cells.length + 1;
      let col = 0;
      return r.cells.map((blocks, i) => {
        const tc = r.tdef?.tcs[i] || {};
        const start = fit ? column(r.tdef.centers[i]) : col;
        const span = fit ? Math.max(1, column(r.tdef.centers[i + 1]) - start) : 1;
        col = start + span;
        return { blocks, col: start, span, rowspan: 1, tc, skip: false, owner: null };
      });
    });
    matrix.forEach((row, ri) => {
      row.forEach((c, i) => {
        // Old-style horizontal merge: the merged cell joins the one before it.
        if (c.tc.merged && !c.tc.firstMerged && i > 0) {
          const prev = row.slice(0, i).reverse().find((x) => !x.skip);
          if (prev) {
            prev.span += c.span;
            c.skip = true;
          }
        }
        // Vertical merge: a continuation cell extends the owner above it.
        if (c.tc.vertMerge && !c.tc.vertRestart && ri > 0) {
          const above = matrix[ri - 1].find((x) => x.col === c.col);
          const owner = above && (above.owner || (above.skip ? null : above));
          if (owner) {
            owner.rowspan++;
            c.skip = true;
            c.owner = owner;
          }
        }
      });
    });
    let html = '<table><tbody>';
    for (const row of matrix) {
      html += '<tr>';
      for (const c of row) {
        if (c.skip) continue;
        const attrs = (c.span > 1 ? ` colspan="${c.span}"` : '') + (c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : '');
        html += `<td${attrs}>${assembleLists(c.blocks) || '<p></p>'}</td>`;
      }
      html += '</tr>';
    }
    return `${html}</tbody></table>`;
  }

  convert() {
    const paras = this.readParagraphs().map((p) => this.renderParagraph(p));
    const blocks = [];
    for (let i = 0; i < paras.length;) {
      const p = paras[i];
      const inTable = (q) => q.pap.inTable || q.pap.itap >= 1 || q.endChar === '\x07';
      if (inTable(p)) {
        const start = i;
        while (i < paras.length && inTable(paras[i])) i++;
        if (p.pap.pageBreakBefore) blocks.push({ html: '<div data-page-break></div>' });
        blocks.push({ html: this.renderTable(paras.slice(start, i)) });
        continue;
      }
      blocks.push(...p.blocks);
      i++;
    }
    return assembleLists(blocks) || '<p></p>';
  }
}

/** sprmTDefTable operand → cell boundaries (twips) and per-cell merge flags. */
function parseTDef(b) {
  if (!b || b.length < 3) return null;
  const count = b[2];
  const centers = [];
  for (let i = 0; i <= count; i++) centers.push(i16(b, 3 + i * 2));
  const tcs = [];
  const tcAt = 3 + (count + 1) * 2;
  for (let i = 0; i < count && tcAt + i * 20 + 2 <= b.length; i++) {
    const f = u16(b, tcAt + i * 20);
    tcs.push({ firstMerged: Boolean(f & 1), merged: Boolean(f & 2), vertMerge: Boolean(f & 0x20), vertRestart: Boolean(f & 0x40) });
  }
  return { centers, tcs };
}

/** Group consecutive list paragraphs into nested <ul>/<ol> by list and level. */
function assembleLists(blocks) {
  let html = '';
  const stack = []; // open lists, innermost last: { tag, level, ilfo }
  const close = () => {
    html += `</li></${stack.pop().tag}>`;
  };
  for (const b of blocks) {
    if (!b.list) {
      while (stack.length) close();
      html += b.html;
      continue;
    }
    const { ilvl: level, ilfo, tag } = b.list;
    while (stack.length && stack[stack.length - 1].level > level) close();
    let top = stack[stack.length - 1];
    if (top && top.level === level && (top.ilfo !== ilfo || top.tag !== tag)) {
      close();
      top = null;
    }
    if (top && top.level === level) html += '</li>';
    else {
      // Opens nested inside the parent's still-open <li>.
      const start = tag === 'ol' && b.list.start !== 1 && Number.isFinite(b.list.start) ? ` start="${b.list.start}"` : '';
      html += `<${tag}${start}>`;
      stack.push({ tag, level, ilfo });
    }
    html += `<li>${b.html}`;
  }
  while (stack.length) close();
  return html;
}

/**
 * Convert a Word 97–2003 .doc file to LibreWord HTML.
 * @param {ArrayBuffer|Uint8Array} arrayBuffer
 * @returns {Promise<{ html: string, title: string|null }>}
 * @throws {Error} with `code`: 'not-cfb' | 'rtf' | 'docx' | 'not-word' | 'old-format' | 'encrypted' | 'corrupt'
 */
export async function readDoc(arrayBuffer) {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  try {
    const cfb = readCfb(bytes);
    const wd = cfb.stream('WordDocument');
    if (!wd) throw docError('not-word', 'This file is not a Word document (no WordDocument stream).');
    const fib = readFib(wd);
    const table = cfb.stream(fib.tableName);
    if (!table) throw docError('corrupt', `This Word document is damaged (missing ${fib.tableName} stream).`);

    const clx = fib.fcLcb(33);
    let pieces = readPieces(table, clx.fc, clx.lcb);
    // Files without a piece table keep their text contiguously from fcMin.
    if (!pieces) pieces = [{ cpStart: 0, cpEnd: fib.ccpText, fc: u32(wd, 0x18), compressed: !(fib.flags & 0x1000) }];

    const chp = fib.fcLcb(12);
    const pap = fib.fcLcb(13);
    const stsh = fib.fcLcb(1);
    const ffn = fib.fcLcb(15);
    const reader = new DocReader({
      wd,
      pieces,
      ccpText: fib.ccpText,
      chpRuns: readFkpRuns(table, wd, chp.fc, chp.lcb, 'chp'),
      papRuns: readFkpRuns(table, wd, pap.fc, pap.lcb, 'pap'),
      styleSheet: readStyles(table, stsh.fc, stsh.lcb),
      fonts: readFonts(table, ffn.fc, ffn.lcb),
      lists: readLists(table, fib),
      sections: readSections(table, wd, fib),
    });

    let title = null;
    try {
      title = readTitle(cfb.stream('\u0005SummaryInformation'));
    } catch {
      title = null;
    }
    return { html: reader.convert(), title };
  } catch (err) {
    if (err instanceof Error && err.code) throw err;
    throw docError('corrupt', `This Word document could not be read (${err instanceof Error ? err.message : String(err)}).`);
  }
}
