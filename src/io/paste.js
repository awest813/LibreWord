/**
 * Clean up HTML pasted from Microsoft Word (desktop and Word for the web).
 *
 * Word doesn't emit <ul>/<ol>: each list item is a <p class="MsoListParagraph…">
 * whose style carries `mso-list: l0 level2 lfo1`, with the bullet/number
 * rendered as literal text inside a `mso-list:Ignore` span. We rebuild real
 * nested lists from that so they paste as editable lists.
 */
const ORDERED_MARKER = /^\s*(?:\(?[0-9]+[.)]|\(?[a-z][.)]|\(?[ivxlcdm]+[.)])\s*$/i;

export function isWordHtml(html) {
  return /urn:schemas-microsoft-com:office|class="?Mso|mso-list|<o:p>/i.test(html);
}

export function cleanWordHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  cleanWord(doc);
  return doc.body.innerHTML;
}

/** Word's paragraph styles that LibreWord has too. */
const WORD_STYLES = { msotitle: 'title', msosubtitle: 'subtitle', msoquote: 'quote', msointensequote: 'intense-quote', msonospacing: 'no-spacing', msocaption: 'caption' };

function cleanWord(doc) {
  const body = doc.body;
  // Named paragraph styles, before the Mso classes go.
  body.querySelectorAll('p[class]').forEach((p) => {
    const style = WORD_STYLES[p.className.toLowerCase()];
    if (style) p.dataset.style = style;
  });
  // A tab is a run of spaces in a span marked with mso-tab-count.
  body.querySelectorAll('span[style*="mso-tab-count"]').forEach((span) => {
    const block = span.closest('p, li, td, th, h1, h2, h3, h4, h5, h6');
    if (block) block.style.whiteSpace = 'pre-wrap'; // so the editor keeps the tab
    span.replaceWith('\t'.repeat(Number(/mso-tab-count:\s*(\d+)/.exec(span.getAttribute('style'))?.[1]) || 1));
  });

  // Office-only elements and conditional-comment leftovers.
  body.querySelectorAll('o\\:p, xml, style, meta, link').forEach((el) => el.remove());

  const levelOf = (p) => {
    const m = /mso-list:\s*\S+\s+level(\d+)/i.exec(p.getAttribute('style') || '');
    return m ? Number(m[1]) : 0;
  };

  const items = [...body.querySelectorAll('p, h1, h2, h3, h4, h5, h6')].filter((p) => levelOf(p) > 0);
  for (const p of items) {
    // Pull out the literal marker ("1.", "·", "o", "§"…) Word renders in front.
    let marker = '';
    p.querySelectorAll('span').forEach((span) => {
      if (/mso-list:\s*Ignore/i.test(span.getAttribute('style') || '')) {
        marker += span.textContent;
        span.remove();
      }
    });
    p.dataset.listLevel = String(levelOf(p));
    p.dataset.listType = ORDERED_MARKER.test(marker.replace(/ /g, ' ').trim()) ? 'ol' : 'ul';
    p.style.removeProperty('text-indent');
    p.style.removeProperty('margin-left');
  }

  // Group consecutive list paragraphs into nested lists.
  for (const first of items) {
    if (!first.isConnected || first.parentNode.closest?.('li')) continue;
    const run = [first];
    let next = first.nextElementSibling;
    // A top-level change between bullets and numbering starts a separate list.
    const base = Number(first.dataset.listLevel);
    while (next && next.dataset?.listLevel && !(Number(next.dataset.listLevel) <= base && next.dataset.listType !== first.dataset.listType)) {
      run.push(next);
      next = next.nextElementSibling;
    }
    const root = doc.createElement(first.dataset.listType);
    first.before(root);
    const stack = [{ level: Number(first.dataset.listLevel), list: root }];
    for (const p of run) {
      const level = Number(p.dataset.listLevel);
      while (stack.length > 1 && level < stack[stack.length - 1].level) stack.pop();
      let top = stack[stack.length - 1];
      if (level > top.level) {
        const parentLi = top.list.lastElementChild || top.list.appendChild(doc.createElement('li'));
        const nested = doc.createElement(p.dataset.listType);
        parentLi.append(nested);
        stack.push({ level, list: nested });
        top = stack[stack.length - 1];
      }
      if (level === top.level && stack.length > 1 && top.list.tagName.toLowerCase() !== p.dataset.listType) {
        // Same nesting level, other kind of list: a sibling list in the same item.
        const sibling = doc.createElement(p.dataset.listType);
        top.list.after(sibling);
        top.list = sibling;
      }
      const li = doc.createElement('li');
      delete p.dataset.listLevel;
      delete p.dataset.listType;
      li.append(p);
      top.list.append(li);
    }
  }

  // Word's "Normal" paragraphs carry margins that are already the default.
  body.querySelectorAll('[class^="Mso"]').forEach((el) => el.removeAttribute('class'));
}

