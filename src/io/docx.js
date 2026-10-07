import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun, LevelFormat,
  PageBreak, PageNumber, PageOrientation, Paragraph, ShadingType, Tab, Table, TableCell, TableOfContents, TableRow,
  TextRun, WidthType, Packer, UnderlineType, CommentRangeStart, CommentRangeEnd, CommentReference, LevelOverride,
} from 'docx';
import { pageGeometry, TWIPS_PER_PX } from '../editor/page-setup.js';
import { cssColorToHex, fontSizeToHalfPoints, firstFont, collectImages, xmlSafe } from './shared.js';

export { cssColorToHex, fontSizeToHalfPoints };

const ptToTwips = (pt) => Math.round(pt * 20);

const HEADINGS = [null, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED };
const STYLE_IDS = { title: 'Title', subtitle: 'Subtitle', quote: 'Quote', 'intense-quote': 'IntenseQuote', caption: 'Caption', 'no-spacing': 'NoSpacing' };

/**
 * Comment anchors: for every comment id, the index (in conversion order) of
 * the first and last text node it covers. Code blocks are skipped because
 * their text is emitted directly, not through runs().
 */
function scanComments(doc) {
  const spans = new Map();
  let index = 0;
  const walk = (n) => {
    if (n.type === 'codeBlock') return;
    if (n.type === 'text') {
      for (const m of n.marks || []) {
        if (m.type !== 'comment' || !m.attrs?.id) continue;
        const s = spans.get(m.attrs.id);
        if (s) s.last = index;
        else spans.set(m.attrs.id, { first: index, last: index });
      }
      index++;
      return;
    }
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return spans;
}

class Converter {
  constructor(images, geometry, commentAnchors = new Map()) {
    this.images = images;
    this.geometry = geometry;
    this.listInstance = 0;
    this.orderedStarts = new Set(); // start numbers other than 1, each needs its own numbering config
    this.orderedLists = []; // { reference, instance, level, start } for every ordered list
    this.textIndex = 0;
    // comment id → { first, last, ids: [numeric docx ids for the thread] }
    this.commentAnchors = commentAnchors;
  }

  runs(nodes = [], base = {}) {
    const out = [];
    for (const n of nodes) {
      if (n.type === 'hardBreak') {
        out.push(new TextRun({ break: 1 }));
        continue;
      }
      if (n.type === 'image') {
        const img = this.images.get(n.attrs?.src);
        if (!img) {
          if (n.attrs?.alt) out.push(new TextRun({ text: `[${n.attrs.alt}]`, italics: true }));
          continue;
        }
        let width = Number(n.attrs?.width) || img.width;
        let height = Number(n.attrs?.height) || Math.round((width / img.width) * img.height);
        // Fit the text area, keeping the proportions, as the editor shows it.
        const fit = Math.min(1, this.geometry.contentWidth / width, this.geometry.contentHeight / height);
        if (fit < 1) {
          width = Math.round(width * fit);
          height = Math.round(height * fit);
        }
        out.push(new ImageRun({ type: img.type, data: img.bytes, transformation: { width, height }, altText: n.attrs?.alt ? { name: n.attrs.alt, description: n.attrs.alt, title: n.attrs.alt } : undefined }));
        continue;
      }
      if (n.type !== 'text') continue;
      const textIndex = this.textIndex++;
      const anchors = (n.marks || [])
        .filter((m) => m.type === 'comment' && this.commentAnchors.has(m.attrs?.id))
        .map((m) => this.commentAnchors.get(m.attrs.id));
      for (const a of anchors) if (a.first === textIndex) a.ids.forEach((id) => out.push(new CommentRangeStart(id)));
      const opts = { ...base };
      let link = null;
      for (const m of n.marks || []) {
        switch (m.type) {
          case 'bold': opts.bold = true; break;
          case 'italic': opts.italics = true; break;
          case 'underline': opts.underline = { type: UnderlineType.SINGLE }; break;
          case 'strike': opts.strike = true; break;
          case 'subscript': opts.subScript = true; break;
          case 'superscript': opts.superScript = true; break;
          case 'code': opts.font = 'Consolas'; opts.shading = { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' }; break;
          case 'highlight': {
            const fill = cssColorToHex(m.attrs?.color) || 'FFFF00';
            opts.shading = { type: ShadingType.CLEAR, fill, color: 'auto' };
            break;
          }
          case 'textStyle': {
            const color = cssColorToHex(m.attrs?.color);
            if (color) opts.color = color;
            const size = fontSizeToHalfPoints(m.attrs?.fontSize);
            if (size) opts.size = size;
            const font = firstFont(m.attrs?.fontFamily);
            if (font) opts.font = font;
            break;
          }
          case 'link': link = m.attrs?.href; break;
          default: break;
        }
      }
      const parts = n.text.split('\t');
      const children = [];
      parts.forEach((p, i) => {
        if (i > 0) children.push(new Tab());
        if (p) children.push(p);
      });
      if (link) {
        opts.style = 'Hyperlink';
        out.push(new ExternalHyperlink({ link, children: [new TextRun({ ...opts, children })] }));
      } else {
        out.push(new TextRun({ ...opts, children }));
      }
      for (const a of anchors) {
        if (a.last !== textIndex) continue;
        a.ids.forEach((id) => {
          out.push(new CommentRangeEnd(id));
          out.push(new TextRun({ children: [new CommentReference(id)] }));
        });
      }
    }
    return out;
  }

  paragraphOptions(attrs = {}) {
    const o = {};
    if (attrs.textAlign && ALIGN[attrs.textAlign]) o.alignment = ALIGN[attrs.textAlign];
    const spacing = {};
    if (attrs.spaceBefore != null) spacing.before = ptToTwips(attrs.spaceBefore);
    if (attrs.spaceAfter != null) spacing.after = ptToTwips(attrs.spaceAfter);
    if (attrs.lineHeight) spacing.line = Math.round(parseFloat(attrs.lineHeight) * 240);
    if (Object.keys(spacing).length) o.spacing = spacing;
    const indent = {};
    if (attrs.indent) indent.left = Math.round(attrs.indent * TWIPS_PER_PX);
    if (attrs.firstLineIndent > 0) indent.firstLine = Math.round(attrs.firstLineIndent * TWIPS_PER_PX);
    if (attrs.firstLineIndent < 0) indent.hanging = Math.round(-attrs.firstLineIndent * TWIPS_PER_PX);
    if (Object.keys(indent).length) o.indent = indent;
    return o;
  }

  blocks(nodes = [], ctx = {}) {
    const out = [];
    for (const n of nodes) out.push(...this.block(n, ctx));
    return out;
  }

  block(n, ctx) {
    const extra = ctx.paragraph || {};
    switch (n.type) {
      case 'paragraph': {
        const o = { ...this.paragraphOptions(n.attrs), ...extra };
        if (n.attrs?.styleId && STYLE_IDS[n.attrs.styleId]) o.style = STYLE_IDS[n.attrs.styleId];
        const runs = this.runs(n.content, ctx.run);
        if (ctx.taskPrefix) runs.unshift(new TextRun({ text: ctx.taskPrefix }));
        return [new Paragraph({ ...o, children: runs })];
      }
      case 'heading':
        return [new Paragraph({ ...this.paragraphOptions(n.attrs), ...extra, heading: HEADINGS[n.attrs?.level || 1], children: this.runs(n.content, ctx.run) })];
      case 'blockquote':
        return this.blocks(n.content, {
          ...ctx,
          paragraph: {
            ...extra,
            style: 'Quote',
          },
        });
      case 'codeBlock': {
        const lines = (n.content || []).map((t) => t.text || '').join('').split('\n');
        return lines.map((line, i) => new Paragraph({
          ...extra,
          spacing: { before: 0, after: i === lines.length - 1 ? 160 : 0, line: 240 },
          shading: { type: ShadingType.CLEAR, fill: 'F5F5F5', color: 'auto' },
          children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 20 })],
        }));
      }
      case 'horizontalRule':
        return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'A6A6A6', space: 1 } }, children: [] })];
      case 'pageBreak':
        return [new Paragraph({ children: [new PageBreak()] })];
      case 'tableOfContents':
        // Cached entries make the TOC visible in every viewer; Word refreshes it on demand.
        return [
          new Paragraph({ style: 'TOCHeading', children: [new TextRun('Contents')] }),
          new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-3', cachedEntries: this.tocEntries }),
        ];
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        const level = ctx.listLevel ?? 0;
        const instance = n.type === 'orderedList' ? ++this.listInstance : 0;
        const start = Number.isInteger(n.attrs?.start) && n.attrs.start >= 0 ? n.attrs.start : 1;
        if (n.type === 'orderedList' && start !== 1) this.orderedStarts.add(start);
        const orderedRef = start !== 1 ? `lw-ordered-${start}` : 'lw-ordered';
        if (instance) this.orderedLists.push({ reference: orderedRef, instance, level: Math.min(level, 8), start });
        const out = [];
        for (const item of n.content || []) {
          const [first, ...rest] = item.content || [];
          const numbering = n.type === 'orderedList'
            ? { numbering: { reference: orderedRef, level: Math.min(level, 8), instance } }
            : n.type === 'bulletList'
              ? { numbering: { reference: 'lw-bullet', level: Math.min(level, 8) } }
              : { indent: { left: 360 * (level + 1), hanging: 360 } };
          const taskPrefix = n.type === 'taskList' ? (item.attrs?.checked ? '☒ ' : '☐ ') : null;
          if (first) out.push(...this.block(first, { ...ctx, paragraph: { ...extra, ...numbering }, taskPrefix, listLevel: level }));
          for (const child of rest) {
            const nested = ['bulletList', 'orderedList', 'taskList'].includes(child.type);
            out.push(...this.block(child, { ...ctx, listLevel: nested ? level + 1 : level, paragraph: nested ? extra : { ...extra, indent: { left: 720 * (level + 1) } }, taskPrefix: null }));
          }
        }
        return out;
      }
      case 'table':
        return [this.table(n)];
      default:
        return n.content ? this.blocks(n.content, ctx) : [];
    }
  }

  table(n) {
    const rows = n.content || [];
    const firstRow = rows[0]?.content || [];
    const colCount = firstRow.reduce((s, c) => s + (c.attrs?.colspan || 1), 0) || 1;
    const widths = [];
    for (const c of firstRow) {
      const span = c.attrs?.colspan || 1;
      const cw = c.attrs?.colwidth;
      for (let i = 0; i < span; i++) widths.push(cw?.[i] || null);
    }
    const known = widths.filter(Boolean).reduce((a, b) => a + b, 0);
    const unknown = widths.filter((w) => !w).length;
    const total = this.geometry.contentWidth;
    const fill = unknown ? Math.max(36, (total - known) / unknown) : 0;
    const columnWidths = widths.map((w) => Math.round((w || fill) * TWIPS_PER_PX));
    const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
    // Leading rows of header cells repeat at the top of each page, as in the editor.
    let headerRows = 0;
    while (headerRows < rows.length - 1 && (rows[headerRows].content || []).length && rows[headerRows].content.every((c) => c.type === 'tableHeader')) headerRows++;
    return new Table({
      width: { size: columnWidths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      columnWidths,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: rows.map((row, ri) => new TableRow({
        tableHeader: ri < headerRows,
        children: (row.content || []).map((cell) => {
          const children = this.blocks(cell.content, { run: cell.type === 'tableHeader' ? { bold: true } : undefined });
          return new TableCell({
            children: children.length ? children : [new Paragraph({})],
            columnSpan: cell.attrs?.colspan > 1 ? cell.attrs.colspan : undefined,
            rowSpan: cell.attrs?.rowspan > 1 ? cell.attrs.rowspan : undefined,
            shading: cell.attrs?.backgroundColor
              ? { type: ShadingType.CLEAR, fill: cssColorToHex(cell.attrs.backgroundColor) || 'auto', color: 'auto' }
              : cell.type === 'tableHeader' ? { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          });
        }),
      })),
    });
  }
}

const BULLETS = ['•', '◦', '▪', '•', '◦', '▪', '•', '◦', '▪'];
const ORDERED_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN];

