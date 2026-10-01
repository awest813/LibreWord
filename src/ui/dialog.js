import { h } from './dom.js';
import { icon } from './icons.js';

/**
 * Show a modal dialog built on the native <dialog> element (focus trapping,
 * Escape and the backdrop come for free).
 *
 * buttons: [{ label, value, primary?, danger? }]
 * Resolves with the clicked button's value (or null when dismissed).
 * `onSubmit(value, form)` may return false to keep the dialog open.
 */
export function openDialog({ title, body, buttons = [{ label: 'Close', value: null, primary: true }], onSubmit, className = '', initialFocus } = {}) {
  return new Promise((resolve) => {
    const form = h('form', { method: 'dialog', class: 'dialog-form' });
    const footer = h('div', { class: 'dialog-actions' });
    let result = null;
    for (const b of buttons) {
      footer.append(
        h(
          'button',
          {
            type: b.primary ? 'submit' : 'button',
            class: `btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}`,
            value: b.value ?? '',
            onclick: (e) => {
              if (!b.primary) {
                e.preventDefault();
                result = b.value ?? null;
                if (result !== null && onSubmit && onSubmit(result, form) === false) return;
                dlg.close();
              }
            },
          },
          b.label,
        ),
      );
    }
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    form.append(
      h(
        'header',
        { class: 'dialog-header' },
        h('h2', { id: titleId }, title),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', html: icon('close'), onclick: () => { result = null; dlg.close(); } }),
      ),
      h('div', { class: 'dialog-body' }, body),
      footer,
    );
    const dlg = h('dialog', { class: `dialog ${className}`, 'aria-labelledby': titleId }, form);

    form.addEventListener('submit', (e) => {
      const primary = buttons.find((b) => b.primary);
      const value = primary ? primary.value ?? true : true;
      if (onSubmit && onSubmit(value, form) === false) {
        e.preventDefault();
        return;
      }
      result = value;
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) {
        result = null;
        dlg.close();
      }
    });
    document.body.append(dlg);
    dlg.showModal();
    const focusEl = initialFocus ? form.querySelector(initialFocus) : form.querySelector('input, select, textarea');
    focusEl?.focus();
    if (focusEl?.select) focusEl.select();
  });
}

export async function confirmDialog(message, { title = 'LibreWord', confirmLabel = 'OK', danger = false } = {}) {
  const value = await openDialog({
    title,
    body: h('p', {}, message),
    buttons: [
      { label: 'Cancel', value: null },
      { label: confirmLabel, value: 'ok', primary: true, danger },
    ],
  });
  return value === 'ok';
}

/** Prompt for one or more fields. Resolves to an object of values or null. */
export async function promptDialog({ title, fields, confirmLabel = 'OK' }) {
  const inputs = {};
  const body = h('div', { class: 'form-grid' });
  for (const f of fields) {
    const id = `f-${f.name}`;
    let input;
    if (f.type === 'select') {
      input = h('select', { id, name: f.name }, ...f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value || null }, o.label)));
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, name: f.name, rows: f.rows || 4, placeholder: f.placeholder || '' });
      input.value = f.value ?? '';
    } else if (f.type === 'checkbox') {
      input = h('input', { id, name: f.name, type: 'checkbox', checked: f.value || null });
    } else {
      input = h('input', {
        id,
        name: f.name,
        type: f.type || 'text',
        placeholder: f.placeholder || '',
        step: f.step || null,
        min: f.min ?? null,
        max: f.max ?? null,
        required: f.required || null,
        autocomplete: 'off',
      });
      input.value = f.value ?? '';
    }
    inputs[f.name] = input;
    body.append(h('label', { for: id, class: f.type === 'checkbox' ? 'checkbox-label' : '' }, f.label), input);
    if (f.hint) body.append(h('span', { class: 'form-hint' }, f.hint));
  }
  const value = await openDialog({
    title,
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: confirmLabel, value: 'ok', primary: true },
    ],
  });
  if (value !== 'ok') return null;
  const out = {};
  for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'checkbox' ? el.checked : el.value;
  return out;
}
