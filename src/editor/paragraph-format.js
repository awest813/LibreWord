import { Extension } from '@tiptap/core';

const BLOCK_TYPES = ['paragraph', 'heading'];
export const PARAGRAPH_STYLES = ['title', 'subtitle', 'quote', 'intense-quote', 'caption', 'no-spacing'];
const INDENT_STEP = 48; // 0.5 inch, Word's default
const MAX_INDENT = 48 * 12;

const PT_PER_PX = 0.75;

/** Parse a CSS length into px. Returns null when it can't be resolved. */
export function cssLengthToPx(value) {
  if (value == null || value === '') return null;
  const m = String(value).trim().match(/^(-?[\d.]+)\s*(px|pt|in|cm|mm|em|rem|pc)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  switch ((m[2] || 'px').toLowerCase()) {
    case 'pt': return n / PT_PER_PX;
    case 'in': return n * 96;
    case 'cm': return (n * 96) / 2.54;
    case 'mm': return (n * 96) / 25.4;
    case 'pc': return n * 16;
    case 'em':
    case 'rem': return n * 16;
    default: return n;
  }
}

export function parseLineHeight(value) {
  if (!value || value === 'normal') return null;
  const v = String(value).trim();
  if (/^[\d.]+$/.test(v)) return String(+parseFloat(v).toFixed(2));
  if (/^[\d.]+%$/.test(v)) return String(+(parseFloat(v) / 100).toFixed(2));
  return null;
}

const round = (n) => Math.round(n * 100) / 100;

function updateBlocks(tr, state, fn) {
  const { from, to } = state.selection;
  let changed = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!BLOCK_TYPES.includes(node.type.name)) return true;
    const next = fn(node.attrs);
    if (next) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next });
      changed = true;
    }
    return false;
  });
  return changed;
}

