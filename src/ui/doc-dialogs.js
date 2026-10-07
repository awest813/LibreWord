import { h, shortcutLabel } from './dom.js';
import { openDialog, promptDialog } from './dialog.js';
import { PAGE_SIZES } from '../editor/page-setup.js';
import { units } from './editor-screen.js';
import { countWords } from '../editor/word-commands.js';
import { isChromeOS } from './install.js';

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

export async function pageSetupDialog(app) {
  const s = app.settings;
  const u = units.label();
  const r = await promptDialog({
    title: 'Page Setup',
    confirmLabel: 'OK',
    fields: [
      { name: 'pageSize', label: 'Paper size', type: 'select', value: s.pageSize, options: Object.entries(PAGE_SIZES).map(([value, p]) => ({ value, label: `${p.label} (${p.detail})` })) },
      { name: 'orientation', label: 'Orientation', type: 'select', value: s.orientation, options: [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }] },
      { name: 'top', label: `Top (${u})`, type: 'number', step: '0.01', min: '0', value: units.toDisplay(s.margins.top) },
      { name: 'bottom', label: `Bottom (${u})`, type: 'number', step: '0.01', min: '0', value: units.toDisplay(s.margins.bottom) },
      { name: 'left', label: `Left (${u})`, type: 'number', step: '0.01', min: '0', value: units.toDisplay(s.margins.left) },
      { name: 'right', label: `Right (${u})`, type: 'number', step: '0.01', min: '0', value: units.toDisplay(s.margins.right) },
    ],
  });
  if (!r) return;
  const margins = {};
  for (const k of ['top', 'bottom', 'left', 'right']) margins[k] = Math.max(0, Math.round(units.fromDisplay(num(r[k]))));
  const size = PAGE_SIZES[r.pageSize] || PAGE_SIZES.letter;
  const w = r.orientation === 'landscape' ? size.height : size.width;
  const ht = r.orientation === 'landscape' ? size.width : size.height;
  if (margins.left + margins.right > w - 72 || margins.top + margins.bottom > ht - 72) {
    app.toast('Those margins leave no room for text.', { type: 'error' });
    return;
  }
  app.updateSettings({ pageSize: r.pageSize, orientation: r.orientation, margins });
}

export async function paragraphDialog(app) {
  const ed = app.editor;
  const a = { ...ed.getAttributes('heading'), ...ed.getAttributes('paragraph') };
  const u = units.label();
  const special = a.firstLineIndent > 0 ? 'first' : a.firstLineIndent < 0 ? 'hanging' : 'none';
  const r = await promptDialog({
    title: 'Paragraph',
    fields: [
      { name: 'align', label: 'Alignment', type: 'select', value: a.textAlign || 'left', options: ['left', 'center', 'right', 'justify'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })) },
      { name: 'indent', label: `Left indent (${u})`, type: 'number', step: '0.01', min: '0', value: units.toDisplay(a.indent || 0) },
      { name: 'special', label: 'Special', type: 'select', value: special, options: [{ value: 'none', label: '(none)' }, { value: 'first', label: 'First line' }, { value: 'hanging', label: 'Hanging' }] },
      { name: 'by', label: `By (${u})`, type: 'number', step: '0.01', min: '0', value: units.toDisplay(Math.abs(a.firstLineIndent || 0)) || (u === 'in' ? 0.5 : 1.27) },
      { name: 'before', label: 'Spacing before (pt)', type: 'number', step: '1', min: '0', value: a.spaceBefore ?? '' , placeholder: 'Auto' },
      { name: 'after', label: 'Spacing after (pt)', type: 'number', step: '1', min: '0', value: a.spaceAfter ?? '', placeholder: 'Auto' },
      { name: 'line', label: 'Line spacing', type: 'select', value: a.lineHeight || '', options: [{ value: '', label: 'Default (1.15)' }, ...['1', '1.15', '1.5', '2', '2.5', '3'].map((v) => ({ value: v, label: { 1: 'Single', 1.5: '1.5 lines', 2: 'Double' }[v] || `Multiple ${v}` }))] },
    ],
  });
  if (!r) return;
  const by = units.fromDisplay(num(r.by));
  ed.chain()
    .focus()
    .setTextAlign(r.align)
    .setParagraphIndent({ indent: units.fromDisplay(num(r.indent)), firstLineIndent: r.special === 'first' ? by : r.special === 'hanging' ? -by : 0 })
    .setParagraphSpacing({ before: r.before === '' ? null : num(r.before), after: r.after === '' ? null : num(r.after) })
    .setLineHeight(r.line || null)
    .run();
}

export async function headerFooterDialog(app) {
  const s = app.settings;
  const r = await promptDialog({
    title: 'Header & Footer',
    fields: [
      { name: 'header', label: 'Header text', value: s.header, placeholder: 'Shown at the top right of every page' },
      { name: 'footer', label: 'Footer text', value: s.footer, placeholder: 'Shown at the bottom of every page' },
      { name: 'pageNumbers', label: 'Page numbers', type: 'checkbox', value: s.pageNumbers },
    ],
  });
  if (!r) return;
  app.updateSettings({ header: r.header.trim(), footer: r.footer.trim(), pageNumbers: r.pageNumbers });
}