// ---------------------------------------------------------------------------
// Word for the web (Office Online)
// ---------------------------------------------------------------------------

export const isWordOnlineHtml = (html) => /class="?[^"]*\b(TextRun|OutlineElement|NormalTextRun|ListContainerWrapper)\b/.test(html);

/**
 * Word for the web puts every list item in its own list (inside a
 * ListContainerWrapper) and marks nesting with data-aria-level; headings are
 * <p role="heading" aria-level>. Rebuild real headings and nested lists.
 */
function cleanWordOnline(doc) {
  const body = doc.body;
  body.querySelectorAll('span.EOP').forEach((el) => el.remove()); // end-of-paragraph marker, a lone &nbsp;
  body.querySelectorAll('p[role="heading"][aria-level]').forEach((p) => {
    const level = Math.min(6, Math.max(1, Number(p.getAttribute('aria-level')) || 1));
    const h = doc.createElement(`h${level}`);
    h.append(...p.childNodes);
    if (p.style.textAlign && p.style.textAlign !== 'left') h.style.textAlign = p.style.textAlign;
    p.replaceWith(h);
  });
  const wrappers = [...body.querySelectorAll('div.ListContainerWrapper')];
  const done = new Set();
  for (const first of wrappers) {
    if (done.has(first)) continue;
    const run = [first];
    for (let next = first.nextElementSibling; next?.classList.contains('ListContainerWrapper'); next = next.nextElementSibling) run.push(next);
    const items = [];
    for (const w of run) {
      done.add(w);
      for (const li of w.querySelectorAll('li')) {
        const list = li.closest('ul, ol');
        items.push({ li, level: Math.max(1, Number(li.getAttribute('data-aria-level')) || 1), tag: list.tagName.toLowerCase(), id: li.getAttribute('data-listid'), start: Number(list.getAttribute('start')) || 1 });
      }
    }
    if (!items.length) continue;
    const container = doc.createElement('div');
    let stack = [];
    for (const it of items) {
      while (stack.length && stack[stack.length - 1].level > it.level) stack.pop();
      let top = stack[stack.length - 1];
      // A different list at the same level (other id or kind) starts a new one.
      if (top && top.level === it.level && (top.tag !== it.tag || top.id !== it.id)) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (!top || top.level < it.level) {
        const list = doc.createElement(it.tag);
        if (it.tag === 'ol' && it.start !== 1) list.setAttribute('start', String(it.start));
        if (top) (top.list.lastElementChild || top.list.appendChild(doc.createElement('li'))).append(list);
        else container.append(list);
        top = { level: it.level, tag: it.tag, id: it.id, list };
        stack.push(top);
      }
      const li = doc.createElement('li');
      li.append(...it.li.childNodes);
      top.list.append(li);
    }
    first.replaceWith(...container.childNodes);
    run.slice(1).forEach((w) => w.remove());
  }
}

// ---------------------------------------------------------------------------
// Google Docs
// ---------------------------------------------------------------------------

export const isGoogleDocsHtml = (html) => /id="docs-internal-guid-/.test(html);

