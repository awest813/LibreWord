/**
 * Helpers shared by the document writers (.docx, .odt): CSS colour and size
 * conversion, embedded images, and XML-safe text.
 */
import { cssLengthToPx } from '../editor/paragraph-format.js';

const NAMED_COLORS = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', orange: 'FFA500',
  purple: '800080', gray: '808080', grey: '808080', pink: 'FFC0CB', cyan: '00FFFF', magenta: 'FF00FF', lime: '00FF00',
  navy: '000080', teal: '008080', maroon: '800000', olive: '808000', silver: 'C0C0C0', brown: 'A52A2A',
};

export function cssColorToHex(value) {
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

export function fontSizeToHalfPoints(value) {
  if (!value) return undefined;
  const v = String(value).trim();
  // Bare numbers are points; anything else is a CSS length (px, pt, em, rem…).
  const pt = /^[\d.]+$/.test(v) ? parseFloat(v) : (cssLengthToPx(v) ?? NaN) * 0.75;
  if (!(pt > 0)) return undefined;
  return Math.round(pt * 2);
}

export const firstFont = (stack) => (stack ? stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '') : undefined);

export function dataUrlToBytes(src) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(src);
  if (!m) return null;
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: m[1] };
}

export const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/** Decode an image for drawing; createImageBitmap can't decode SVG, so that goes through <img>. */
async function decodeImage(bytes, mime) {
  const blob = new Blob([bytes], { type: mime });
  if (mime !== 'image/svg+xml') return createImageBitmap(blob);
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Re-encode anything docx can't embed directly (webp, svg…) as PNG via canvas. */
async function toEmbeddable(bytes, mime) {
  if (IMAGE_TYPES[mime]) return { bytes, type: IMAGE_TYPES[mime] };
  if (typeof document === 'undefined' || typeof createImageBitmap === 'undefined') return null;
  const src = await decodeImage(bytes, mime);
  // An SVG without width/height has no natural size; use the browser's default replaced-element size.
  const width = src.naturalWidth || src.width || 300;
  const height = src.naturalHeight || src.height || 150;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(src, 0, 0, width, height);
  src.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'png', width, height };
}

export async function imageSize(bytes, mime) {
  try {
    if (typeof createImageBitmap !== 'undefined') {
      const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
      const size = { width: bmp.width, height: bmp.height };
      bmp.close();
      return size;
    }
  } catch { /* fall through */ }
  // PNG header fallback (used in tests / non-DOM environments)
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  return { width: 300, height: 200 };
}

/** Pre-load every image in the document so the synchronous conversion can embed them. */
export async function collectImages(doc) {
  const images = new Map();
  const srcs = new Set();
  const walk = (n) => {
    if (n.type === 'image' && n.attrs?.src) srcs.add(n.attrs.src);
    (n.content || []).forEach(walk);
  };
  walk(doc);
  await Promise.all(
    [...srcs].map(async (src) => {
      try {
        let data = dataUrlToBytes(src);
        if (!data) {
          const res = await fetch(src);
          if (!res.ok) return;
          const blob = await res.blob();
          data = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
        }
        const embeddable = await toEmbeddable(data.bytes, data.mime);
        if (!embeddable) return;
        const size = embeddable.width ? {} : await imageSize(data.bytes, data.mime);
        images.set(src, { ...embeddable, ...size });
      } catch {
        /* unreachable image — skipped */
      }
    }),
  );
  return images;
}

// Characters XML 1.0 can't contain (control characters such as PowerPoint's
// vertical-tab line break, lone surrogates). Written as-is they make Word
// reject the whole file.
export const XML_ILLEGAL = /[\u0000-\u0008\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xmlSafe = (v) => {
  if (typeof v === 'string') return v.replace(/[\u000B\u000C]/g, ' ').replace(XML_ILLEGAL, '');
  if (Array.isArray(v)) return v.map(xmlSafe);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, xmlSafe(x)]));
  return v;
};
