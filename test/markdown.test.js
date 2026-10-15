'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Markdown = require('../src/core/markdown');

test('markdown renders headings with unique anchors', () => {
  const { html, headings } = Markdown.render('# Ajuda\n\n## 1. Primeiros passos\n\n## 1. Primeiros passos');
  assert.match(html, /<h1 id="ajuda">Ajuda<\/h1>/);
  assert.deepStrictEqual(headings.map((h) => h.id), ['ajuda', '1-primeiros-passos', '1-primeiros-passos-1']);
  assert.strictEqual(headings[1].level, 2);
});

test('markdown escapes text and formats inline markup', () => {
  const out = Markdown.inline('**Ctrl+S** salva <tudo> e `a*b*c` é *código* \\*');
  assert.strictEqual(out, '<strong>Ctrl+S</strong> salva &lt;tudo&gt; e <code>a*b*c</code> é <em>código</em> *');
  assert.strictEqual(Markdown.inline('[Rules](#rules) e [site](https://x.y)'), '<a href="#rules">Rules</a> e site');
});

test('markdown renders tables, lists, code and images', () => {
  const md = [
    '| Atalho | Ação |', '|---|---|', '| Ctrl+T | Nova aba |', '| a \\| b | `x` |', '',
    '- um', '  continua', '  - aninhado', '- dois', '',
    '1. primeiro', '2. segundo', '',
    '```', '<git> difftool', '```', '',
    '![Pastas](data:image/png;base64,AAAA)', '',
    'linha um', 'linha dois',
  ].join('\n');
  const { html } = Markdown.render(md);
  assert.match(html, /<table><thead><tr><th>Atalho<\/th><th>Ação<\/th><\/tr><\/thead><tbody><tr><td>Ctrl\+T<\/td><td>Nova aba<\/td><\/tr><tr><td>a \| b<\/td><td><code>x<\/code><\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<ul><li>um continua<ul><li>aninhado<\/li><\/ul><\/li><li>dois<\/li><\/ul>/);
  assert.match(html, /<ol><li>primeiro<\/li><li>segundo<\/li><\/ol>/);
  assert.match(html, /<pre><code>&lt;git&gt; difftool<\/code><\/pre>/);
  assert.match(html, /<p class="md-figure"><img src="data:image\/png;base64,AAAA" alt="Pastas"><\/p>/);
  assert.match(html, /<p>linha um linha dois<\/p>/);
});

test('the user guide renders without leftover markup', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'AJUDA.md'), 'utf8');
  const { html, headings } = Markdown.render(md);
  assert.ok(headings.filter((h) => h.level === 2).length >= 8);
  const text = html.replace(/<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, '');
  assert.doesNotMatch(text, /\*\*|^#|\| ---|```/m);
});