/**
 * Numbered-list definition; `start` sets the first number. Each list gets its
 * own numbering instance, but docx only restarts level 0 of an instance — see
 * restartNestedLists() for the others.
 */
const orderedNumbering = (reference, start = 1) => ({
  reference,
  levels: Array.from({ length: 9 }, (_, level) => ({
    level, format: ORDERED_FORMATS[level % 3], text: `%${level + 1}.`, alignment: AlignmentType.LEFT, start,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  })),
});

function headerFooter(text, pageNumbers, isFooter) {
  const children = [];
  const style = { color: '595959', size: 18 };
  if (text) children.push(new TextRun({ text, ...style }));
  if (isFooter && pageNumbers) {
    // One run per piece so the field results get the same formatting as the text.
    if (text) children.push(new TextRun({ text: '   ', ...style }));
    children.push(
      new TextRun({ text: 'Page ', ...style }),
      new TextRun({ children: [PageNumber.CURRENT], ...style }),
      new TextRun({ text: ' of ', ...style }),
      new TextRun({ children: [PageNumber.TOTAL_PAGES], ...style }),
    );
  }
  if (!children.length) return undefined;
  // The Header/Footer paragraph style carries the font so page-number field results match.
  const p = new Paragraph({ style: isFooter ? 'Footer' : 'Header', alignment: isFooter ? AlignmentType.CENTER : AlignmentType.RIGHT, children });
  return isFooter ? new Footer({ children: [p] }) : new Header({ children: [p] });
}

