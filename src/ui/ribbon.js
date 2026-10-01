import { h, showPopover, closePopover, menu, shortcutLabel } from './dom.js';
import { icon } from './icons.js';
import { FONT_SIZES, currentFontSizePt, currentFontFamily } from '../editor/word-commands.js';
import { PAGE_SIZES, MARGIN_PRESETS, formatLength } from '../editor/page-setup.js';
import { isDark } from './theme.js';

export const FONTS = [
  { label: 'Calibri', value: 'Calibri, Carlito, sans-serif' },
  { label: 'Calibri Light', value: "'Calibri Light', Carlito, sans-serif" },
  { label: 'Aptos', value: 'Aptos, Calibri, Carlito, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Cambria', value: 'Cambria, Caladea, Georgia, serif' },
  { label: 'Candara', value: 'Candara, Calibri, sans-serif' },
  { label: 'Comic Sans MS', value: "'Comic Sans MS', 'Comic Neue', cursive" },
  { label: 'Consolas', value: "Consolas, 'Cascadia Mono', Menlo, monospace" },
  { label: 'Courier New', value: "'Courier New', Courier, monospace" },
  { label: 'Garamond', value: "Garamond, 'EB Garamond', 'Times New Roman', serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Helvetica', value: "Helvetica, 'Helvetica Neue', Arial, sans-serif" },
  { label: 'Palatino', value: "'Palatino Linotype', Palatino, 'Book Antiqua', serif" },
  { label: 'Segoe UI', value: "'Segoe UI', system-ui, sans-serif" },
  { label: 'Tahoma', value: 'Tahoma, Verdana, sans-serif' },
  { label: 'Times New Roman', value: "'Times New Roman', Times, serif" },
  { label: 'Trebuchet MS', value: "'Trebuchet MS', sans-serif" },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
];

const firstFamily = (stack = '') => stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');

const THEME_COLORS = [
  ['#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47'],
  ['#f2f2f2', '#7f7f7f', '#d0cece', '#d6dce4', '#d9e2f3', '#fbe5d5', '#ededed', '#fff2cc', '#deebf6', '#e2efd9'],
  ['#d8d8d8', '#595959', '#aeabab', '#adb9ca', '#b4c6e7', '#f7cbac', '#dbdbdb', '#fee599', '#bdd7ee', '#c5e0b3'],
  ['#bfbfbf', '#3f3f3f', '#757070', '#8496b0', '#8eaadb', '#f4b183', '#c9c9c9', '#ffd965', '#9cc3e5', '#a8d08d'],
  ['#a5a5a5', '#262626', '#3a3838', '#323f4f', '#2f5496', '#c55a11', '#7b7b7b', '#bf9000', '#2e75b5', '#538135'],
];
const STANDARD_COLORS = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
const HIGHLIGHTS = ['#ffff00', '#00ff00', '#00ffff', '#ff00ff', '#0000ff', '#ff0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#c0c0c0', '#000000'];

export const STYLES = [
  { id: 'normal', name: 'Normal', sample: 'AaBbCcDd', css: 'font-size:11px' },
  { id: 'no-spacing', name: 'No Spacing', sample: 'AaBbCcDd', css: 'font-size:11px' },
  { id: 'heading1', name: 'Heading 1', sample: 'AaBbCc', css: 'font-size:15px;color:#2f5496' },
  { id: 'heading2', name: 'Heading 2', sample: 'AaBbCcD', css: 'font-size:13px;color:#2f5496' },
  { id: 'heading3', name: 'Heading 3', sample: 'AaBbCcD', css: 'font-size:12px;color:#1f3763' },
  { id: 'title', name: 'Title', sample: 'AaBb', css: 'font-size:19px' },
  { id: 'subtitle', name: 'Subtitle', sample: 'AaBbCcD', css: 'font-size:11px;color:#5a5a5a' },
  { id: 'heading4', name: 'Heading 4', sample: 'AaBbCcD', css: 'font-size:11px;color:#2f5496;font-style:italic' },
  { id: 'quote', name: 'Quote', sample: 'AaBbCcD', css: 'font-size:11px;font-style:italic;color:#404040' },
  { id: 'intense-quote', name: 'Intense Quote', sample: 'AaBbCcD', css: 'font-size:11px;font-style:italic;color:#2f5496' },
  { id: 'caption', name: 'Caption', sample: 'AaBbCcD', css: 'font-size:10px;font-style:italic;color:#44546a' },
];

export function activeStyleId(editor) {
  for (let l = 1; l <= 6; l++) if (editor.isActive('heading', { level: l })) return `heading${l}`;
  const id = editor.getAttributes('paragraph').styleId;
  return id || 'normal';
}

const SYMBOLS = '©®™§¶†‡•…–—‘’“”«»‹›¡¿€£¥¢°±×÷≠≈≤≥∞√∑∏∫∂∆πΩµαβγδεθλσφψω←↑→↓↔⇒⇔∀∃∈∉∩∪⊂⊃¬∧∨½¼¾⅓⅔¹²³ⁿ✓✗★☆♠♣♥♦☐☒☺♪'.split('');

/**
 * Builds the ribbon UI and keeps its controls in sync with the editor.
 * `app` is the EditorScreen, which owns the editor and all document actions.
 */
export class Ribbon {
  constructor(app) {
    this.app = app;
    this.updaters = [];
    this.current = 'home';
    this.collapsed = false;
    this.el = h('div', { class: 'ribbon-wrap' });
    this.tabsEl = h('div', { class: 'ribbon-tabs', role: 'tablist', 'aria-label': 'Ribbon' });
    this.bodyEl = h('div', { class: 'ribbon', role: 'tabpanel' });
    this.el.append(this.tabsEl, this.bodyEl);
    this.tabs = this.defineTabs();
    this.renderTabs();
    this.renderBody();
  }

  get editor() {
    return this.app.editor;
  }

  // ------------------------------------------------------------------ primitives
  run(fn) {
    return () => {
      closePopover();
      fn(this.editor.chain().focus());
    };
  }

  button({ icon: ic, label, title, shortcut, large = false, showLabel = large, run, active, enabled, id }) {
    const tip = `${title || label}${shortcut ? ` (${shortcutLabel(shortcut)})` : ''}`;
    const b = h('button', {
      type: 'button',
      class: `rb${large ? ' rb-large' : ''}`,
      title: tip,
      'aria-label': title || label,
      'data-cmd': id || null,
      'aria-pressed': active ? 'false' : null,
      html: `${ic ? icon(ic) : ''}${showLabel ? `<span class="rb-label">${label}</span>` : ''}`,
    });
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor selection
    b.addEventListener('click', () => run());
    if (active || enabled) {
      this.updaters.push(() => {
        if (active) {
          const on = Boolean(active());
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-pressed', String(on));
        }
        if (enabled) b.disabled = !enabled();
      });
    }
    return b;
  }

  dropdown({ icon: ic, label, title, large = false, showLabel = large, content, active, id }) {
    const b = h('button', {
      type: 'button',
      class: `rb${large ? ' rb-large' : ''}`,
      title: title || label,
      'aria-label': title || label,
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      'data-cmd': id || null,
      html: `${ic ? icon(ic) : ''}${showLabel ? `<span class="rb-label">${label}</span>` : ''}${icon('chevronDown', 'icon rb-caret')}`,
    });
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => showPopover(b, content(), {}));
    if (active) this.updaters.push(() => b.classList.toggle('is-active', Boolean(active())));
    return b;
  }

  split({ main, content, title }) {
    const caret = h('button', { type: 'button', class: 'rb', title: `${title} options`, 'aria-label': `${title} options`, 'aria-haspopup': 'true', html: icon('chevronDown', 'icon rb-caret') });
    caret.addEventListener('mousedown', (e) => e.preventDefault());
    caret.addEventListener('click', () => showPopover(caret.parentElement, content(), {}));
    return h('div', { class: `rb-split${main.classList.contains('rb-large') ? ' is-large' : ''}` }, main, caret);
  }

  group(label, ...children) {
    return h('div', { class: 'ribbon-group', role: 'group', 'aria-label': label }, h('div', { class: 'ribbon-group-body' }, ...children), h('div', { class: 'ribbon-group-label' }, label));
  }

  col(...children) {
    return h('div', { class: 'ribbon-col' }, ...children);
  }

  row(...children) {
    return h('div', { class: 'ribbon-row' }, ...children);
  }

  // ------------------------------------------------------------------ composite controls
  fontCombo() {
    const input = h('input', { type: 'text', 'aria-label': 'Font', spellcheck: 'false', autocomplete: 'off' });
    const btn = h('button', { type: 'button', tabindex: '-1', 'aria-label': 'Font list', html: icon('chevronDown', 'icon rb-caret') });
    const wrap = h('div', { class: 'combo combo-font', title: 'Font' }, input, btn);
    const apply = (value) => {
      const match = FONTS.find((f) => f.label.toLowerCase() === value.trim().toLowerCase());
      const family = match ? match.value : value.trim();
      if (family) this.editor.chain().focus().setFontFamily(family).run();
      else this.editor.chain().focus().unsetFontFamily().run();
    };
    const open = () =>
      showPopover(
        wrap,
        menu(
          FONTS.map((f) => ({
            label: f.label,
            labelStyle: { fontFamily: f.value },
            checked: firstFamily(currentFontFamily(this.editor)).toLowerCase() === f.label.toLowerCase(),
            run: () => this.editor.chain().focus().setFontFamily(f.value).run(),
          })),
        ),
        { className: 'font-menu' },
      );
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', open);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply(input.value);
      } else if (e.key === 'Escape') {
        this.editor.commands.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        open();
      }
    });
    input.addEventListener('focus', () => input.select());
    this.updaters.push(() => {
      if (document.activeElement !== input) input.value = firstFamily(currentFontFamily(this.editor));
    });
    return wrap;
  }

  sizeCombo() {
    const input = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': 'Font size', autocomplete: 'off' });
    const btn = h('button', { type: 'button', tabindex: '-1', 'aria-label': 'Font sizes', html: icon('chevronDown', 'icon rb-caret') });
    const wrap = h('div', { class: 'combo combo-size', title: 'Font size' }, input, btn);
    const apply = (v) => {
      const n = parseFloat(v);
      if (n >= 1 && n <= 1638) this.editor.chain().focus().setFontSize(`${Math.round(n * 2) / 2}pt`).run();
    };
    const open = () => {
      const current = currentFontSizePt(this.editor);
      showPopover(wrap, menu(FONT_SIZES.map((s) => ({ label: String(s), checked: s === current, run: () => apply(s) }))), { className: 'size-menu' });
    };
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', open);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        apply(input.value);
      } else if (e.key === 'Escape') this.editor.commands.focus();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        open();
      }
    });
    input.addEventListener('focus', () => input.select());
    this.updaters.push(() => {
      if (document.activeElement !== input) input.value = String(currentFontSizePt(this.editor));
    });
    return wrap;
  }

  colorControl(kind) {
    const isText = kind === 'text';
    let last = isText ? '#c00000' : '#ffff00';
    const applyColor = (c) => {
      last = c;
      bar.style.color = c;
      const ch = this.editor.chain().focus();
      (isText ? ch.setColor(c) : ch.setHighlight({ color: c })).run();
    };
    const main = h('button', {
      type: 'button',
      class: 'rb rb-swatch',
      title: isText ? 'Font color' : 'Text highlight color',
      'aria-label': isText ? 'Font color' : 'Text highlight color',
      html: icon(isText ? 'textColor' : 'highlight'),
    });
    const bar = h('span', { class: 'swatch-bar', style: { color: last } });
    main.append(bar);
    main.addEventListener('mousedown', (e) => e.preventDefault());
    main.addEventListener('click', () => applyColor(last));

    const panel = () => {
      const p = h('div', { class: 'color-panel' });
      const chip = (c) => h('button', { type: 'button', class: 'color-chip', style: { background: c }, title: c, 'aria-label': c, onclick: () => { closePopover(); applyColor(c); } });
      if (isText) {
        p.append(
          h('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => { closePopover(); this.editor.chain().focus().unsetColor().run(); } }, h('span', { class: 'menu-icon', html: '<span style="display:inline-block;width:14px;height:14px;background:#000;border-radius:2px"></span>' }), h('span', {}, 'Automatic'), h('span')),
          h('h4', {}, 'Theme colors'),
          h('div', { class: 'color-grid' }, ...THEME_COLORS.flat().map(chip)),
          h('h4', {}, 'Standard colors'),
          h('div', { class: 'color-grid' }, ...STANDARD_COLORS.map(chip)),
        );
        const custom = h('input', { type: 'color', value: last, 'aria-label': 'Custom color' });
        custom.addEventListener('change', () => { closePopover(); applyColor(custom.value); });
        p.append(h('label', { class: 'color-custom' }, custom, 'More colors…'));
      } else {
        p.append(
          h('div', { class: 'color-grid cols-5' }, ...HIGHLIGHTS.map(chip)),
          h('button', { type: 'button', class: 'menu-item', role: 'menuitem', onclick: () => { closePopover(); this.editor.chain().focus().unsetHighlight().run(); } }, h('span', { class: 'menu-icon', html: icon('eraser') }), h('span', {}, 'No color'), h('span')),
        );
      }
      return p;
    };
    return this.split({ main, content: panel, title: isText ? 'Font color' : 'Highlight' });
  }

  styleGallery() {
    const gallery = h('div', { class: 'style-gallery', role: 'listbox', 'aria-label': 'Styles' });
    const card = (s) => {
      const c = h(
        'button',
        { type: 'button', class: 'style-card', role: 'option', title: s.name, 'data-style': s.id },
        h('span', { class: 'sample', style: s.css }, s.sample),
        h('span', { class: 'name' }, s.name),
      );
      c.addEventListener('mousedown', (e) => e.preventDefault());
      c.addEventListener('click', () => {
        closePopover();
        this.editor.chain().focus().applyStyle(s.id).run();
      });
      return c;
    };
    const visible = STYLES.slice(0, 5).map(card);
    const more = h('button', { type: 'button', class: 'style-more', title: 'More styles', 'aria-label': 'More styles', html: icon('chevronDown') });
    more.addEventListener('mousedown', (e) => e.preventDefault());
    more.addEventListener('click', () => {
      const panel = h('div', { class: 'gallery-panel' }, ...STYLES.map(card));
      const id = activeStyleId(this.editor);
      panel.querySelector(`[data-style="${id}"]`)?.classList.add('is-active');
      showPopover(more, panel, { placement: 'bottom-end' });
    });
    gallery.append(...visible, more);
    this.updaters.push(() => {
      const id = activeStyleId(this.editor);
      for (const c of visible) {
        const on = c.dataset.style === id;
        c.classList.toggle('is-active', on);
        c.setAttribute('aria-selected', String(on));
      }
    });
    return gallery;
  }

  tablePicker() {
    const wrap = h('div', { class: 'table-grid-picker' });
    const label = h('p', { class: 'table-grid-label' }, 'Insert Table');
    const grid = h('div', { class: 'table-grid', role: 'grid' });
    const cells = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 10; c++) {
        const b = h('button', { type: 'button', 'aria-label': `${c + 1} by ${r + 1} table` });
        b.addEventListener('mouseenter', () => highlight(r, c));
        b.addEventListener('focus', () => highlight(r, c));
        b.addEventListener('click', () => {
          closePopover();
          this.editor.chain().focus().insertTable({ rows: r + 1, cols: c + 1, withHeaderRow: false }).run();
        });
        cells.push([r, c, b]);
        grid.append(b);
      }
    }
    const highlight = (r, c) => {
      for (const [rr, cc, b] of cells) b.classList.toggle('is-on', rr <= r && cc <= c);
      label.textContent = `${c + 1}×${r + 1} Table`;
    };
    wrap.append(label, grid, h('div', { class: 'menu-sep' }), menu([
      { label: 'Insert Table…', icon: 'table', run: () => this.app.insertTableDialog() },
    ], { iconFn: (n) => icon(n) }));
    return wrap;
  }

  // ------------------------------------------------------------------ tabs
  defineTabs() {
    const ed = () => this.editor;
    const a = this.app;
    const B = (o) => this.button(o);
    const R = (...c) => this.row(...c);
    const C = (...c) => this.col(...c);
    const G = (l, ...c) => this.group(l, ...c);
    const iconFn = (n) => icon(n);

    const home = () => [
      G(
        'Clipboard',
        this.split({
          title: 'Paste',
          main: B({ icon: 'paste', label: 'Paste', large: true, shortcut: 'Mod-V', run: () => a.paste(false) }),
          content: () => menu([
            { label: 'Keep Source Formatting', icon: 'paste', run: () => a.paste(false) },
            { label: 'Keep Text Only', icon: 'type', shortcut: 'Mod-Shift-V', run: () => a.paste(true) },
          ], { iconFn }),
        }),
        C(
          B({ icon: 'cut', label: 'Cut', showLabel: true, shortcut: 'Mod-X', run: () => a.clipboard('cut'), enabled: () => !ed().state.selection.empty }),
          B({ icon: 'copy', label: 'Copy', showLabel: true, shortcut: 'Mod-C', run: () => a.clipboard('copy'), enabled: () => !ed().state.selection.empty }),
          B({ icon: 'painter', label: 'Format Painter', showLabel: true, run: () => a.formatPainter(), active: () => a.painterActive }),
        ),
      ),
      G(
        'Font',
        C(
          R(
            this.fontCombo(),
            this.sizeCombo(),
            B({ icon: 'growFont', label: 'Increase Font Size', shortcut: 'Mod-]', run: this.run((c) => c.growFont().run()) }),
            B({ icon: 'shrinkFont', label: 'Decrease Font Size', shortcut: 'Mod-[', run: this.run((c) => c.shrinkFont().run()) }),
            this.dropdown({
              icon: 'changeCase',
              label: 'Change Case',
              content: () => menu([
                { label: 'Sentence case.', run: () => ed().chain().focus().changeCase('sentence').run() },
                { label: 'lowercase', run: () => ed().chain().focus().changeCase('lower').run() },
                { label: 'UPPERCASE', run: () => ed().chain().focus().changeCase('upper').run() },
                { label: 'Capitalize Each Word', run: () => ed().chain().focus().changeCase('title').run() },
                { label: 'tOGGLE cASE', run: () => ed().chain().focus().changeCase('toggle').run() },
              ]),
            }),
            B({ icon: 'eraser', label: 'Clear All Formatting', run: this.run((c) => c.clearFormatting().run()) }),
          ),
          R(
            B({ icon: 'bold', label: 'Bold', shortcut: 'Mod-B', run: this.run((c) => c.toggleBold().run()), active: () => ed().isActive('bold'), id: 'bold' }),
            B({ icon: 'italic', label: 'Italic', shortcut: 'Mod-I', run: this.run((c) => c.toggleItalic().run()), active: () => ed().isActive('italic'), id: 'italic' }),
            B({ icon: 'underline', label: 'Underline', shortcut: 'Mod-U', run: this.run((c) => c.toggleUnderline().run()), active: () => ed().isActive('underline'), id: 'underline' }),
            B({ icon: 'strike', label: 'Strikethrough', run: this.run((c) => c.toggleStrike().run()), active: () => ed().isActive('strike') }),
            B({ icon: 'subscript', label: 'Subscript', shortcut: 'Mod-=', run: this.run((c) => c.toggleSubscript().run()), active: () => ed().isActive('subscript') }),
            B({ icon: 'superscript', label: 'Superscript', shortcut: 'Mod-Shift-+', run: this.run((c) => c.toggleSuperscript().run()), active: () => ed().isActive('superscript') }),
            B({ icon: 'code', label: 'Inline Code', run: this.run((c) => c.toggleCode().run()), active: () => ed().isActive('code') }),
            this.colorControl('highlight'),
            this.colorControl('text'),
          ),
        ),
      ),
      G(
        'Paragraph',
        C(
          R(
            B({ icon: 'bulletList', label: 'Bullets', shortcut: 'Mod-Shift-8', run: this.run((c) => c.toggleBulletList().run()), active: () => ed().isActive('bulletList'), id: 'bullets' }),
            B({ icon: 'orderedList', label: 'Numbering', shortcut: 'Mod-Shift-7', run: this.run((c) => c.toggleOrderedList().run()), active: () => ed().isActive('orderedList'), id: 'numbering' }),
            B({ icon: 'taskList', label: 'Checklist', shortcut: 'Mod-Shift-9', run: this.run((c) => c.toggleTaskList().run()), active: () => ed().isActive('taskList') }),
            B({ icon: 'outdent', label: 'Decrease Indent', shortcut: 'Mod-Shift-M', run: this.run((c) => c.decreaseIndent().run()) }),
            B({ icon: 'indent', label: 'Increase Indent', shortcut: 'Mod-M', run: this.run((c) => c.increaseIndent().run()) }),
            B({ icon: 'pilcrow', label: 'Show/Hide ¶', run: () => a.toggleMarks(), active: () => a.view.marks }),
          ),
          R(
            B({ icon: 'alignLeft', label: 'Align Left', shortcut: 'Mod-L', run: this.run((c) => c.setTextAlign('left').run()), active: () => isAlign(ed(), 'left') }),
            B({ icon: 'alignCenter', label: 'Center', shortcut: 'Mod-E', run: this.run((c) => c.setTextAlign('center').run()), active: () => isAlign(ed(), 'center'), id: 'center' }),
            B({ icon: 'alignRight', label: 'Align Right', shortcut: 'Mod-R', run: this.run((c) => c.setTextAlign('right').run()), active: () => isAlign(ed(), 'right') }),
            B({ icon: 'alignJustify', label: 'Justify', shortcut: 'Mod-J', run: this.run((c) => c.setTextAlign('justify').run()), active: () => isAlign(ed(), 'justify') }),
            this.dropdown({
              icon: 'rows',
              label: 'Line and Paragraph Spacing',
              content: () => {
                const lh = ed().getAttributes('paragraph').lineHeight || ed().getAttributes('heading').lineHeight;
                const attrs = { ...ed().getAttributes('heading'), ...ed().getAttributes('paragraph') };
                return menu([
                  ...['1.0', '1.15', '1.5', '2.0', '2.5', '3.0'].map((v) => ({
                    label: v,
                    checked: lh ? parseFloat(lh) === parseFloat(v) : v === '1.15',
                    run: () => ed().chain().focus().setLineHeight(String(parseFloat(v))).run(),
                  })),
                  'separator',
                  { label: 'Line Spacing Options…', run: () => a.paragraphDialog() },
                  'separator',
                  attrs.spaceBefore ? { label: 'Remove Space Before Paragraph', run: () => ed().chain().focus().setParagraphSpacing({ before: null }).run() } : { label: 'Add Space Before Paragraph', run: () => ed().chain().focus().setParagraphSpacing({ before: 12 }).run() },
                  attrs.spaceAfter === 0 ? { label: 'Add Space After Paragraph', run: () => ed().chain().focus().setParagraphSpacing({ after: null }).run() } : { label: 'Remove Space After Paragraph', run: () => ed().chain().focus().setParagraphSpacing({ after: 0 }).run() },
                ]);
              },
            }),
            B({ icon: 'quote', label: 'Block Quote', run: this.run((c) => c.toggleBlockquote().run()), active: () => ed().isActive('blockquote') }),
          ),
        ),
      ),
      G('Styles', this.styleGallery()),
      G(
        'Editing',
        C(
          B({ icon: 'search', label: 'Find', showLabel: true, shortcut: 'Mod-F', run: () => a.openFind(false) }),
          B({ icon: 'replace', label: 'Replace', showLabel: true, shortcut: 'Mod-H', run: () => a.openFind(true) }),
          B({ icon: 'square', label: 'Select All', showLabel: true, shortcut: 'Mod-A', run: this.run((c) => c.selectAll().run()) }),
        ),
      ),
    ];

    const insert = () => [
      G(
        'Pages',
        B({ icon: 'pageBreak', label: 'Page Break', large: true, shortcut: 'Mod-Enter', run: this.run((c) => c.setPageBreak().run()), id: 'page-break' }),
        B({ icon: 'toc', label: 'Table of Contents', large: true, run: this.run((c) => c.insertTableOfContents().run()) }),
      ),
      G('Tables', this.dropdown({ icon: 'table', label: 'Table', large: true, content: () => this.tablePicker(), id: 'insert-table' })),
      G(
        'Illustrations',
        this.dropdown({
          icon: 'image',
          label: 'Pictures',
          large: true,
          content: () => menu([
            { label: 'This Device…', icon: 'upload', run: () => a.insertImageFromFile() },
            { label: 'From a Web Address…', icon: 'link', run: () => a.insertImageFromUrl() },
          ], { iconFn }),
        }),
      ),
      G(
        'Links',
        B({ icon: 'link', label: 'Link', large: true, shortcut: 'Mod-K', run: () => a.editLink(), active: () => ed().isActive('link') }),
      ),
      G(
        'Header & Footer',
        B({ icon: 'header', label: 'Header', large: true, run: () => a.headerFooterDialog() }),
        B({ icon: 'footer', label: 'Footer', large: true, run: () => a.headerFooterDialog() }),
        B({ icon: 'pageNumber', label: 'Page Number', large: true, run: () => a.togglePageNumbers(), active: () => a.settings.pageNumbers }),
      ),
      G(
        'Text',
        C(
          B({ icon: 'date', label: 'Date & Time', showLabel: true, run: () => a.insertDateTime() }),
          B({ icon: 'hr', label: 'Horizontal Line', showLabel: true, run: this.run((c) => c.setHorizontalRule().run()) }),
          B({ icon: 'code', label: 'Code Block', showLabel: true, run: this.run((c) => c.toggleCodeBlock().run()), active: () => ed().isActive('codeBlock') }),
        ),
      ),
      G(
        'Symbols',
        this.dropdown({
          icon: 'symbol',
          label: 'Symbol',
          large: true,
          content: () => h('div', { class: 'symbol-grid' }, ...SYMBOLS.map((s) => {
            const b = h('button', { type: 'button', title: `U+${s.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` }, s);
            b.addEventListener('click', () => { closePopover(); ed().chain().focus().insertContent(s).run(); });
            return b;
          })),
        }),
      ),
    ];

    const layout = () => [
      G(
        'Page Setup',
        this.dropdown({
          icon: 'margins',
          label: 'Margins',
          large: true,
          content: () => {
            const wrap = h('div', { class: 'menu' });
            const m = a.settings.margins;
            for (const [key, p] of Object.entries(MARGIN_PRESETS)) {
              const pm = p.margins;
              const checked = pm.top === m.top && pm.bottom === m.bottom && pm.left === m.left && pm.right === m.right;
              const b = h('button', {
                type: 'button',
                class: `margin-option${checked ? ' is-checked' : ''}`,
                role: 'menuitem',
                html: `<svg viewBox="0 0 34 42"><rect x="0.5" y="0.5" width="33" height="41" fill="#fff" stroke="#999"/><rect x="${3 + pm.left / 48}" y="${3 + pm.top / 48}" width="${28 - (pm.left + pm.right) / 48}" height="${36 - (pm.top + pm.bottom) / 48}" fill="none" stroke="#185abd" stroke-dasharray="2 1"/></svg><span><b>${p.label}</b><small>Top: ${formatLength(pm.top)} Bottom: ${formatLength(pm.bottom)}<br>Left: ${formatLength(pm.left)} Right: ${formatLength(pm.right)}</small></span>`,
              });
              b.dataset.preset = key;
              b.addEventListener('click', () => { closePopover(); a.updateSettings({ margins: { ...pm } }); });
              wrap.append(b);
            }
            wrap.append(h('div', { class: 'menu-sep' }), menu([{ label: 'Custom Margins…', run: () => a.pageSetupDialog() }]));
            return wrap;
          },
        }),
        this.dropdown({
          icon: 'file',
          label: 'Orientation',
          large: true,
          content: () => menu([
            { label: 'Portrait', checked: a.settings.orientation !== 'landscape', run: () => a.updateSettings({ orientation: 'portrait' }) },
            { label: 'Landscape', checked: a.settings.orientation === 'landscape', run: () => a.updateSettings({ orientation: 'landscape' }) },
          ]),
        }),
        this.dropdown({
          icon: 'files',
          label: 'Size',
          large: true,
          content: () => menu([
            ...Object.entries(PAGE_SIZES).map(([key, s]) => ({ label: `${s.label}  —  ${s.detail}`, checked: a.settings.pageSize === key, run: () => a.updateSettings({ pageSize: key }) })),
            'separator',
            { label: 'Page Setup…', run: () => a.pageSetupDialog() },
          ]),
        }),
      ),
      G(
        'Paragraph',
        C(
          B({ icon: 'indent', label: 'Indent & Spacing…', showLabel: true, run: () => a.paragraphDialog() }),
          B({ icon: 'outdent', label: 'Decrease Indent', showLabel: true, run: this.run((c) => c.decreaseIndent().run()) }),
          B({ icon: 'indent', label: 'Increase Indent', showLabel: true, run: this.run((c) => c.increaseIndent().run()) }),
        ),
      ),
    ];

    const references = () => [
      G(
        'Table of Contents',
        B({ icon: 'toc', label: 'Table of Contents', large: true, run: this.run((c) => c.insertTableOfContents().run()) }),
      ),
      G(
        'Headings',
        C(
          B({ icon: 'outline', label: 'Navigation Pane', showLabel: true, run: () => a.toggleNav(), active: () => a.view.nav }),
        ),
      ),
    ];

    const review = () => [
      G(
        'Proofing',
        B({ icon: 'spell', label: 'Spelling', large: true, run: () => a.toggleSpellcheck(), active: () => a.view.spellcheck }),
        B({ icon: 'wordCount', label: 'Word Count', large: true, shortcut: 'Mod-Shift-G', run: () => a.wordCountDialog() }),
      ),
      G(
        'Comments',
        B({ icon: 'comment', label: 'New Comment', large: true, shortcut: 'Mod-Alt-M', run: () => a.addComment(), id: 'new-comment' }),
        C(
          B({ icon: 'trash', label: 'Delete', showLabel: true, run: () => a.deleteCurrentComment() }),
          B({ icon: 'chevronUp', label: 'Previous', showLabel: true, run: () => a.commentsPane.step(-1) }),
          B({ icon: 'chevronDown', label: 'Next', showLabel: true, run: () => a.commentsPane.step(1) }),
        ),
        B({ icon: 'comments', label: 'Show Comments', large: true, run: () => a.toggleComments(), active: () => a.view.comments && !a.commentsPane.el.hidden }),
      ),
      G(
        'Speech',
        B({ icon: 'readAloud', label: 'Read Aloud', large: true, run: () => a.readAloud(), active: () => a.speaking, enabled: () => 'speechSynthesis' in window }),
      ),
    ];

    const view = () => [
      G(
        'Views',
        B({ icon: 'printLayout', label: 'Print Layout', large: true, run: () => a.setLayout('print'), active: () => a.view.layout === 'print' }),
        B({ icon: 'webLayout', label: 'Web Layout', large: true, run: () => a.setLayout('web'), active: () => a.view.layout === 'web' }),
        B({ icon: 'focus', label: 'Focus', large: true, run: () => a.setFocusMode(true) }),
      ),
      G(
        'Show',
        C(
          B({ icon: 'ruler', label: 'Ruler', showLabel: true, run: () => a.toggleRuler(), active: () => a.view.ruler }),
          B({ icon: 'panelLeft', label: 'Navigation Pane', showLabel: true, run: () => a.toggleNav(), active: () => a.view.nav }),
          B({ icon: 'pilcrow', label: 'Formatting Marks', showLabel: true, run: () => a.toggleMarks(), active: () => a.view.marks }),
        ),
      ),
      G(
        'Zoom',
        B({ icon: 'zoomIn', label: 'Zoom', large: true, run: () => a.zoomDialog() }),
        B({ icon: 'search', label: '100%', large: true, run: () => a.setZoom(1) }),
        C(
          B({ icon: 'file', label: 'One Page', showLabel: true, run: () => a.zoomTo('page') }),
          B({ icon: 'columns', label: 'Page Width', showLabel: true, run: () => a.zoomTo('width') }),
        ),
      ),
      G(
        'Appearance',
        B({ icon: 'moon', label: 'Dark Mode', large: true, run: () => a.toggleTheme(), active: () => isDark() }),
        B({ icon: 'fullscreen', label: 'Full Screen', large: true, run: () => a.toggleFullscreen() }),
      ),
    ];

    const table = () => [
      G(
        'Rows & Columns',
        B({ icon: 'rowAbove', label: 'Insert Above', large: true, run: this.run((c) => c.addRowBefore().run()) }),
        B({ icon: 'rowBelow', label: 'Insert Below', large: true, run: this.run((c) => c.addRowAfter().run()) }),
        B({ icon: 'colLeft', label: 'Insert Left', large: true, run: this.run((c) => c.addColumnBefore().run()) }),
        B({ icon: 'colRight', label: 'Insert Right', large: true, run: this.run((c) => c.addColumnAfter().run()) }),
      ),
      G(
        'Delete',
        C(
          B({ icon: 'trash', label: 'Delete Rows', showLabel: true, run: this.run((c) => c.deleteRow().run()) }),
          B({ icon: 'trash', label: 'Delete Columns', showLabel: true, run: this.run((c) => c.deleteColumn().run()) }),
          B({ icon: 'trash', label: 'Delete Table', showLabel: true, run: this.run((c) => c.deleteTable().run()) }),
        ),
      ),
      G(
        'Merge',
        B({ icon: 'merge', label: 'Merge Cells', large: true, run: this.run((c) => c.mergeCells().run()), enabled: () => ed().can().mergeCells() }),
        B({ icon: 'split', label: 'Split Cells', large: true, run: this.run((c) => c.splitCell().run()), enabled: () => ed().can().splitCell() }),
      ),
      G(
        'Table Style',
        C(
          B({ icon: 'rows', label: 'Header Row', showLabel: true, run: this.run((c) => c.toggleHeaderRow().run()), active: () => headerRowOn(ed()) }),
          B({ icon: 'columns', label: 'First Column', showLabel: true, run: this.run((c) => c.toggleHeaderColumn().run()) }),
          this.dropdown({
            icon: 'highlight',
            label: 'Shading',
            showLabel: true,
            content: () => {
              const chip = (c) => h('button', { type: 'button', class: 'color-chip', style: { background: c }, 'aria-label': c, onclick: () => { closePopover(); ed().chain().focus().setCellAttribute('backgroundColor', c).run(); } });
              return h('div', { class: 'color-panel' },
                h('div', { class: 'color-grid' }, ...THEME_COLORS.flat().map(chip)),
                h('button', { type: 'button', class: 'menu-item', onclick: () => { closePopover(); ed().chain().focus().setCellAttribute('backgroundColor', null).run(); } }, h('span', { class: 'menu-icon', html: icon('eraser') }), h('span', {}, 'No Color'), h('span')));
            },
          }),
        ),
      ),
    ];

    return [
      { id: 'home', label: 'Home', build: home },
      { id: 'insert', label: 'Insert', build: insert },
      { id: 'layout', label: 'Layout', build: layout },
      { id: 'references', label: 'References', build: references },
      { id: 'review', label: 'Review', build: review },
      { id: 'view', label: 'View', build: view },
      { id: 'table', label: 'Table', build: table, contextual: () => this.editor.isActive('table') },
    ];
  }

  renderTabs() {
    this.tabsEl.replaceChildren();
    const file = h('button', { type: 'button', class: 'ribbon-tab is-file', role: 'tab', 'aria-selected': 'false' }, 'File');
    file.addEventListener('click', () => this.app.openBackstage());
    this.tabsEl.append(file);
    this.tabButtons = {};
    for (const t of this.tabs) {
      const b = h('button', { type: 'button', class: `ribbon-tab${t.contextual ? ' is-contextual' : ''}`, role: 'tab', 'aria-selected': String(t.id === this.current), 'data-tab': t.id }, t.label);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.select(t.id));
      b.addEventListener('dblclick', () => this.toggleCollapsed());
      if (t.contextual) b.hidden = true;
      this.tabButtons[t.id] = b;
      this.tabsEl.append(b);
    }
    this.tabsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
      const tabs = [...this.tabsEl.querySelectorAll('.ribbon-tab')].filter((b) => !b.hidden);
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      let next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : i + (e.key === 'ArrowRight' ? 1 : -1);
      next = (next + tabs.length) % tabs.length;
      tabs[next].focus();
      if (tabs[next].dataset.tab) this.select(tabs[next].dataset.tab);
    });
    this.tabsEl.append(h('div', { class: 'ribbon-tabs-spacer' }));
    const collapse = h('button', { type: 'button', class: 'icon-btn', title: 'Collapse the ribbon (Ctrl+F1)', 'aria-label': 'Collapse the ribbon', html: icon('chevronUp') });
    collapse.addEventListener('click', () => this.toggleCollapsed());
    this.collapseBtn = collapse;
    this.tabsEl.append(collapse);
  }

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this.bodyEl.classList.toggle('is-collapsed', this.collapsed);
    this.collapseBtn.innerHTML = icon(this.collapsed ? 'chevronDown' : 'chevronUp');
    this.collapseBtn.title = this.collapsed ? 'Expand the ribbon' : 'Collapse the ribbon';
    this.app.onChromeResize?.();
  }

  select(id) {
    if (this.collapsed) this.toggleCollapsed();
    this.current = id;
    for (const [tid, b] of Object.entries(this.tabButtons)) b.setAttribute('aria-selected', String(tid === id));
    this.renderBody();
  }

  renderBody() {
    this.updaters = [];
    const tab = this.tabs.find((t) => t.id === this.current) || this.tabs[0];
    this.bodyEl.dataset.tab = tab.id;
    this.bodyEl.replaceChildren(...tab.build());
    if (this.editor) this.update();
  }

  update() {
    if (!this.editor || this.editor.isDestroyed) return;
    const inTable = this.editor.isActive('table');
    const tableBtn = this.tabButtons.table;
    if (tableBtn.hidden === inTable) tableBtn.hidden = !inTable;
    if (!inTable && this.current === 'table') this.select('home');
    for (const fn of this.updaters) fn();
  }
}

function isAlign(editor, align) {
  const attrs = editor.isActive('heading') ? editor.getAttributes('heading') : editor.getAttributes('paragraph');
  const current = attrs.textAlign || 'left';
  return current === align;
}

function headerRowOn(editor) {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'table') return n.firstChild?.firstChild?.type.name === 'tableHeader';
  }
  return false;
}