function cleanGoogleDocs(doc) {
  const body = doc.body;
  // Everything sits in <b style="font-weight:normal" id="docs-internal-guid-…">.
  body.querySelectorAll('b[id^="docs-internal-guid-"]').forEach((b) => b.replaceWith(...b.childNodes));
  // Checklists: <li role="checkbox" aria-checked> with a picture of the box.
  body.querySelectorAll('img[aria-roledescription="checkbox"]').forEach((img) => img.remove());
  body.querySelectorAll('li[role="checkbox"]').forEach((li) => {
    const checked = li.getAttribute('aria-checked') === 'true';
    li.dataset.type = 'taskItem';
    li.dataset.checked = String(checked);
    li.parentElement?.setAttribute('data-type', 'taskList');
    // Docs strikes through ticked items itself; LibreWord does that with styling.
    if (checked) li.querySelectorAll('span').forEach((s) => { if (/line-through/.test(s.style.textDecoration)) s.style.removeProperty('text-decoration'); });
  });
}

// ---------------------------------------------------------------------------
// Everything else (and the clean-up all sources need)
// ---------------------------------------------------------------------------

const FONT_SIZES = [null, 8, 10, 12, 14, 18, 24, 36]; // <font size="1…7">
const BLOCK = 'P,DIV,H1,H2,H3,H4,H5,H6,UL,OL,LI,TABLE,TBODY,THEAD,TR,TD,TH,BLOCKQUOTE,PRE,HR,SECTION,ARTICLE,HEADER,FOOTER,NAV,ASIDE,FIGURE,DL,DT,DD,CENTER';
const isBlock = (el) => BLOCK.split(',').includes(el.tagName);
const isDefaultColor = (c) => /^(#000(000)?|black|windowtext|auto|rgb\(0,\s*0,\s*0\))$/i.test(String(c).trim());
const isNoBackground = (c) => !c || /^(transparent|initial|inherit|none|white|#fff(fff)?|rgba?\(255,\s*255,\s*255(,\s*1)?\)|rgba\(.*,\s*0\))$/i.test(String(c).trim());
const PX_PER = { in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, px: 1 };
const lengthPx = (v) => {
  const m = /^([\d.]+)\s*(in|cm|mm|pt|pc|px)?$/.exec(String(v || '').trim());
  return m ? parseFloat(m[1]) * PX_PER[m[2] || 'px'] : null;
};
/** Where an internal link points nowhere once pasted (Word footnotes, bookmarks, TOC entries). */
const DEAD_ANCHOR = /^#(_ftn|_edn|_Toc|_Ref|_Hlk|_cmnt|ftnt|cmnt)/i;
/** Content width of a Letter page with normal margins, for relative column widths. */
const PAGE_CONTENT_WIDTH = 624;

/** Pictures in Word's RTF, in order: PNG/JPEG only (each also has a WMF fallback we skip). */
export function rtfPictures(rtf) {
  const out = [];
  if (!rtf) return out;
  let at = 0;
  while ((at = rtf.indexOf('{\\pict', at)) >= 0) {
    // Find the end of this group, then drop its nested groups ({\*\picprop…}).
    let depth = 0;
    let end = at;
    for (; end < rtf.length; end++) {
      const c = rtf[end];
      if (c === '\\') { end++; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    const group = rtf.slice(at + 1, end);
    at = end;
    let flat = '';
    let d = 0;
    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      if (c === '\\' && d === 0) { flat += c + (group[i + 1] || ''); i++; continue; }
      if (c === '\\') { i++; continue; }
      if (c === '{') d++;
      else if (c === '}') d--;
      else if (d === 0) flat += c;
    }
    const mime = /\\pngblip/.test(flat) ? 'image/png' : /\\jpegblip/.test(flat) ? 'image/jpeg' : null;
    if (!mime) continue;
    const hex = (/(?:\\[a-z]+-?\d* ?)+([0-9a-fA-F\s]+)$/.exec(flat)?.[1] || '').replace(/\s+/g, '');
    if (hex.length < 16) continue;
    let bin = '';
    for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    out.push(`data:${mime};base64,${btoa(bin)}`);
  }
  return out;
}

function cleanGeneric(doc, { rtf = '' } = {}) {
  const body = doc.body;
  const report = { droppedImages: 0 };
  body.querySelectorAll('br.Apple-interchange-newline, o\\:p, meta, style, script, link, title, xml').forEach((el) => el.remove());

  // Old presentational HTML (LibreOffice, older sites): <font>, <center>, align="…".
  body.querySelectorAll('font').forEach((f) => {
    const span = doc.createElement('span');
    span.setAttribute('style', f.getAttribute('style') || '');
    if (f.getAttribute('color')) span.style.color = f.getAttribute('color');
    if (f.getAttribute('face')) span.style.fontFamily = f.getAttribute('face');
    const size = Number(f.getAttribute('size'));
    if (!span.style.fontSize && FONT_SIZES[size]) span.style.fontSize = `${FONT_SIZES[size]}pt`;
    span.append(...f.childNodes);
    f.replaceWith(span);
  });
  body.querySelectorAll('center').forEach((c) => {
    const div = doc.createElement('div');
    div.style.textAlign = 'center';
    div.append(...c.childNodes);
    c.replaceWith(div);
  });
  body.querySelectorAll('[align]').forEach((el) => {
    const a = el.getAttribute('align').toLowerCase();
    if (!el.style.textAlign && /^(center|right|justify)$/.test(a) && !/^(TABLE|IMG)$/.test(el.tagName)) el.style.textAlign = a;
    if (el.tagName !== 'IMG') el.removeAttribute('align');
  });
  // A <div> holding only text is a paragraph (keeping its alignment and spacing).
  body.querySelectorAll('div').forEach((div) => {
    if (div.matches('[data-page-break]') || [...div.children].some(isBlock) || !div.textContent.trim()) return;
    const p = doc.createElement('p');
    for (const a of div.attributes) if (a.name === 'style') p.setAttribute('style', a.value);
    p.append(...div.childNodes);
    div.replaceWith(p);
  });

  // Page breaks written as CSS on a paragraph or rule (Google Docs, LibreOffice).
  body.querySelectorAll('[style*="break-"]').forEach((el) => {
    if (el.tagName === 'BR') return; // the editor reads Word's <br style="page-break-before"> itself
    const css = el.getAttribute('style');
    const before = /page-break-before:\s*always|break-before:\s*page/i.test(css);
    const after = /page-break-after:\s*always|break-after:\s*page/i.test(css);
    if (!before && !after) return;
    const make = () => {
      const d = doc.createElement('div');
      d.setAttribute('data-page-break', '');
      return d;
    };
    if (el.tagName === 'HR') {
      el.replaceWith(make());
      return;
    }
    if (before) el.before(make());
    if (after) el.after(make());
    el.style.removeProperty('page-break-before');
    el.style.removeProperty('page-break-after');
    el.style.removeProperty('break-before');
    el.style.removeProperty('break-after');
  });

  // Text formatting that only restates the defaults, or can't apply here.
  for (const el of body.querySelectorAll('[style]')) {
    const st = el.style;
    if (st.color && isDefaultColor(st.color)) st.removeProperty('color');
    if (/^11(\.0)?pt$/i.test(st.fontSize)) st.removeProperty('font-size');
    if (st.fontFamily) {
      // Word for the web's internal font names; Calibri is the document default.
      const fonts = st.fontFamily.split(',').map((f) => f.trim()).filter((f) => !/_(EmbeddedFont|MSFontService)["']?$/i.test(f));
      if (/^["']?calibri["']?$/i.test(fonts[0] || '')) st.removeProperty('font-family');
      else st.fontFamily = fonts.join(', ');
    }
    // Superscript/subscript: the tag carries it; a relative size on top would shrink it twice.
    const va = st.verticalAlign;
    if ((va === 'super' || va === 'sub') && el.tagName === 'SPAN') {
      const tag = doc.createElement(va === 'super' ? 'sup' : 'sub');
      tag.append(...el.childNodes);
      el.append(tag);
      st.removeProperty('vertical-align');
      if (/(em|%)$/.test(st.fontSize)) st.removeProperty('font-size');
    }
    // A coloured background on text is a highlight.
    const bg = st.backgroundColor || (/^#?[\w(),.\s]+$/.test(st.background || '') ? st.background : '');
    if (!isBlock(el) && el.tagName !== 'MARK' && bg && !isNoBackground(bg)) {
      const mark = doc.createElement('mark');
      mark.setAttribute('data-color', bg);
      mark.style.backgroundColor = bg;
      mark.append(...el.childNodes);
      el.append(mark);
    }
    if (!isBlock(el)) {
      st.removeProperty('background-color');
      st.removeProperty('background');
    }
  }
  // Headings keep their structure and emphasis; their look comes from the heading style.
  body.querySelectorAll('h1 [style], h2 [style], h3 [style], h4 [style], h5 [style], h6 [style]').forEach((el) => {
    for (const prop of ['font-size', 'font-family', 'color', 'line-height']) el.style.removeProperty(prop);
  });

  // Links: Google's redirect wrapper, and anchors that point nowhere once pasted.
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    const m = /^https?:\/\/www\.google\.[a-z.]+\/url\?(?:.*&)?q=([^&]+)/.exec(href);
    if (m) {
      try {
        a.setAttribute('href', decodeURIComponent(m[1]));
      } catch { /* leave it */ }
    } else if (DEAD_ANCHOR.test(href)) {
      const ref = /ftn|edn/i.test(href) && /^\[?\d+\]?$/.test(a.textContent.trim());
      const repl = ref ? Object.assign(doc.createElement('sup'), { textContent: a.textContent.trim().replace(/[[\]]/g, '') }) : null;
      if (repl) a.replaceWith(repl);
      else a.replaceWith(...a.childNodes);
    }
  });

  // Table column widths: Word and LibreOffice give them on cells or as relative <col>s.
  body.querySelectorAll('table').forEach((table) => {
    const cols = [...table.querySelectorAll(':scope > colgroup > col, :scope > col')];
    if (cols.length && cols.some((c) => /\*$/.test(c.getAttribute('width') || ''))) {
      const rel = cols.map((c) => parseFloat(c.getAttribute('width')) || 1);
      const sum = rel.reduce((a, b) => a + b, 0);
      cols.forEach((c, i) => c.setAttribute('width', String(Math.round((rel[i] / sum) * PAGE_CONTENT_WIDTH))));
    }
    if (cols.length) return; // the editor reads <col width> itself
    for (const cell of table.querySelectorAll('td, th')) {
      if (cell.hasAttribute('colwidth') || Number(cell.getAttribute('colspan') || 1) > 1) continue;
      const w = lengthPx(cell.style.width) || (/^\d+$/.test(cell.getAttribute('width') || '') ? Number(cell.getAttribute('width')) : null);
      if (w) cell.setAttribute('colwidth', String(Math.round(w)));
    }
  });

  // Pictures Word put on the clipboard as local temp files: take them from its RTF, or drop them.
  const pictures = rtfPictures(rtf);
  body.querySelectorAll('img').forEach((img) => {
    if (!/^file:/i.test(img.getAttribute('src') || '')) return;
    const src = pictures.shift();
    if (src) img.setAttribute('src', src);
    else {
      img.remove();
      report.droppedImages++;
    }
  });
  return report;
}

/** Undo what LibreWord adds to copied HTML for other apps (paste-formatting.js). */
function restoreOwnCopy(html) {
  if (!/lw-copy-only|data-lw-style/.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('.lw-copy-only').forEach((el) => el.remove());
  doc.querySelectorAll('[data-lw-style]').forEach((el) => {
    const original = el.getAttribute('data-lw-style');
    if (original) el.setAttribute('style', original);
    else el.removeAttribute('style');
    el.removeAttribute('data-lw-style');
  });
  return doc.body.innerHTML;
}

/** What the last paste had to leave out, for a notice. */
export const lastPasteReport = { droppedImages: 0 };

/**
 * Clean HTML pasted from other apps so it becomes the same document there:
 * Word (desktop and web), Google Docs, LibreOffice and web pages. HTML copied
 * from LibreWord itself (marked with data-pm-slice) is left alone apart from
 * the extras added for other apps on copy.
 */
export function transformPastedHTML(html, { rtf = '' } = {}) {
  lastPasteReport.droppedImages = 0;
  if (/data-pm-slice/.test(html)) return restoreOwnCopy(html);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (isWordHtml(html)) cleanWord(doc);
  if (isWordOnlineHtml(html)) cleanWordOnline(doc);
  if (isGoogleDocsHtml(html)) cleanGoogleDocs(doc);
  Object.assign(lastPasteReport, cleanGeneric(doc, { rtf }));
  return doc.body.innerHTML;
}
