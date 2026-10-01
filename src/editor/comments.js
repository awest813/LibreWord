import { Mark, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/**
 * A comment anchor. The mark only stores the comment id; the comment thread
 * itself (author, text, replies, resolved) lives with the document's data.
 */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '', // comments may overlap
  spanning: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => ({ 'data-comment-id': attrs.id }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'lw-comment' }), 0];
  },

  addCommands() {
    return {
      setComment: (id) => ({ state, tr, dispatch }) => {
        let { from, to, empty } = state.selection;
        if (empty) {
          // Like Word: comment on the word at the cursor.
          const $pos = state.selection.$from;
          const text = $pos.parent.textContent;
          let a = $pos.parentOffset;
          let b = a;
          while (a > 0 && /[\p{L}\p{N}_'’-]/u.test(text[a - 1])) a--;
          while (b < text.length && /[\p{L}\p{N}_'’-]/u.test(text[b])) b++;
          if (a === b) return false;
          from = $pos.start() + a;
          to = $pos.start() + b;
        }
        if (dispatch) {
          tr.addMark(from, to, this.type.create({ id }));
          tr.setSelection(TextSelection.create(tr.doc, to));
          dispatch(tr);
        }
        return true;
      },
      unsetComment: (id) => ({ state, tr, dispatch }) => {
        const ranges = commentRanges(state.doc).get(id);
        if (!ranges) return false;
        if (dispatch) {
          state.doc.descendants((node, pos) => {
            if (!node.isText) return true;
            const mark = node.marks.find((m) => m.type === this.type && m.attrs.id === id);
            if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
            return false;
          });
          dispatch(tr);
        }
        return true;
      },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Alt-m': () => {
        this.editor.emit('requestComment');
        return true;
      },
    };
  },
});

/** Map of comment id → { from, to } spanning all of its anchored text. */
export function commentRanges(doc) {
  const out = new Map();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name !== 'comment' || !m.attrs.id) continue;
      const r = out.get(m.attrs.id);
      const end = pos + node.nodeSize;
      if (r) {
        r.from = Math.min(r.from, pos);
        r.to = Math.max(r.to, end);
      } else out.set(m.attrs.id, { from: pos, to: end });
    }
    return false;
  });
  return out;
}

export function commentIdsAt(state) {
  const ids = new Set();
  const { $from, $to } = state.selection;
  for (const m of [...$from.marks(), ...($to.nodeBefore?.marks || [])]) {
    if (m.type.name === 'comment') ids.add(m.attrs.id);
  }
  return ids;
}
