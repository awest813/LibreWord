import { h, formatDate, debounce, shortcutLabel } from './dom.js';
import { icon } from './icons.js';
import { commentRanges, commentIdsAt } from '../editor/comments.js';
import { TextSelection } from '@tiptap/pm/state';

const COLORS = ['#c239b3', '#0f6cbd', '#0e7a0d', '#ca5010', '#8764b8', '#038387', '#c50f1f', '#4f6bed'];
const colorFor = (name = '') => COLORS[[...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
export const initialsOf = (name = '') => name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

/** Side pane listing the document's comments in reading order. */
export class CommentsPane {
  constructor(app) {
    this.app = app;
    this.active = new Set();
    this.drafts = new Map(); // unposted comment text survives re-renders
    this.signature = '';
    this.list = h('div', { class: 'comments-list' });
    this.el = h(
      'aside',
      { class: 'comments-pane', hidden: true, 'aria-label': 'Comments' },
      h('header', {}, h('span', {}, 'Comments'), h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close comments', html: icon('close'), onclick: () => app.toggleComments(false) })),
      this.list,
    );
    this.style = h('style', {});
    document.head.append(this.style);
    this.refresh = debounce(() => this.render(), 150);
  }

  destroy() {
    this.style.remove();
  }

  get visible() {
    return !this.el.hidden;
  }

  setActive(ids) {
    const same = ids.size === this.active.size && [...ids].every((i) => this.active.has(i));
    this.active = ids;
    if (!same) {
      this.updateStyle();
      this.list.querySelectorAll('.comment-card').forEach((c) => c.classList.toggle('is-active', ids.has(c.dataset.id)));
    }
  }

  updateStyle() {
    const esc = (s) => String(s).replace(/["\\]/g, '\\$&');
    const resolved = Object.values(this.app.comments).filter((c) => c.resolved).map((c) => `.lw-document .lw-comment[data-comment-id="${esc(c.id)}"]`);
    const active = [...this.active].map((id) => `.lw-document .lw-comment[data-comment-id="${esc(id)}"]`);
    this.style.textContent = [
      resolved.length ? `${resolved.join(',')} { background: none; border-bottom-color: transparent; }` : '',
      active.length ? `${active.join(',')} { background: rgba(255, 196, 0, 0.55); }` : '',
    ].join('\n');
  }

  render({ focusId } = {}) {
    this.updateStyle();
    if (!this.visible) return;
    const { doc } = this.app.editor.state;
    const ranges = commentRanges(doc);
    const ids = [...ranges.entries()].sort((a, b) => a[1].from - b[1].from).map(([id]) => id).filter((id) => this.app.comments[id]);
    // Skip rebuilding when nothing visible changed (most document edits).
    const signature = JSON.stringify([focusId, ids.map((id) => [this.app.comments[id], doc.textBetween(ranges.get(id).from, ranges.get(id).to, ' ').slice(0, 80)])]);
    if (signature === this.signature && !focusId) return;
    this.signature = focusId ? '' : signature;
    // Keep keyboard focus in a reply/comment box across the rebuild.
    const focused = this.list.contains(document.activeElement) ? document.activeElement : null;
    const refocus = focused && { id: focused.closest('.comment-card')?.dataset.id, cls: focused.className, start: focused.selectionStart, end: focused.selectionEnd, value: focused.value };
    this.list.replaceChildren();
    if (!ids.length) {
      this.list.append(h('div', { class: 'nav-empty' }, `No comments yet. Select some text and choose New Comment (${shortcutLabel('Mod-Alt-M')}).`));
      return;
    }
    for (const id of ids) this.list.append(this.card(this.app.comments[id], ranges.get(id), focusId === id));
    if (refocus?.id && !focusId) {
      const el = this.list.querySelector(`.comment-card[data-id="${CSS.escape(refocus.id)}"] ${refocus.cls ? `.${refocus.cls.split(' ')[0]}` : 'textarea'}`)
        || this.list.querySelector(`.comment-card[data-id="${CSS.escape(refocus.id)}"] textarea`);
      if (el) {
        if (refocus.value != null) el.value = refocus.value;
        el.focus();
        el.setSelectionRange?.(refocus.start, refocus.end);
      }
    }
  }

  card(c, range, editing) {
    const app = this.app;
    const card = h('article', { class: `comment-card${c.resolved ? ' is-resolved' : ''}${this.active.has(c.id) ? ' is-active' : ''}`, 'data-id': c.id, tabindex: '-1' });
    const avatar = (name) => h('span', { class: 'avatar', style: { background: colorFor(name) }, 'aria-hidden': 'true' }, initialsOf(name));
    const quote = app.editor.state.doc.textBetween(range.from, range.to, ' ').slice(0, 80);
    const actions = h(
      'div',
      { class: 'comment-actions' },
      h('button', { type: 'button', class: 'icon-btn', title: c.resolved ? 'Reopen' : 'Resolve', 'aria-label': c.resolved ? 'Reopen comment' : 'Resolve comment', html: icon(c.resolved ? 'undo' : 'check'), onclick: (e) => { e.stopPropagation(); app.resolveComment(c.id, !c.resolved); } }),
      h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete comment', html: icon('trash'), onclick: (e) => { e.stopPropagation(); app.deleteComment(c.id); } }),
    );
    card.append(
      h('header', {}, avatar(c.author), h('div', { class: 'who' }, h('strong', {}, c.author), h('small', {}, `${formatDate(c.date)}${c.resolved ? ' · Resolved' : ''}`)), actions),
      h('blockquote', { class: 'comment-quote' }, quote),
    );

    if (editing || !c.text) {
      const ta = h('textarea', { class: 'comment-input', rows: '3', placeholder: 'Add a comment…', 'aria-label': 'Comment text' });
      ta.value = this.drafts.get(c.id) ?? c.text ?? '';
      ta.addEventListener('input', () => this.drafts.set(c.id, ta.value));
      const post = () => {
        const v = ta.value.trim();
        if (!v) return cancel();
        this.drafts.delete(c.id);
        app.updateComment(c.id, { text: v });
      };
      const cancel = () => {
        this.drafts.delete(c.id);
        if (!c.text) app.deleteComment(c.id);
        else {
          this.signature = '';
          this.render();
        }
      };
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          post();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
          app.editor.commands.focus();
        }
      });
      card.append(ta, h('div', { class: 'comment-buttons' }, h('button', { type: 'button', class: 'btn', onclick: cancel }, 'Cancel'), h('button', { type: 'button', class: 'btn btn-primary', onclick: post }, 'Post')));
      // Only take focus when the user just asked to write/edit this comment.
      if (editing) requestAnimationFrame(() => ta.focus());
    } else {
      const text = h('p', { class: 'comment-text', title: 'Double-click to edit' }, c.text);
      text.addEventListener('dblclick', () => this.render({ focusId: c.id }));
      card.append(text);
    }

    for (const r of c.replies || []) {
      card.append(h('div', { class: 'comment-reply' }, h('header', {}, avatar(r.author), h('div', { class: 'who' }, h('strong', {}, r.author), h('small', {}, formatDate(r.date)))), h('p', { class: 'comment-text' }, r.text)));
    }
    if (c.text && !c.resolved) {
      const reply = h('input', { type: 'text', class: 'comment-reply-input', placeholder: 'Reply…', 'aria-label': 'Reply' });
      reply.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && reply.value.trim()) {
          e.preventDefault();
          const text = reply.value.trim();
          reply.value = ''; // before the pane rebuilds and carries the box's text over
          app.replyToComment(c.id, text);
        } else if (e.key === 'Escape') {
          reply.value = '';
          app.editor.commands.focus();
        }
      });
      card.append(reply);
    }

    card.addEventListener('click', (e) => {
      if (e.target.closest('textarea, input, button')) return;
      const ed = app.editor;
      const r = commentRanges(ed.state.doc).get(c.id);
      if (!r) return;
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, r.from, r.to)).scrollIntoView());
      ed.view.focus();
    });
    return card;
  }

  /** Move the selection to the next / previous comment anchor. */
  step(dir) {
    const ed = this.app.editor;
    const ranges = [...commentRanges(ed.state.doc).values()].sort((a, b) => a.from - b.from);
    if (!ranges.length) return false;
    const pos = ed.state.selection.from;
    const target = dir > 0 ? ranges.find((r) => r.from > pos) || ranges[0] : [...ranges].reverse().find((r) => r.from < pos) || ranges[ranges.length - 1];
    ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, target.from, target.to)).scrollIntoView());
    ed.view.focus();
    return true;
  }

  syncSelection() {
    this.setActive(commentIdsAt(this.app.editor.state));
  }
}