function buildComments(json, comments = {}) {
  const spans = scanComments(json);
  const anchors = new Map();
  const children = [];
  let next = 0;
  const para = (text) => String(text || '').split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] }));
  for (const [id, span] of spans) {
    const c = comments[id];
    if (!c) continue;
    const mainId = next++;
    const ids = [mainId];
    children.push({ id: mainId, author: c.author || 'Author', initials: c.initials || '', date: new Date(c.date || Date.now()), resolved: Boolean(c.resolved), children: para(c.text) });
    for (const r of c.replies || []) {
      const rid = next++;
      ids.push(rid);
      children.push({ id: rid, parentId: mainId, author: r.author || 'Author', initials: r.initials || '', date: new Date(r.date || Date.now()), children: para(r.text) });
    }
    anchors.set(id, { ...span, ids });
  }
  return { anchors, options: children.length ? { children } : undefined };
}

function tocEntries(json, pages = []) {
  const entries = [];
  const text = (n) => (n.content || []).map((c) => (c.type === 'text' ? c.text : text(c))).join('');
  let i = 0;
  const walk = (n) => {
    if (n.type === 'heading') {
      // Indexes line up with collectHeadings(), which skips empty headings.
      const t = text(n).trim();
      if (!t) return;
      const page = pages[i++];
      if ((n.attrs?.level || 1) <= 3) entries.push({ title: t, level: n.attrs?.level || 1, ...(page ? { page } : {}) });
      return;
    }
    if (n.type !== 'table') (n.content || []).forEach(walk);
  };
  walk(json);
  return entries;
}

