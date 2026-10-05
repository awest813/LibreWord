import { Extension } from '@tiptap/core';

/** Word-like word count: runs of letters/digits, keeping contractions, emails and hyphenations whole. */
export function countWords(text) {
  const m = String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_.@]*/gu);
  return m ? m.length : 0;
}

/** Marks that carry content rather than formatting. */
export const KEEP_MARKS = new Set(['comment', 'link']);

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** The size (in pt) the selection is actually rendered at. */
export function currentFontSizePt(editor) {
  const explicit = String(editor.getAttributes('textStyle').fontSize || '').trim();
  // Only pt and px are taken at face value; em, %, keywords… are resolved by the browser.
  const m = /^(\d*\.?\d+)\s*(pt|px)?$/i.exec(explicit);
  if (m) return m[2]?.toLowerCase() === 'px' ? Math.round(m[1] * 0.75 * 2) / 2 : +m[1];
  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const el = node.nodeType === 1 ? node : node.parentElement;
    const px = parseFloat(getComputedStyle(el).fontSize);
    return Number.isFinite(px) && px > 0 ? Math.round(px * 0.75 * 2) / 2 : 11;
  } catch {
    return 11;
  }
}

export function currentFontFamily(editor) {
  const explicit = editor.getAttributes('textStyle').fontFamily;
  if (explicit) return explicit;
  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const el = node.nodeType === 1 ? node : node.parentElement;
    return getComputedStyle(el).fontFamily;
  } catch {
    return '';
  }
}

const CASES = {
  lower: (s) => s.toLocaleLowerCase(),
  upper: (s) => s.toLocaleUpperCase(),
  sentence: (s) => s.toLocaleLowerCase().replace(/(^\s*\p{L}|[.!?]\s+\p{L})/gmu, (m) => m.toLocaleUpperCase()),
  title: (s) => s.toLocaleLowerCase().replace(/(^|[\s\-–—(["'“‘\ufffc])(\p{L})/gu, (_m, a, b) => a + b.toLocaleUpperCase()),
  toggle: (s) => [...s].map((c) => (c === c.toLocaleUpperCase() ? c.toLocaleLowerCase() : c.toLocaleUpperCase())).join(''),
};

export const WordCommands = Extension.create({
  name: 'wordCommands',

  addCommands() {
    return {
      changeCase: (mode) => ({ state, tr, dispatch }) => {
        const { from, to, empty } = state.selection;
        if (empty || !CASES[mode]) return false;
        if (!dispatch) return true;
        // Change the selection as one string so sentence and title rules see
        // across formatting ("hel**lo**" → "Hello", not "HelLo").
        const parts = [];
        let text = '';
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.isText) {
            const start = Math.max(from, pos);
            const slice = node.text.slice(start - pos, Math.min(to, pos + node.nodeSize) - pos);
            parts.push({ start, offset: text.length, slice, marks: node.marks });
            text += slice;
          } else if (node.isBlock) {
            if (text) text += '\n';
          } else text += node.type.name === 'hardBreak' ? '\n' : '\ufffc';
          return true;
        });
        const changed = CASES[mode](text);
        for (const { start, offset, slice, marks } of parts) {
          // Rare letters change length when cased (ß → SS); then fall back to per-run changes.
          const next = changed.length === text.length ? changed.slice(offset, offset + slice.length) : CASES[mode](slice);
          if (next !== slice && next.length === slice.length) {
            tr.replaceWith(start, start + slice.length, state.schema.text(next, marks));
          }
        }
        dispatch(tr);
        return true;
      },
      cycleCase: () => ({ state, commands }) => {
        const text = state.doc.textBetween(state.selection.from, state.selection.to, ' ');
        if (!text) return false;
        if (text === text.toLocaleUpperCase()) return commands.changeCase('lower');
        if (text === text.toLocaleLowerCase()) return commands.changeCase('title');
        return commands.changeCase('upper');
      },
      growFont: () => ({ editor, commands }) => {
        const size = currentFontSizePt(editor);
        const next = FONT_SIZES.find((s) => s > size) ?? Math.min(1638, Math.ceil(size / 10) * 10 + 10);
        return commands.setFontSize(`${next}pt`);
      },
      shrinkFont: () => ({ editor, commands }) => {
        const size = currentFontSizePt(editor);
        const next = [...FONT_SIZES].reverse().find((s) => s < size) ?? Math.max(1, size - 1);
        return commands.setFontSize(`${next}pt`);
      },
      /** Remove character formatting but keep comments and hyperlinks (they're content, not formatting). */
      unsetFormattingMarks: () => ({ state, tr, dispatch }) => {
        const { from, to, empty } = state.selection;
        if (empty) {
          if (dispatch) dispatch(tr.setStoredMarks((state.storedMarks || state.selection.$from.marks()).filter((m) => KEEP_MARKS.has(m.type.name))));
          return true;
        }
        if (dispatch) {
          for (const type of Object.values(state.schema.marks)) if (!KEEP_MARKS.has(type.name)) tr.removeMark(from, to, type);
          dispatch(tr);
        }
        return true;
      },
      clearFormatting: () => ({ chain }) =>
        chain().unsetFormattingMarks().resetParagraphFormat().unsetTextAlign().run(),
    };
  },

  addKeyboardShortcuts() {
    const e = () => this.editor;
    return {
      'Mod-l': () => e().commands.setTextAlign('left'),
      'Mod-e': () => e().commands.setTextAlign('center'),
      'Mod-r': () => e().commands.setTextAlign('right'),
      'Mod-j': () => e().commands.setTextAlign('justify'),
      'Mod-]': () => e().commands.growFont(),
      'Mod-[': () => e().commands.shrinkFont(),
      'Mod-Shift->': () => e().commands.growFont(),
      'Mod-Shift-<': () => e().commands.shrinkFont(),
      'Mod-Shift-.': () => e().commands.growFont(),
      'Mod-Shift-,': () => e().commands.shrinkFont(),
      'Mod-=': () => e().commands.toggleSubscript(),
      'Mod-Shift-=': () => e().commands.toggleSuperscript(),
      'Mod-Shift-+': () => e().commands.toggleSuperscript(),
      'Mod-Space': () => e().commands.unsetFormattingMarks(),
      'Shift-F3': () => e().commands.cycleCase(),
      'Mod-Shift-l': () => e().commands.toggleBulletList(),
    };
  },
});