export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',

  addGlobalAttributes() {
    return [
      {
        // Named paragraph styles that aren't headings (Title, Subtitle, Quote…).
        types: ['paragraph'],
        attributes: {
          styleId: {
            default: null,
            parseHTML: (el) => {
              const fromData = el.getAttribute('data-style');
              if (fromData && PARAGRAPH_STYLES.includes(fromData)) return fromData;
              const cls = [...el.classList].find((c) => c.startsWith('pstyle-'));
              const id = cls?.slice(7);
              return id && PARAGRAPH_STYLES.includes(id) ? id : null;
            },
            renderHTML: (attrs) => (attrs.styleId ? { 'data-style': attrs.styleId, class: `pstyle-${attrs.styleId}` } : {}),
          },
        },
      },
      {
        types: BLOCK_TYPES,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => parseLineHeight(el.style.lineHeight),
            renderHTML: (attrs) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}),
          },
          spaceBefore: {
            default: null,
            parseHTML: (el) => {
              const px = cssLengthToPx(el.style.marginTop || el.style.paddingTop);
              return px == null ? null : round(px * PT_PER_PX);
            },
            renderHTML: (attrs) => (attrs.spaceBefore != null ? { style: `padding-top: ${attrs.spaceBefore}pt` } : {}),
          },
          spaceAfter: {
            default: null,
            parseHTML: (el) => {
              const px = cssLengthToPx(el.style.marginBottom);
              return px == null ? null : round(px * PT_PER_PX);
            },
            renderHTML: (attrs) => (attrs.spaceAfter != null ? { style: `margin-bottom: ${attrs.spaceAfter}pt` } : {}),
          },
          indent: {
            default: 0,
            parseHTML: (el) => {
              const px = cssLengthToPx(el.style.marginLeft || el.style.paddingLeft);
              return px && px > 0 ? Math.min(MAX_INDENT, Math.round(px)) : 0;
            },
            renderHTML: (attrs) => (attrs.indent ? { style: `margin-left: ${attrs.indent}px` } : {}),
          },
          firstLineIndent: {
            default: 0,
            parseHTML: (el) => {
              const px = cssLengthToPx(el.style.textIndent);
              return px ? Math.round(px) : 0;
            },
            renderHTML: (attrs) => (attrs.firstLineIndent ? { style: `text-indent: ${attrs.firstLineIndent}px` } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      applyStyle: (name) => ({ chain }) => {
        const heading = /^heading([1-6])$/.exec(name);
        if (heading) return chain().setHeading({ level: Number(heading[1]) }).run();
        const styleId = name === 'normal' ? null : name;
        if (styleId && !PARAGRAPH_STYLES.includes(styleId)) return false;
        return chain().setParagraph().updateAttributes('paragraph', { styleId }).run();
      },
      setLineHeight: (lineHeight) => ({ tr, state, dispatch }) => {
        const changed = updateBlocks(tr, state, () => ({ lineHeight: lineHeight || null }));
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
      setParagraphSpacing: ({ before, after } = {}) => ({ tr, state, dispatch }) => {
        const changed = updateBlocks(tr, state, () => {
          const next = {};
          if (before !== undefined) next.spaceBefore = before;
          if (after !== undefined) next.spaceAfter = after;
          return next;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
      setParagraphIndent: ({ indent, firstLineIndent } = {}) => ({ tr, state, dispatch }) => {
        const changed = updateBlocks(tr, state, () => {
          const next = {};
          if (indent !== undefined) next.indent = Math.max(0, Math.min(MAX_INDENT, Math.round(indent)));
          if (firstLineIndent !== undefined) next.firstLineIndent = Math.round(firstLineIndent);
          return next;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
      increaseIndent: () => ({ editor, commands, tr, state, dispatch }) => {
        if (editor.isActive('listItem') && commands.sinkListItem('listItem')) return true;
        if (editor.isActive('taskItem') && commands.sinkListItem('taskItem')) return true;
        if (editor.isActive('listItem') || editor.isActive('taskItem')) return false;
        const changed = updateBlocks(tr, state, (a) => ({ indent: Math.min(MAX_INDENT, (a.indent || 0) + INDENT_STEP) }));
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
      decreaseIndent: () => ({ editor, commands, tr, state, dispatch }) => {
        if (editor.isActive('listItem')) return commands.liftListItem('listItem');
        if (editor.isActive('taskItem')) return commands.liftListItem('taskItem');
        const changed = updateBlocks(tr, state, (a) => (a.indent ? { indent: Math.max(0, a.indent - INDENT_STEP) } : null));
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
      resetParagraphFormat: () => ({ tr, state, dispatch }) => {
        const changed = updateBlocks(tr, state, () => ({
          lineHeight: null, spaceBefore: null, spaceAfter: null, indent: 0, firstLineIndent: 0,
        }));
        if (changed && dispatch) dispatch(tr);
        return changed;
      },
    };
  },

  addKeyboardShortcuts() {
    const insideTable = () => this.editor.isActive('tableCell') || this.editor.isActive('tableHeader');
    return {
      Tab: () => {
        if (insideTable()) return false;
        if (this.editor.isActive('listItem') || this.editor.isActive('taskItem')) {
          // Even when the item can't be indented (the first one), don't let Tab move focus away.
          this.editor.commands.increaseIndent();
          return true;
        }
        if (this.editor.isActive('codeBlock')) return this.editor.commands.insertContent('  ');
        return this.editor.commands.insertContent('\t');
      },
      'Shift-Tab': () => {
        if (insideTable()) return false;
        this.editor.commands.decreaseIndent();
        return true;
      },
      'Mod-m': () => this.editor.commands.increaseIndent(),
      'Mod-Shift-m': () => this.editor.commands.decreaseIndent(),
      'Mod-1': () => this.editor.commands.setLineHeight('1'),
      'Mod-5': () => this.editor.commands.setLineHeight('1.5'),
      'Mod-2': () => this.editor.commands.setLineHeight('2'),
    };
  },
});
