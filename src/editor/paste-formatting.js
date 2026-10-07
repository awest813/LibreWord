/**
 * Pasting from other apps: clean their HTML (src/io/paste.js), take Word's
 * pictures from its RTF, keep the pasted paragraph's style when pasting into
 * an empty line (as Word does), and copy pictures from the web into the
 * document so it keeps working offline and exports with them.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DOMSerializer } from '@tiptap/pm/model';
import { transformPastedHTML, lastPasteReport } from '../io/paste.js';

export const pasteKey = new PluginKey('pasteFormatting');
const MAX_PICTURE_BYTES = 15 * 1024 * 1024;

/**
 * Copying to other apps: Word and Google Docs don't know LibreWord's classes,
 * so named paragraph styles also go out as inline formatting, checklists get
 * a visible box, and page breaks use Word's markup. Everything added is
 * tagged so pasting back into LibreWord restores the original (see paste.js).
 */
const COPY_STYLES = {
  title: 'font-size:28pt;font-family:"Calibri Light",Carlito,sans-serif;line-height:1',
  subtitle: 'color:#5a5a5a;letter-spacing:0.75pt',
  quote: 'font-style:italic;color:#404040;text-align:center',
  'intense-quote': 'font-style:italic;color:#2f5496;text-align:center;border-top:1px solid #2f5496;border-bottom:1px solid #2f5496',
  caption: 'font-style:italic;font-size:9pt;color:#44546a',
  'no-spacing': 'margin-top:0;margin-bottom:0;line-height:1',
};

function decorateForCopy(root) {
  const doc = root.ownerDocument;
  for (const p of root.querySelectorAll('p[data-style]')) {
    const extra = COPY_STYLES[p.getAttribute('data-style')];
    if (!extra) continue;
    p.setAttribute('data-lw-style', p.getAttribute('style') || '');
    p.setAttribute('style', `${extra};${p.getAttribute('style') || ''}`);
  }
  for (const li of root.querySelectorAll('li[data-type="taskItem"]')) {
    const box = doc.createElement('span');
    box.className = 'lw-copy-only';
    box.textContent = li.getAttribute('data-checked') === 'true' ? '☒ ' : '☐ ';
    li.querySelector(':scope > label')?.remove();
    const target = li.querySelector('p') || li;
    target.prepend(box);
  }
  for (const brk of root.querySelectorAll('div[data-page-break]')) {
    const br = doc.createElement('br');
    br.setAttribute('clear', 'all');
    br.setAttribute('style', 'page-break-before:always');
    brk.replaceWith(br);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export const PasteFormatting = Extension.create({
  name: 'pasteFormatting',

  addOptions() {
    return {
      /** Called with { droppedImages } when a paste had to leave pictures out. */
      onReport: null,
      /** Fetch web pictures into the document after pasting (off in tests). */
      inlineImages: typeof window !== 'undefined' && typeof fetch === 'function',
    };
  },

  addProseMirrorPlugins() {
    const ext = this;
    let rtf = '';
    const tried = new Set();

    const inlineImages = async (view) => {
      const srcs = new Set();
      view.state.doc.descendants((n) => {
        const src = n.type.name === 'image' && n.attrs.src;
        if (src && /^https?:/i.test(src) && !tried.has(src)) srcs.add(src);
      });
      for (const src of srcs) {
        tried.add(src);
        try {
          const res = await fetch(src, { mode: 'cors', credentials: 'omit' });
          if (!res.ok) continue;
          const blob = await res.blob();
          if (!blob.type.startsWith('image/') || blob.size > MAX_PICTURE_BYTES) continue;
          const data = await blobToDataUrl(blob);
          if (view.isDestroyed) return;
          const tr = view.state.tr;
          view.state.doc.descendants((n, pos) => {
            if (n.type.name === 'image' && n.attrs.src === src) tr.setNodeMarkup(pos, null, { ...n.attrs, src: data });
          });
          if (tr.docChanged) view.dispatch(tr.setMeta('addToHistory', false));
        } catch {
          // Not allowed to read it (no CORS) or offline: the picture keeps its web address.
        }
      }
    };

    return [
      new Plugin({
        key: pasteKey,
        props: {
          handleDOMEvents: {
            // Runs before the HTML is parsed: keep Word's RTF, which holds its pictures.
            paste: (_view, event) => {
              try {
                rtf = event.clipboardData?.getData('text/rtf') || '';
              } catch {
                rtf = '';
              }
              return false;
            },
          },
          clipboardSerializer: {
            serializeFragment(content, options, target) {
              const out = DOMSerializer.fromSchema(ext.editor.schema).serializeFragment(content, options, target);
              const holder = (options?.document || document).createElement('div');
              holder.append(out);
              decorateForCopy(holder);
              const frag = (options?.document || document).createDocumentFragment();
              frag.append(...holder.childNodes);
              return frag;
            },
          },
          transformPastedHTML: (html) => {
            const out = transformPastedHTML(html, { rtf });
            rtf = '';
            if (lastPasteReport.droppedImages) ext.options.onReport?.({ ...lastPasteReport });
            return out;
          },
          handlePaste: (view, _event, slice) => {
            // Pasting into an empty line: the line takes the first pasted
            // paragraph's style and alignment, rather than the reverse.
            const { $from, empty } = view.state.selection;
            const first = slice.openStart > 0 ? slice.content.firstChild : null;
            if (!empty || !first?.isTextblock || !$from.parent.isTextblock || $from.parent.content.size) return false;
            if (first.type !== $from.parent.type || JSON.stringify(first.attrs) === JSON.stringify($from.parent.attrs)) return false;
            const before = $from.before();
            const tr = view.state.tr.replaceSelection(slice);
            tr.setNodeMarkup(before, first.type, first.attrs);
            view.dispatch(tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'));
            return true;
          },
        },
        view: () => ({
          update: (view, prev) => {
            if (!ext.options.inlineImages || prev.doc === view.state.doc) return;
            let pasted = false;
            view.state.doc.descendants((n) => {
              if (n.type.name === 'image' && /^https?:/i.test(n.attrs.src) && !tried.has(n.attrs.src)) pasted = true;
              return !pasted;
            });
            if (pasted) inlineImages(view);
          },
        }),
      }),
    ];
  },
});