export function wordCountDialog(app) {
  const { state } = app.editor;
  const { from, to, empty } = state.selection;
  const range = empty ? [0, state.doc.content.size] : [from, to];
  const text = state.doc.textBetween(range[0], range[1], '\n', ' ');
  const words = countWords(text);
  let paragraphs = 0;
  state.doc.nodesBetween(range[0], range[1], (n) => {
    if (n.isTextblock && n.textContent.trim()) paragraphs++;
  });
  const rows = [
    ['Pages', app.view.layout === 'print' ? app.pageCount : '—'],
    ['Words', words],
    ['Characters (no spaces)', text.replace(/\s/g, '').length],
    ['Characters (with spaces)', text.replace(/\n/g, '').length],
    ['Paragraphs', paragraphs],
    ['Reading time', `${Math.max(1, Math.round(words / 230))} min`],
  ];
  return openDialog({
    title: empty ? 'Word Count' : 'Word Count (selection)',
    body: h('table', { class: 'stats-table' }, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, typeof v === 'number' ? v.toLocaleString() : v)))),
  });
}

const SHORTCUTS = [
  ['Save', 'Mod-S'], ['Save As', 'Mod-Shift-S'], ['Print / Save as PDF', 'Mod-P'], ['Open', 'Mod-O'], ['Find', 'Mod-F'], ['Replace', 'Mod-H'],
  ['Go to page', 'Mod-G'], ['Undo', 'Mod-Z'], ['Redo', 'Mod-Y'], ['Bold', 'Mod-B'], ['Italic', 'Mod-I'], ['Underline', 'Mod-U'],
  ['Subscript', 'Mod-='], ['Superscript', 'Mod-Shift-+'], ['Grow / shrink font', 'Mod-] / Mod-['],
  ['Change case', 'Shift-F3'], ['Clear character formatting', 'Mod-Space'], ['Insert link', 'Mod-K'],
  ['Align left / center / right / justify', 'Mod-L / E / R / J'], ['Heading 1 – 6', 'Mod-Alt-1 … 6'], ['Normal text', 'Mod-Alt-0'],
  ['Bulleted list', 'Mod-Shift-8'], ['Numbered list', 'Mod-Shift-7'], ['Checklist', 'Mod-Shift-9'],
  ['Increase / decrease indent', 'Tab / Shift-Tab'], ['Line spacing 1 / 1.5 / 2', 'Mod-1 / 5 / 2'],
  ['Page break', 'Mod-Enter'], ['Line break', 'Shift-Enter'], ['Word count', 'Mod-Shift-G'], ['Spelling on / off', 'F7'],
  ['Zoom', 'Ctrl + mouse wheel'], ['Collapse ribbon', 'Mod-F1'], ['Full screen', 'F11'], ['Keyboard shortcuts', 'Mod-/'],
];

export function shortcutsDialog() {
  const table = h('table', { class: 'shortcut-table' }, ...SHORTCUTS.map(([label, keys]) => h('tr', {}, h('td', {}, label), h('td', {}, h('kbd', {}, shortcutLabel(keys))))));
  // Chromebook keyboards have no F1–F12 row: the top-row keys are browser and system controls.
  const chromebookNote = isChromeOS()
    ? h('p', { class: 'shortcut-note' }, 'On a Chromebook, hold the Search (or Launcher) key and press a top-row key to get F1–F10, or turn on “Treat top-row keys as function keys” in your Chromebook’s keyboard settings. Ctrl+Space switches keyboard language if you have more than one, so use Clear Formatting on the Home tab instead.')
    : null;
  return openDialog({
    title: 'Keyboard Shortcuts',
    className: 'wide',
    body: h('div', {}, chromebookNote, table),
  });
}

export async function zoomDialog(app) {
  const presets = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
  const r = await promptDialog({
    title: 'Zoom',
    fields: [
      { name: 'zoom', label: 'Percent', type: 'number', min: '10', max: '500', step: '1', value: Math.round(app.view.zoom * 100), hint: `Presets: ${presets.map((p) => `${p * 100}%`).join(', ')}` },
    ],
  });
  if (r) app.setZoom(num(r.zoom, 100) / 100);
}

export async function goToPageDialog(app) {
  if (app.view.layout !== 'print') return;
  const r = await promptDialog({
    title: 'Go To',
    fields: [{ name: 'page', label: `Page (1–${app.pageCount})`, type: 'number', min: '1', max: String(app.pageCount), value: '' }],
    confirmLabel: 'Go To',
  });
  if (!r) return;
  const page = Math.max(1, Math.min(app.pageCount, Math.round(num(r.page, 1))));
  const g = app.geometry;
  const pageTop = () => {
    const rootRect = app.editorEl.getBoundingClientRect();
    const z = rootRect.width / g.width;
    return { rootRect, z, y: rootRect.top + ((page - 1) * (g.height + g.gap) + g.margins.top + 2) * z };
  };
  // posAtCoords only sees what's on screen, so scroll the page into view first.
  const canvasTop = app.canvas.getBoundingClientRect().top;
  app.canvas.scrollTop += pageTop().y - canvasTop - 60;
  const { rootRect, z, y } = pageTop();
  const pos = app.editor.view.posAtCoords({ left: rootRect.left + (g.margins.left + 4) * z, top: y });
  if (pos) app.goTo(pos.pos);
}

export async function insertTableDialog(app) {
  const r = await promptDialog({
    title: 'Insert Table',
    fields: [
      { name: 'cols', label: 'Number of columns', type: 'number', min: '1', max: '40', value: '3' },
      { name: 'rows', label: 'Number of rows', type: 'number', min: '1', max: '500', value: '3' },
      { name: 'header', label: 'Header row', type: 'checkbox', value: true },
    ],
    confirmLabel: 'Insert',
  });
  if (!r) return;
  const rows = Math.max(1, Math.min(500, Math.round(num(r.rows, 3))));
  const cols = Math.max(1, Math.min(40, Math.round(num(r.cols, 3))));
  app.editor.chain().focus().insertTable({ rows, cols, withHeaderRow: r.header }).run();
}
