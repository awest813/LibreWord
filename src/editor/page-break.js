import { Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/** A hard page break. Pagination pushes whatever follows to the next page. */
export const PageBreak = Node.create({
  name: 'pageBreak',
  // Above HardBreak, which also binds Mod-Enter.
  priority: 1000,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [
      { tag: 'div[data-page-break]' },
      { tag: 'hr.page-break' },
      // Word's own HTML (and mammoth) use CSS page-break-before/after.
      {
        tag: 'br',
        getAttrs: (el) => (/page-break-before:\s*always|break-before:\s*page/i.test(el.getAttribute('style') || '') ? {} : false),
        priority: 60,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-break': '', class: 'page-break', contenteditable: 'false' })];
  },

  addCommands() {
    return {
      setPageBreak: () => ({ state, tr, dispatch }) => {
        const { $from } = state.selection;
        const node = this.type.create();
        if (!dispatch) return true;
        // Split the current text block so the break lands between paragraphs.
        if ($from.parent.isTextblock && $from.depth > 0) {
          tr.deleteSelection();
          const $pos = tr.selection.$from;
          let insertPos;
          if ($pos.depth > 1) {
            // Inside a list, quote or table: break after the whole top-level block.
            insertPos = $pos.after(1);
          } else if ($pos.parentOffset === 0) {
            insertPos = $pos.before(1);
          } else if ($pos.parentOffset === $pos.parent.content.size) {
            insertPos = $pos.after(1);
          } else {
            tr.split($pos.pos);
            insertPos = tr.doc.resolve(tr.mapping.map($pos.pos)).before(1);
          }
          tr.insert(insertPos, node);
          const after = insertPos + node.nodeSize;
          if (after >= tr.doc.content.size || !tr.doc.nodeAt(after)?.isTextblock) {
            tr.insert(after, state.schema.nodes.paragraph.create());
          }
          tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
        } else {
          tr.replaceSelectionWith(node);
        }
        dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
  },
});
