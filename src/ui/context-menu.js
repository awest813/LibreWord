import { showPopover, menu } from './dom.js';
import { icon } from './icons.js';

export function showEditorContextMenu(app, event) {
  const ed = app.editor;
  const { empty } = ed.state.selection;
  const inTable = ed.isActive('table');
  const onImage = ed.isActive('image');
  const onLink = ed.isActive('link');
  const c = () => ed.chain().focus();

  const items = [
    { label: 'Cut', icon: 'cut', shortcut: 'Mod-X', disabled: empty, run: () => app.clipboard('cut') },
    { label: 'Copy', icon: 'copy', shortcut: 'Mod-C', disabled: empty, run: () => app.clipboard('copy') },
    { label: 'Paste', icon: 'paste', shortcut: 'Mod-V', run: () => app.paste(false) },
    { label: 'Paste as Text Only', icon: 'type', run: () => app.paste(true) },
    'separator',
  ];
  if (onLink) {
    items.push(
      { label: 'Edit Link…', icon: 'link', run: () => app.editLink() },
      { label: 'Open Link', icon: 'webLayout', run: () => window.open(ed.getAttributes('link').href, '_blank', 'noopener,noreferrer') },
      { label: 'Remove Link', icon: 'unlink', run: () => c().extendMarkRange('link').unsetLink().run() },
      'separator',
    );
  } else {
    items.push({ label: 'Link…', icon: 'link', shortcut: 'Mod-K', run: () => app.editLink() });
  }
  if (onImage) {
    items.push(
      { label: 'Reset Picture Size', icon: 'image', run: () => c().updateAttributes('image', { width: null, height: null }).run() },
      { label: 'Edit Alt Text…', icon: 'type', run: async () => {
        const { promptDialog } = await import('./dialog.js');
        const r = await promptDialog({ title: 'Alt Text', fields: [{ name: 'alt', label: 'Description', type: 'textarea', value: ed.getAttributes('image').alt || '' }] });
        if (r) c().updateAttributes('image', { alt: r.alt }).run();
      } },
      'separator',
    );
  }
  if (inTable) {
    items.push(
      { heading: 'Table' },
      { label: 'Insert Row Above', icon: 'rowAbove', run: () => c().addRowBefore().run() },
      { label: 'Insert Row Below', icon: 'rowBelow', run: () => c().addRowAfter().run() },
      { label: 'Insert Column Left', icon: 'colLeft', run: () => c().addColumnBefore().run() },
      { label: 'Insert Column Right', icon: 'colRight', run: () => c().addColumnAfter().run() },
      { label: 'Merge Cells', icon: 'merge', disabled: !ed.can().mergeCells(), run: () => c().mergeCells().run() },
      { label: 'Split Cell', icon: 'split', disabled: !ed.can().splitCell(), run: () => c().splitCell().run() },
      { label: 'Delete Row', icon: 'trash', run: () => c().deleteRow().run() },
      { label: 'Delete Column', icon: 'trash', run: () => c().deleteColumn().run() },
      { label: 'Delete Table', icon: 'trash', run: () => c().deleteTable().run() },
      'separator',
    );
  }
  items.push(
    { label: 'Paragraph…', icon: 'pilcrow', run: () => app.paragraphDialog() },
    { label: 'Clear Formatting', icon: 'eraser', run: () => c().clearFormatting().run() },
  );
  if (!empty) {
    items.push('separator', {
      label: 'Search the Web',
      icon: 'search',
      run: () => {
        const q = ed.state.doc.textBetween(ed.state.selection.from, ed.state.selection.to, ' ').slice(0, 200);
        window.open(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`, '_blank', 'noopener,noreferrer');
      },
    });
  }
  showPopover(null, menu(items, { iconFn: (n) => icon(n) }), { at: { x: event.clientX, y: event.clientY } });
}
