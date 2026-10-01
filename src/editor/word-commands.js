import { Extension } from '@tiptap/core';

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

/** The size (in pt) the selection is actually rendered at. */
export function currentFontSizePt(editor) {
  const explicit = editor.getAttributes('textStyle').fontSize;
  if (explicit) {
    const n = parseFloat(explicit);
    if (/px$/.test(explicit)) return Math.round(n * 0.75 * 2) / 2;
    return n;
  }
  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const el = node.nodeType === 1 ? node : node.parentElement;
    const px = parseFloat(getComputedStyle(el).fontSize);
    return Math.round(px * 0.75 * 2) / 2;
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
  sentence: (s) => s.toLocaleLowerCase().replace(/(^\s*\p{L}|[.!?]\s+\p{L})/gu, (m) => m.toLocaleUpperCase()),
  title: (s) => s.toLocaleLowerCase().replace(/(^|[\s\-–—(["'“‘])(\p{L})/gu, (_m, a, b) => a + b.toLocaleUpperCase()),
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
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!node.isText) return true;
          const start = Math.max(from, pos);
          const end = Math.min(to, pos + node.nodeSize);
          const slice = node.text.slice(start - pos, end - pos);
          const next = CASES[mode](slice);
          if (next !== slice && next.length === slice.length) {
            tr.replaceWith(start, end, state.schema.text(next, node.marks));
          }
          return false;
        });
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
      clearFormatting: () => ({ chain }) =>
        chain().unsetAllMarks().resetParagraphFormat().unsetTextAlign().run(),
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
      'Mod-Space': () => e().commands.unsetAllMarks(),
      'Shift-F3': () => e().commands.cycleCase(),
      'Mod-Shift-l': () => e().commands.toggleBulletList(),
    };
  },
});
