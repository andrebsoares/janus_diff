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
