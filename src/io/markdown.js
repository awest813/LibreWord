/** Serialize editor JSON to GitHub-flavoured Markdown. */

const escapeText = (s) => s.replace(/([\\`*_[\]#<>|])/g, '\\$1').replace(/^(\s*)([-+]|\d+\.)(\s)/, '$1\\$2$3');

function inline(nodes = []) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out += '  \n';
      continue;
    }
    if (n.type === 'image') {
      out += `![${n.attrs?.alt || ''}](${n.attrs?.src || ''})`;
      continue;
    }
    if (n.type !== 'text') continue;
    const marks = n.marks || [];
    const has = (t) => marks.some((m) => m.type === t);
    const code = has('code');
    let t = code ? `\`${n.text.replace(/`/g, '\\`')}\`` : escapeText(n.text);
    if (!code) {
      // Keep surrounding whitespace outside of the emphasis markers.
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(t);
      let c = core;
      if (c) {
        if (has('strike')) c = `~~${c}~~`;
        if (has('italic')) c = `*${c}*`;
        if (has('bold')) c = `**${c}**`;
        if (has('underline')) c = `<u>${c}</u>`;
        if (has('subscript')) c = `<sub>${c}</sub>`;
        if (has('superscript')) c = `<sup>${c}</sup>`;
        if (has('highlight')) c = `==${c}==`;
      }
      t = lead + c + trail;
    }
    const link = marks.find((m) => m.type === 'link');
    if (link) t = `[${t}](${link.attrs.href})`;
    out += t;
  }
  return out;
}

const textOf = (node) => (node.content || []).map((c) => (c.type === 'text' ? c.text : textOf(c))).join('');

function table(node) {
  const rows = (node.content || []).map((row) =>
    (row.content || []).map((cell) => (cell.content || []).map((p) => inline(p.content)).join(' ').replace(/\n/g, ' ')),
  );
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
  for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
  return lines.join('\n');
}

function block(node, ctx) {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content);
    case 'heading':
      return `${'#'.repeat(node.attrs?.level || 1)} ${inline(node.content)}`;
    case 'blockquote':
      return blocks(node.content, ctx).split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
    case 'codeBlock': {
      const lang = node.attrs?.language || '';
      return `\`\`\`${lang}\n${textOf(node)}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'pageBreak':
      return '<div style="page-break-after: always"></div>';
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      let n = node.attrs?.start || 1;
      return (node.content || [])
        .map((item) => {
          let marker = '-';
          if (node.type === 'orderedList') marker = `${n++}.`;
          if (node.type === 'taskList') marker = `- [${item.attrs?.checked ? 'x' : ' '}]`;
          const body = blocks(item.content, ctx);
          const indent = ' '.repeat(marker.length + 1);
          return `${marker} ${body.split('\n').map((l, i) => (i === 0 || !l ? l : indent + l)).join('\n')}`;
        })
        .join('\n');
    }
    case 'table':
      return table(node);
    case 'tableOfContents':
      return ctx.headings
        .map((h) => `${'  '.repeat(h.level - ctx.minLevel)}- ${escapeText(h.text)}`)
        .join('\n');
    default:
      return node.content ? blocks(node.content, ctx) : '';
  }
}

function blocks(nodes = [], ctx) {
  const out = [];
  nodes.forEach((n, i) => {
    const s = block(n, ctx);
    // Lists items inside one list are tight; everything else is separated by blank lines.
    out.push(s);
    if (i < nodes.length - 1) out.push('');
  });
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function jsonToMarkdown(doc) {
  const headings = [];
  const walk = (n) => {
    if (n.type === 'heading') headings.push({ level: n.attrs?.level || 1, text: textOf(n) });
    else (n.content || []).forEach(walk);
  };
  walk(doc);
  const ctx = { headings, minLevel: Math.min(6, ...headings.map((h) => h.level)) };
  return `${blocks(doc.content || [], ctx).trim()}\n`;
}
