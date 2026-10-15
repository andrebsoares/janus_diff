'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TextDiff = require('../src/core/textdiff');
const Dir = require('../src/core/dircompare');

function lcsLength(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

test('myers produces a minimal, valid edit script (fuzz)', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let iter = 0; iter < 400; iter++) {
    const a = Array.from({ length: rnd(40) }, () => rnd(5));
    const b = Array.from({ length: rnd(40) }, () => rnd(5));
    const { delA, insB } = TextDiff.myers(a, b);
    const keptA = a.filter((_, i) => !delA[i]);
    const keptB = b.filter((_, j) => !insB[j]);
    assert.deepStrictEqual(keptA, keptB);
    assert.strictEqual(keptA.length, lcsLength(a, b));
  }
});

test('rows cover every line of both sides exactly once, in order', () => {
  const left = ['a', 'b', 'c', 'd', 'e'];
  const right = ['a', 'x', 'c', 'e', 'f'];
  const { rows } = TextDiff.compareLines(left, right);
  assert.deepStrictEqual(rows.filter((r) => r.l >= 0).map((r) => r.l), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(rows.filter((r) => r.r >= 0).map((r) => r.r), [0, 1, 2, 3, 4]);
  assert.deepStrictEqual(rows.map((r) => r.type), ['same', 'diff', 'same', 'left', 'same', 'right']);
});

test('importance rules separate unimportant from important differences', () => {
  const left = ['int a = 1;', '  foo();', 'Bar'];
  const right = ['int a = 1;   ', 'foo();', 'bar'];
  let res = TextDiff.compareLines(left, right);
  assert.deepStrictEqual(res.rows.map((r) => r.type), ['insig', 'diff', 'diff']);
  res = TextDiff.compareLines(left, right, { leadingWS: false, characterCase: false });
  assert.deepStrictEqual(res.rows.map((r) => r.type), ['insig', 'insig', 'insig']);
  assert.strictEqual(res.stats.important, 0);
});

test('sections group consecutive differences', () => {
  const { sections } = TextDiff.compareLines(['a', 'b', 'c', 'd', 'e'], ['a', 'B', 'C', 'd', 'E']);
  assert.deepStrictEqual(sections.map((s) => [s.start, s.end]), [[1, 2], [4, 4]]);
});

test('closeness matching aligns similar lines inside a change block', () => {
  const left = ['function alpha(one, two) {', 'return one + two;'];
  const right = ['// new comment', 'function alpha(one, two, three) {', 'return one + two + three;'];
  const { rows } = TextDiff.compareLines(left, right);
  assert.deepStrictEqual(rows.map((r) => [r.type, r.l, r.r]), [['right', -1, 0], ['diff', 0, 1], ['diff', 1, 2]]);
});

test('inlineDiff reports differing character ranges', () => {
  const d = TextDiff.inlineDiff('value = 10;', 'value = 25;');
  assert.deepStrictEqual(d.left, [[8, 10, 'sig']]);
  assert.deepStrictEqual(d.right, [[8, 10, 'sig']]);
  const ws = TextDiff.inlineDiff('a b', 'a  b', { embeddedWS: false });
  assert.deepStrictEqual(ws.right.map((r) => r[2]), ['insig']);
});

test('splitLines / joinLines round trip keeps line endings', () => {
  for (const text of ['a\r\nb\r\n', 'a\nb', '', 'one\n', 'a\rb\r']) {
    const s = TextDiff.splitLines(text);
    assert.strictEqual(TextDiff.joinLines(s.lines, s.eol, s.finalNewline), text);
  }
});

test('folder filters', () => {
  const f = Dir.parseFilters('*.js;*.ts;-*.min.js;-node_modules/');
  assert.ok(Dir.passesFilter(f, 'a.js', false));
  assert.ok(!Dir.passesFilter(f, 'a.min.js', false));
  assert.ok(!Dir.passesFilter(f, 'a.css', false));
  assert.ok(!Dir.passesFilter(f, 'node_modules', true));
  assert.ok(Dir.passesFilter(f, 'src', true));
});

test('folder filters with relative paths', () => {
  // A slash inside or in front of a mask matches the relative path; "\" works too.
  const f = Dir.parseFilters('*;-/README.md;-src\\gen/;-docs/*.tmp');
  assert.ok(!Dir.passesFilter(f, 'README.md', false, 'README.md'));
  assert.ok(Dir.passesFilter(f, 'README.md', false, 'sub/README.md'));
  assert.ok(!Dir.passesFilter(f, 'gen', true, 'src/gen'));
  assert.ok(Dir.passesFilter(f, 'gen', true, 'lib/gen'));
  assert.ok(!Dir.passesFilter(f, 'a.tmp', false, 'docs/a.tmp'));
  assert.ok(Dir.passesFilter(f, 'a.tmp', false, 'a.tmp'));
  // Without a path, an item is taken to be at the top level.
  assert.ok(!Dir.passesFilter(f, 'README.md', false));
});

// Applies a unified diff to text, checking every context and removed line
// and the hunk header counts.
function applyPatch(text, patch) {
  const src = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const p = patch.split('\n');
  p.pop();
  assert.match(p[0], /^--- /);
  assert.match(p[1], /^\+\+\+ /);
  const out = [];
  let pos = 0;
  for (let i = 2; i < p.length;) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(p[i++]);
    assert.ok(m, 'hunk header');
    const [oldCount, newCount] = [m[2] === undefined ? 1 : +m[2], m[4] === undefined ? 1 : +m[4]];
    const start = oldCount ? +m[1] - 1 : +m[1];
    assert.ok(start >= pos);
    while (pos < start) out.push(src[pos++]);
    let seenOld = 0, seenNew = 0;
    for (; i < p.length && !p[i].startsWith('@@'); i++) {
      const term = p[i + 1] === '\\ No newline at end of file' ? '' : '\n';
      const [t, line] = [p[i][0], p[i].slice(1) + term];
      if (t !== '+') { assert.strictEqual(src[pos++], line); seenOld++; }
      if (t !== '-') { out.push(line); seenNew++; }
      if (!term) i++;
    }
    assert.deepStrictEqual([seenOld, seenNew], [oldCount, newCount]);
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.join('');
}

function patchOf(leftText, rightText, context, aligns) {
  const L = TextDiff.splitLines(leftText), R = TextDiff.splitLines(rightText);
  const { rows } = TextDiff.compareLines(L.lines, R.lines, undefined, aligns);
  return TextDiff.unifiedDiff(rows, L.lines, R.lines, { leftName: 'l', rightName: 'r', context, leftFinalNewline: L.finalNewline, rightFinalNewline: R.finalNewline });
}

test('unifiedDiff matches GNU diff -u output', () => {
  assert.strictEqual(patchOf('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk'),
    '--- l\n+++ r\n@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n@@ -8,3 +8,4 @@\n h\n i\n j\n+k\n\\ No newline at end of file\n');
  assert.strictEqual(patchOf('', 'x\ny\n'), '--- l\n+++ r\n@@ -0,0 +1,2 @@\n+x\n+y\n');
  // Changes at most 2 * context lines apart share a hunk.
  assert.strictEqual(patchOf('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nX\nc\nd\ne\nf\nY\nh\n'),
    '--- l\n+++ r\n@@ -1,8 +1,8 @@\n a\n-b\n+X\n c\n d\n e\n f\n-g\n+Y\n h\n');
  assert.strictEqual(patchOf('same\n', 'same\n'), '');
});

test('unifiedDiff patches apply back to the right side (fuzz)', () => {
  let seed = 777;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const words = ['a', 'b', 'c', ' a', 'a ', 'B', ''];
  const text = () => Array.from({ length: rnd(14) }, () => words[rnd(words.length)]).join('\n') + (rnd(2) ? '\n' : '');
  for (let iter = 0; iter < 500; iter++) {
    const left = text(), right = text();
    const L = TextDiff.splitLines(left), R = TextDiff.splitLines(right);
    const aligns = L.lines.length && R.lines.length && rnd(3) === 0 ? [[rnd(L.lines.length), rnd(R.lines.length)]] : undefined;
    const patch = patchOf(left, right, rnd(4), aligns);
    // splitLines drops a lone final newline's distinction for empty text.
    const norm = (t) => TextDiff.joinLines(TextDiff.splitLines(t).lines, '\n', TextDiff.splitLines(t).finalNewline);
    if (!patch) assert.strictEqual(norm(left), norm(right));
    else assert.strictEqual(applyPatch(norm(left), patch), norm(right), JSON.stringify({ left, right, patch }));
  }
});

test('folder comparison classifies files and folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const L = path.join(root, 'L'), R = path.join(root, 'R');
  const put = (base, rel, data, time) => {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    fs.utimesSync(p, time, time);
  };
  const t0 = new Date('2020-01-01T00:00:00Z'), t1 = new Date('2021-01-01T00:00:00Z');
  put(L, 'same.txt', 'hello', t0); put(R, 'same.txt', 'hello', t0);
  put(L, 'newer.txt', 'hello!', t1); put(R, 'newer.txt', 'hello', t0);
  put(L, 'onlyleft.txt', 'x', t0);
  put(R, 'sub/onlyright.txt', 'y', t0);
  put(L, 'touched.txt', 'same bytes', t0); put(R, 'touched.txt', 'same bytes', t1);
  put(L, 'ws.txt', 'a\nb  \n', t0); put(R, 'ws.txt', 'a\nb\n', t0);
  try {
    const byName = (res) => Object.fromEntries(res.children.map((n) => [n.name, n.status]));
    let res = await Dir.compareFolders(L, R, {});
    assert.deepStrictEqual(byName(res), {
      sub: 'orphanRight', 'newer.txt': 'newerLeft', 'onlyleft.txt': 'orphanLeft',
      'same.txt': 'same', 'touched.txt': 'newerRight', 'ws.txt': 'diff',
    });
    assert.strictEqual(res.children[0].children[0].status, 'orphanRight');
    for (const content of ['binary', 'crc']) {
      res = await Dir.compareFolders(L, R, { content, contentOverridesQuick: true });
      assert.strictEqual(byName(res)['touched.txt'], 'same');
      assert.strictEqual(byName(res)['newer.txt'], 'newerLeft');
      assert.strictEqual(byName(res)['ws.txt'], 'diff');
    }
    res = await Dir.compareFolders(L, R, { content: 'rules', contentOverridesQuick: true });
    assert.strictEqual(byName(res)['ws.txt'], 'same');
    res = await Dir.compareFolders(L, R, { filters: '-*.txt' });
    assert.deepStrictEqual(res.children.map((n) => n.name), ['sub']);
    res = await Dir.compareFolders(L, R, { filters: '*;-/sub/onlyright.txt;-/ws.txt' });
    assert.deepStrictEqual(res.children.map((n) => n.name), ['sub', 'newer.txt', 'onlyleft.txt', 'same.txt', 'touched.txt']);
    assert.deepStrictEqual(res.children[0].children, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recheckContents reclassifies chosen files and their folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const L = path.join(root, 'L'), R = path.join(root, 'R');
  const put = (base, rel, data, time) => {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    fs.utimesSync(p, time, time);
  };
  const t0 = new Date('2020-01-01T00:00:00Z'), t1 = new Date('2021-01-01T00:00:00Z');
  put(L, 'd/touched.txt', 'same bytes', t0); put(R, 'd/touched.txt', 'same bytes', t1);
  put(L, 'd/eol.txt', 'a\r\nb\r\n', t0); put(R, 'd/eol.txt', 'a\nb\n', t1);
  put(L, 'd/changed.txt', 'one', t0); put(R, 'd/changed.txt', 'two', t1);
  put(L, 'top.txt', 'same', t0); put(R, 'top.txt', 'same', t1);
  try {
    const res = await Dir.compareFolders(L, R, {});
    const byRel = (nodes) => Object.fromEntries(nodes.flatMap((n) => [[n.rel, n.status], ...(n.isDir ? Object.entries(byRel(n.children)) : [])]));
    assert.strictEqual(byRel(res.children).d, 'diff');
    // A folder stands for its files; files outside the selection keep their status.
    let out = await Dir.recheckContents(res.children, L, R, ['d'], { content: 'binary' });
    assert.deepStrictEqual([out.compared, out.same], [3, 1]);
    assert.deepStrictEqual(byRel(out.children), { d: 'diff', 'd/changed.txt': 'newerRight', 'd/eol.txt': 'newerRight', 'd/touched.txt': 'same', 'top.txt': 'newerRight' });
    // Rules-based (the default) sees CRLF x LF as the same text.
    out = await Dir.recheckContents(out.children, L, R, ['d/eol.txt', 'top.txt'], {});
    assert.deepStrictEqual([out.compared, out.same], [2, 2]);
    assert.strictEqual(byRel(out.children)['d/eol.txt'], 'same');
    assert.strictEqual(byRel(out.children)['top.txt'], 'same');
    out = await Dir.recheckContents(out.children, L, R, ['d/changed.txt'], {});
    assert.strictEqual(byRel(out.children)['d/changed.txt'], 'newerRight');
    assert.deepStrictEqual(out.children.find((n) => n.rel === 'd').flags, { newerR: true, same: true });
    fs.writeFileSync(path.join(R, 'd/changed.txt'), 'one');
    out = await Dir.recheckContents(out.children, L, R, ['d/changed.txt'], { content: 'crc' });
    assert.strictEqual(byRel(out.children).d, 'same');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('text decoding round trips encodings', () => {
  for (const enc of ['utf8', 'utf8bom', 'utf16le', 'utf16be']) {
    const buf = Dir.encodeText('héllo\n', enc);
    const d = Dir.decodeText(buf);
    assert.strictEqual(d.text, 'héllo\n');
    assert.strictEqual(d.encoding, enc);
  }
  assert.strictEqual(Dir.decodeText(Buffer.from([0x68, 0xe9])).encoding, 'latin1');
  assert.ok(Dir.decodeText(Buffer.from([1, 0, 2])).binary);
});

test('manual alignment forces two lines onto one row', () => {
  const left = ['head', 'foo(1);', 'foo(2);', 'tail'];
  const right = ['head', 'foo(2, x);', 'foo(1, x);', 'tail'];
  const auto = TextDiff.compareLines(left, right).rows;
  assert.ok(auto.some((r) => r.l === 1 && r.r === 1));
  const { rows } = TextDiff.compareLines(left, right, undefined, [[1, 2]]);
  assert.deepStrictEqual(rows.map((r) => [r.type, r.l, r.r]),
    [['same', 0, 0], ['right', -1, 1], ['diff', 1, 2], ['left', 2, -1], ['same', 3, 3]]);
  assert.strictEqual(rows[2].manual, true);
  assert.deepStrictEqual(rows.filter((r) => r.l >= 0).map((r) => r.l), [0, 1, 2, 3]);
  assert.deepStrictEqual(rows.filter((r) => r.r >= 0).map((r) => r.r), [0, 1, 2, 3]);
});

test('crossing or out-of-range manual alignments are ignored', () => {
  const lines = ['a', 'b', 'c'];
  const { rows } = TextDiff.compareLines(lines, lines, undefined, [[2, 0], [0, 1], [9, 9]]);
  assert.deepStrictEqual(rows.map((r) => [r.l, r.r]), [[-1, 0], [0, 1], [1, -1], [2, 2]]);
});
