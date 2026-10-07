/**
 * Clean up HTML pasted from Microsoft Word (desktop and Word for the web).
 *
 * Word doesn't emit <ul>/<ol>: each list item is a <p class="MsoListParagraph…">
 * whose style carries `mso-list: l0 level2 lfo1`, with the bullet/number
 * rendered as literal text inside a `mso-list:Ignore` span. We rebuild real
 * nested lists from that so they paste as editable lists.
 */
const ORDERED_MARKER = /^\s*(?:\(?[0-9]+[.)]|\(?[a-z][.)]|\(?[ivxlcdm]+[.)])\s*$/i;

export function isWordHtml(html) {
  return /urn:schemas-microsoft-com:office|class="?Mso|mso-list|<o:p>/i.test(html);
}

export function cleanWordHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const body = doc.body;

  // Office-only elements and conditional-comment leftovers.
  body.querySelectorAll('o\\:p, xml, style, meta, link').forEach((el) => el.remove());

  const levelOf = (p) => {
    const m = /mso-list:\s*\S+\s+level(\d+)/i.exec(p.getAttribute('style') || '');
    return m ? Number(m[1]) : 0;
  };

  const items = [...body.querySelectorAll('p, h1, h2, h3, h4, h5, h6')].filter((p) => levelOf(p) > 0);
  for (const p of items) {
    // Pull out the literal marker ("1.", "·", "o", "§"…) Word renders in front.
    let marker = '';
    p.querySelectorAll('span').forEach((span) => {
      if (/mso-list:\s*Ignore/i.test(span.getAttribute('style') || '')) {
        marker += span.textContent;
        span.remove();
      }
    });
    p.dataset.listLevel = String(levelOf(p));
    p.dataset.listType = ORDERED_MARKER.test(marker.replace(/ /g, ' ').trim()) ? 'ol' : 'ul';
    p.style.removeProperty('text-indent');
    p.style.removeProperty('margin-left');
  }

  // Group consecutive list paragraphs into nested lists.
  for (const first of items) {
    if (!first.isConnected || first.parentNode.closest?.('li')) continue;
    const run = [first];
    let next = first.nextElementSibling;
    // A top-level change between bullets and numbering starts a separate list.
    const base = Number(first.dataset.listLevel);
    while (next && next.dataset?.listLevel && !(Number(next.dataset.listLevel) <= base && next.dataset.listType !== first.dataset.listType)) {
      run.push(next);
      next = next.nextElementSibling;
    }
    const root = doc.createElement(first.dataset.listType);
    first.before(root);
    const stack = [{ level: Number(first.dataset.listLevel), list: root }];
    for (const p of run) {
      const level = Number(p.dataset.listLevel);
      while (stack.length > 1 && level < stack[stack.length - 1].level) stack.pop();
      let top = stack[stack.length - 1];
      if (level > top.level) {
        const parentLi = top.list.lastElementChild || top.list.appendChild(doc.createElement('li'));
        const nested = doc.createElement(p.dataset.listType);
        parentLi.append(nested);
        stack.push({ level, list: nested });
        top = stack[stack.length - 1];
      }
      if (level === top.level && stack.length > 1 && top.list.tagName.toLowerCase() !== p.dataset.listType) {
        // Same nesting level, other kind of list: a sibling list in the same item.
        const sibling = doc.createElement(p.dataset.listType);
        top.list.after(sibling);
        top.list = sibling;
      }
      const li = doc.createElement('li');
      delete p.dataset.listLevel;
      delete p.dataset.listType;
      li.append(p);
      top.list.append(li);
    }
  }

  // Word's "Normal" paragraphs carry margins that are already the default.
  body.querySelectorAll('[class^="Mso"]').forEach((el) => el.removeAttribute('class'));
  return body.innerHTML;
}

export function transformPastedHTML(html) {
  return isWordHtml(html) ? cleanWordHtml(html) : html;
}
