'use strict';
// Creates (or recreates) <base>/left and <base>/right with the cases the
// end-to-end test expects. Usage: node make_data.js <base-dir>
const fs = require('fs');
const path = require('path');

const base = path.resolve(process.argv[2] || __dirname);
const L = path.join(base, 'left'), R = path.join(base, 'right');
for (const d of [L, R]) fs.rmSync(d, { recursive: true, force: true });

const T0 = new Date('2026-10-01T12:00:00Z');
const T1 = new Date('2026-10-05T09:30:00Z'); // right side is "newer"

function put(root, rel, data, mtime = T0) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  fs.utimesSync(p, mtime, mtime);
}
const both = (rel, data) => { put(L, rel, data); put(R, rel, data); };

// ---- identical -------------------------------------------------------------
both('README.md', '# Projeto exemplo\n\nArquivo idêntico nos dois lados.\n');
both('docs/guide.txt', 'Guia\n====\n\nPasso 1\nPasso 2\n');
both('src/util.js', "'use strict';\nexports.sum = (a, b) => a + b;\n");
both('src/lib/deep/const.js', 'module.exports = { PI: 3.14159 };\n');
fs.mkdirSync(path.join(L, 'empty_both'), { recursive: true });
fs.mkdirSync(path.join(R, 'empty_both'), { recursive: true });

// ---- on one side only (orphans) --------------------------------------------
put(L, 'only_left.txt', 'existe só na esquerda\n');
put(R, 'only_right.txt', 'existe só na direita\n');
put(L, 'docs/old_notes.txt', 'notas antigas (só esquerda)\n');
put(L, 'left_only_dir/a.txt', 'pasta inteira só na esquerda\n');
put(R, 'right_only_dir/nested/b.txt', 'pasta inteira só na direita\n');
both('src/app.min.js', 'function a(){return 1}\n'); // for a -*.min.js filter

// ---- src/app.js: changes, insertions, deletions ----------------------------
const appLeft = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  '',
  'function greet(name) {',
  "  return 'Hello, ' + name;",
  '}',
  '',
  'function removedLater() {',
  '  // esta função existe só na esquerda',
  '  return 42;',
  '}',
  '',
  'function compute(x) {',
  '  const y = x * 2;',
  '  return y + 1;',
  '}',
  '',
  'const config = {',
  '  port: 8080,',
  "  host: 'localhost',",
  '  debug: false,',
  '};',
  '',
  'module.exports = { greet, compute, config };',
];
const appRight = [
  "'use strict';",
  "const fs = require('fs');",
  "const path = require('path');",
  "const os = require('os');", // inserted
  '',
  'function greet(name) {',
  "  return 'Olá, ' + name + '!';", // changed
  '}',
  '',
  'function compute(x) {',
  '  const y = x * 3;', // changed
  '  return y + 1;   ', // trailing blanks only (unimportant difference)
  '}',
  '',
  'function added(a) {', // inserted block
  '  return a.toUpperCase();',
  '}',
  '',
  'const config = {',
  '  port: 9090,', // changed
  "  host: 'localhost',",
  '  debug: false,',
  '};',
  '',
  'module.exports = { greet, compute, added, config };', // changed
];
put(L, 'src/app.js', appLeft.join('\n') + '\n', T0);
put(R, 'src/app.js', appRight.join('\n') + '\n', T1);

// ---- long.txt: long lines around the changes, for the floating button -----
// Lines 1-12 differ; only every 6th line is short, so the "Copy N lines"
// button has to look past its first choices to avoid covering code.
const longLine = (i, side) => (i % 6 === 5 ? `// ${i}` : `const value${i} = compute(${'x'.repeat(i % 3)}${side}, `.padEnd(220, 'abcdefghij') + ');');
const longL = [], longR = [];
for (let i = 0; i < 40; i++) { longL.push(longLine(i, i < 12 ? 'L' : '')); longR.push(longLine(i, i < 12 ? 'R' : '')); }
put(L, 'long.txt', longL.join('\n') + '\n', T0);
put(R, 'long.txt', longR.join('\n') + '\n', T0);

// ---- logo.bin: binary with different bytes and size ------------------------
const bin = Buffer.alloc(1024);
for (let i = 0; i < bin.length; i++) bin[i] = (i * 37 + (i >> 3)) & 0xff;
bin.write('JANUSLOGO', 0, 'latin1');
const binR = Buffer.concat([Buffer.from(bin), Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 1, 2, 3])]);
for (const off of [0x10, 0x11, 0x12, 0x200, 0x3f0]) binR[off] ^= 0xff;
put(L, 'logo.bin', bin, T0);
put(R, 'logo.bin', binR, T1);

// ---- line endings: CRLF vs LF (same text) ----------------------------------
const eolLines = ['linha um', 'linha dois', 'linha três', 'linha quatro'];
put(L, 'crlf.txt', eolLines.join('\r\n') + '\r\n', T0);
put(R, 'crlf.txt', eolLines.join('\n') + '\n', T0);

// ---- encoding: latin1 vs utf8 (same text) ----------------------------------
const encText = 'Ação e coração\nSão Paulo, Brasília\nçÇãõéêíóú\n';
put(L, 'encoding.txt', Buffer.from(encText, 'latin1'), T0);
put(R, 'encoding.txt', Buffer.from(encText, 'utf8'), T0);

// Fixed folder mtimes too (only for a stable listing).
const fixDirs = (root) => {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) { const p = path.join(root, e.name); fixDirs(p); fs.utimesSync(p, T0, T0); }
  }
};
fixDirs(L); fixDirs(R);
console.log('data written to', L, 'and', R);
