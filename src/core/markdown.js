// Minimal Markdown to HTML for the in-app User Guide (docs/AJUDA.md): headings,
// paragraphs, rules, lists, tables, fenced code, images, links, bold, italic
// and inline code. All text is escaped; raw HTML is not supported.
// Loaded both by Node (tests) and by the renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Markdown = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Anchor id of a heading: lowercase, accents and punctuation dropped.
  function slug(text) {
    return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Inline markup. Code spans and backslash escapes are taken out first so
  // that their contents are not formatted.
  function inline(text) {
    const held = [];
    const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
    let s = text
      .replace(/`([^`]+)`/g, (_m, code) => hold(`<code>${esc(code)}</code>`))
      .replace(/\\([\\`*_#|!\[\]()-])/g, (_m, ch) => hold(esc(ch)));
    s = esc(s)
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => hold(`<img src="${src}" alt="${alt}">`))
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => (href.startsWith('#') ? `<a href="${href}">${label}</a>` : label))
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?![*\w])/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[i]);
  }

  function cells(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  }

  const LIST_ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

  // The list starting at lines[i]; items indented deeper than its first one
  // form a nested list, other indented lines continue the previous item.
  function renderList(lines, i) {
    const first = LIST_ITEM.exec(lines[i]);
    const indent = first[1].length, ordered = /\d/.test(first[2]);
    const items = [];
    while (i < lines.length && lines[i].trim()) {
      const m = LIST_ITEM.exec(lines[i]);
      const depth = /^\s*/.exec(lines[i])[0].length;
      if (m && depth === indent && /\d/.test(m[2]) === ordered) {
        items.push({ text: m[3], sub: '' });
        i++;
      } else if (m && depth > indent && items.length) {
        const sub = renderList(lines, i);
        items[items.length - 1].sub += sub.html;
        i = sub.next;
      } else if (!m && depth > indent && items.length) {
        items[items.length - 1].text += ' ' + lines[i].trim();
        i++;
      } else {
        break;
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    return { html: `<${tag}>` + items.map((it) => `<li>${inline(it.text)}${it.sub}</li>`).join('') + `</${tag}>`, next: i };
  }

  // Returns { html, headings: [{ level, text, id }] }.
  function render(md) {
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const headings = [];
    const used = new Map();
    let i = 0;
    const isBlockStart = (l) => /^(#{1,6}\s|```|---\s*$|\s*[-*]\s|\s*\d+\.\s|\|)/.test(l);

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      if (line.startsWith('```')) {
        const body = [];
        for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
        i++;
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }

      const hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) {
        const level = hm[1].length, text = hm[2].trim();
        let id = slug(text) || 'section';
        const n = used.get(id) || 0;
        used.set(id, n + 1);
        if (n) id += '-' + n;
        headings.push({ level, text, id });
        out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
        i++;
        continue;
      }

      if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      if (line.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-+/.test(lines[i + 1])) {
        const head = cells(line);
        i += 2;
        const rows = [];
        for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(cells(lines[i]));
        out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
          + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }

      if (LIST_ITEM.test(line)) {
        const list = renderList(lines, i);
        out.push(list.html);
        i = list.next;
        continue;
      }

      const para = [line.trim()];
      for (i++; i < lines.length && lines[i].trim() && !isBlockStart(lines[i]); i++) para.push(lines[i].trim());
      const text = para.join(' ');
      // A paragraph that is only an image becomes a figure.
      out.push(/^!\[[^\]]*\]\([^)\s]+\)$/.test(text) ? `<p class="md-figure">${inline(text)}</p>` : `<p>${inline(text)}</p>`);
    }
    return { html: out.join('\n'), headings };
  }

  return { render, slug, inline };
});