/**
 * @param tocPages page number of each heading in document order (from the
 *   live layout), used for the table of contents' cached entries.
 */
export async function buildDocx(json, settings, { title = 'Document', author = 'LibreWord', comments = {}, tocPages = [] } = {}) {
  json = xmlSafe(json);
  settings = xmlSafe(settings);
  comments = xmlSafe(comments);
  title = xmlSafe(title);
  author = xmlSafe(author);
  const geometry = pageGeometry(settings);
  const images = await collectImages(json);
  const commentData = buildComments(json, comments);
  const conv = new Converter(images, geometry, commentData.anchors);
  conv.tocEntries = tocEntries(json, tocPages);
  const children = conv.blocks(json.content || []);
  const landscape = settings.orientation === 'landscape';
  const heading = (size, color, before, extra = {}) => ({
    run: { font: 'Calibri Light', size, color, ...extra },
    paragraph: { spacing: { before, after: 0, line: 259 }, keepNext: true, keepLines: true },
  });

  const header = headerFooter(settings.header, false, false);
  const footer = headerFooter(settings.footer, settings.pageNumbers, true);

  const file = new Document({
    creator: author,
    title,
    comments: commentData.options,
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 }, paragraph: { spacing: { after: 160, line: 276 } } },
        heading1: heading(32, '2F5496', 240),
        heading2: heading(26, '2F5496', 40),
        heading3: heading(24, '1F3763', 40),
        heading4: heading(22, '2F5496', 40, { italics: true }),
        heading5: heading(22, '2F5496', 40),
        heading6: heading(22, '1F3763', 40),
        title: { run: { font: 'Calibri Light', size: 56 }, paragraph: { spacing: { after: 80, line: 240 } } },
        hyperlink: { run: { color: '0563C1', underline: { type: UnderlineType.SINGLE } } },
      },
      paragraphStyles: [
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', next: 'Normal', run: { color: '5A5A5A', size: 22, characterSpacing: 15 }, paragraph: { spacing: { after: 160 } } },
        { id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', run: { italics: true, color: '404040' }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 200, after: 160 }, indent: { left: 864, right: 864 } } },
        { id: 'IntenseQuote', name: 'Intense Quote', basedOn: 'Normal', next: 'Normal', run: { italics: true, color: '2F5496' }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 360, after: 360 }, indent: { left: 864, right: 864 }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: '2F5496', space: 10 }, bottom: { style: BorderStyle.SINGLE, size: 4, color: '2F5496', space: 10 } } } },
        { id: 'Caption', name: 'Caption', basedOn: 'Normal', next: 'Normal', run: { italics: true, color: '44546A', size: 18 }, paragraph: { spacing: { after: 200, line: 240 } } },
        { id: 'NoSpacing', name: 'No Spacing', basedOn: 'Normal', next: 'NoSpacing', paragraph: { spacing: { after: 0, line: 240 } } },
        { id: 'Header', name: 'header', basedOn: 'Normal', run: { color: '595959', size: 18 }, paragraph: { spacing: { after: 0, line: 240 } } },
        { id: 'Footer', name: 'footer', basedOn: 'Normal', run: { color: '595959', size: 18 }, paragraph: { spacing: { after: 0, line: 240 } } },
        { id: 'TOCHeading', name: 'TOC Heading', basedOn: 'Normal', next: 'Normal', run: { font: 'Calibri Light', size: 32, color: '2F5496' }, paragraph: { spacing: { before: 240, after: 120 } } },
        { id: 'TOC1', name: 'toc 1', basedOn: 'Normal', next: 'Normal', paragraph: { spacing: { after: 100 } } },
        { id: 'TOC2', name: 'toc 2', basedOn: 'Normal', next: 'Normal', paragraph: { spacing: { after: 100 }, indent: { left: 220 } } },
        { id: 'TOC3', name: 'toc 3', basedOn: 'Normal', next: 'Normal', paragraph: { spacing: { after: 100 }, indent: { left: 440 } } },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'lw-bullet',
          levels: BULLETS.map((text, level) => ({
            level, format: LevelFormat.BULLET, text, alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
        orderedNumbering('lw-ordered'),
        ...[...conv.orderedStarts].map((start) => orderedNumbering(`lw-ordered-${start}`, start)),
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: Math.round((landscape ? geometry.height : geometry.width) * TWIPS_PER_PX),
              height: Math.round((landscape ? geometry.width : geometry.height) * TWIPS_PER_PX),
              orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: {
              top: Math.round(settings.margins.top * TWIPS_PER_PX),
              right: Math.round(settings.margins.right * TWIPS_PER_PX),
              bottom: Math.round(settings.margins.bottom * TWIPS_PER_PX),
              left: Math.round(settings.margins.left * TWIPS_PER_PX),
              header: 708,
              footer: 708,
            },
          },
        },
        headers: header ? { default: header } : undefined,
        footers: footer ? { default: footer } : undefined,
        children: children.length ? children : [new Paragraph({})],
      },
    ],
  });
  restartNestedLists(file, conv.orderedLists);
  return file;
}

/**
 * docx writes a <w:startOverride> only for level 0 of each numbering
 * instance, so Word continues a nested list's numbering from the previous
 * nested list at that level (c, d… instead of a). Create the instances of
 * nested lists up front with a restart for the level they're used at; the
 * paragraphs then reuse them.
 */
function restartNestedLists(file, lists) {
  // This reaches into docx internals; if a docx upgrade changes them, export
  // still works and nested lists merely keep Word's default numbering.
  try {
    const numbering = file.Numbering;
    for (const { reference, instance, level, start } of lists) {
      if (!level) continue;
      numbering.createConcreteNumberingInstance(reference, instance);
      const concrete = numbering.ConcreteNumbering.find((c) => c.reference === reference && c.instance === instance);
      if (Array.isArray(concrete?.root)) concrete.root.push(new LevelOverride(level, start));
    }
  } catch (err) {
    console.warn('Could not restart nested list numbering', err);
  }
}

export async function docxBlob(json, settings, meta) {
  return Packer.toBlob(await buildDocx(json, settings, meta));
}

export async function docxBuffer(json, settings, meta) {
  return Packer.toBuffer(await buildDocx(json, settings, meta));
}
