/**
 * A small markdown renderer for the project's own documents.
 *
 * It builds DOM nodes rather than assigning innerHTML, so a code fence or a table cell in a
 * repository document can never turn into markup in this page. The supported subset is exactly what
 * these documents use: headings, paragraphs, lists, fenced code, tables, blockquotes, and inline
 * code/bold/links.
 */
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;

function inline(text, parent) {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else {
      const label = token.slice(1, token.indexOf(']'));
      const href = token.slice(token.indexOf('(') + 1, -1);
      const anchor = document.createElement('a');
      anchor.textContent = label;
      // Repository-relative links stay inside the console; anything else opens in a new tab.
      if (/^https?:/.test(href)) { anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noreferrer noopener'; }
      else { anchor.href = '#'; anchor.dataset.doc = href.split('#')[0]; }
      parent.append(anchor);
    }
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
  return parent;
}

const row = (cells, tag) => {
  const tr = document.createElement('tr');
  for (const cell of cells) tr.append(inline(cell.trim(), document.createElement(tag)));
  return tr;
};
const cells = line => line.replace(/^\||\|$/g, '').split('|');

export function renderMarkdown(text) {
  const root = document.createElement('div');
  root.className = 'markdown';
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    if (line.startsWith('```')) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      code.textContent = body.join('\n');
      pre.append(code);
      root.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      root.append(inline(heading[2], document.createElement(`h${heading[1].length}`)));
      i++;
      continue;
    }
    if (line.startsWith('|') && lines[i + 1]?.match(/^\|[\s:|-]+\|$/)) {
      const table = document.createElement('table');
      const head = document.createElement('thead');
      head.append(row(cells(line), 'th'));
      const body = document.createElement('tbody');
      for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) body.append(row(cells(lines[i]), 'td'));
      table.append(head, body);
      root.append(table);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) {
        list.append(inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''), document.createElement('li')));
      }
      root.append(list);
      continue;
    }
    if (line.startsWith('> ')) {
      const quote = document.createElement('blockquote');
      for (; i < lines.length && lines[i].startsWith('> '); i++) {
        quote.append(inline(lines[i].slice(2), document.createElement('p')));
      }
      root.append(quote);
      continue;
    }
    const paragraph = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||>\s|\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) paragraph.push(lines[i]);
    root.append(inline(paragraph.join(' '), document.createElement('p')));
  }
  return root;
}
