const BLOCKED_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
]);

const URL_ATTRIBUTES = new Set(['href', 'src', 'xlink:href', 'formaction']);
const SAFE_URL_PATTERN = /^(https?:|mailto:|tel:|data:image\/(?:png|gif|jpe?g|webp);base64,|[/.#])/i;

export const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[char]));

export const safeFileName = (value = 'document') => {
  const safeName = String(value).trim().replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/\.+$/g, '');
  return (safeName || 'document').slice(0, 120);
};

export const textToParagraphHtml = (text = '') => String(text)
  .split(/\r?\n/)
  .map((line) => `<p>${escapeHtml(line) || '<br>'}</p>`)
  .join('');

export const sanitizeDocumentHtml = (html = '') => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html), 'text/html');

  doc.querySelectorAll(Array.from(BLOCKED_TAGS).join(',')).forEach((node) => node.remove());

  doc.body.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();

      if (name.startsWith('on') || name === 'srcdoc') {
        node.removeAttribute(attr.name);
        return;
      }

      if (URL_ATTRIBUTES.has(name) && value && !SAFE_URL_PATTERN.test(value)) {
        node.removeAttribute(attr.name);
      }
    });
  });

  return doc.body.innerHTML;
};

export const htmlToPlainText = (html = '') => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeDocumentHtml(html), 'text/html');
  return doc.body.textContent || 'No content yet...';
};
