import { Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/** Collect headings from a ProseMirror doc (or its JSON) for TOCs and navigation. */
export function collectHeadings(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push({ level: node.attrs.level, text: node.textContent.trim(), pos });
      return false;
    }
    return node.type.name !== 'table';
  });
  return out.filter((h) => h.text);
}

/**
 * A live table of contents: an atom node whose view re-renders from the
 * document's headings (with page numbers taken from the paginated layout).
 */
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { getPageOf: null };
  },

  parseHTML() {
    return [{ tag: 'nav[data-toc]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['nav', mergeAttributes(HTMLAttributes, { 'data-toc': '', class: 'toc' })];
  },

  addCommands() {
    return {
      insertTableOfContents: () => ({ commands }) => commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    const options = this.options;
    return ({ editor }) => {
      const dom = document.createElement('nav');
      dom.className = 'toc';
      dom.setAttribute('data-toc', '');
      dom.contentEditable = 'false';
      let frame = 0;
      let signature = '';

      const render = () => {
        frame = 0;
        if (!editor.view || editor.isDestroyed) return;
        const headings = collectHeadings(editor.state.doc);
        const pages = headings.map((h) => {
          try {
            return options.getPageOf ? options.getPageOf(h.pos) : null;
          } catch {
            return null;
          }
        });
        const sig = JSON.stringify([headings.map((h) => [h.level, h.text, h.pos]), pages]);
        if (sig === signature) return;
        signature = sig;

        dom.replaceChildren();
        const title = document.createElement('div');
        title.className = 'toc-title';
        title.textContent = 'Contents';
        dom.append(title);
        if (!headings.length) {
          const empty = document.createElement('div');
          empty.className = 'toc-empty';
          empty.textContent = 'No headings yet. Apply Heading styles to build the table of contents.';
          dom.append(empty);
          return;
        }
        const minLevel = Math.min(...headings.map((h) => h.level));
        headings.forEach((h, i) => {
          const row = document.createElement('a');
          row.className = `toc-entry toc-level-${h.level - minLevel + 1}`;
          row.href = '#';
          const text = document.createElement('span');
          text.className = 'toc-text';
          text.textContent = h.text;
          const dots = document.createElement('span');
          dots.className = 'toc-dots';
          const page = document.createElement('span');
          page.className = 'toc-page';
          page.textContent = pages[i] ?? '';
          row.append(text, dots, page);
          row.addEventListener('mousedown', (e) => e.preventDefault());
          row.addEventListener('click', (e) => {
            e.preventDefault();
            const target = collectHeadings(editor.state.doc)[i];
            if (!target) return;
            const tr = editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(target.pos + 1)));
            editor.view.dispatch(tr.scrollIntoView());
            editor.view.focus();
          });
          dom.append(row);
        });
      };
      // Debounced: rebuilding the TOC walks the whole document.
      const schedule = () => {
        clearTimeout(frame);
        frame = setTimeout(render, signature ? 250 : 0);
      };
      editor.on('update', schedule);
      editor.on('pagination', schedule);
      schedule();

      return {
        dom,
        ignoreMutation: () => true,
        stopEvent: (e) => Boolean(e.target?.closest?.('.toc-entry')),
        destroy() {
          clearTimeout(frame);
          editor.off('update', schedule);
          editor.off('pagination', schedule);
        },
      };
    };
  },
});
