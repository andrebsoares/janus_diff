'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Shell = require('../src/main/shellmenu');
const { parseCli } = require('../src/main/cli');

const launcher = { exe: 'C:\\Apps\\Janus Diff.exe', args: [] };

// Fake registry driven by the same arguments reg.exe would receive.
function fakeRegistry() {
  const keys = new Map();
  const run = ([verb, key, ...rest]) => {
    if (verb === 'delete') {
      if (!keys.has(key)) throw new Error('missing');
      for (const k of [...keys.keys()]) if (k === key || k.startsWith(key + '\\')) keys.delete(k);
      return;
    }
    const name = rest[0] === '/ve' ? '' : rest[1];
    const data = rest[rest.indexOf('/d') + 1];
    keys.set(key, Object.assign(keys.get(key) || {}, { [name]: data }));
  };
  // What Explorer lists for `count` selected items of that class.
  const menu = (cls, count = 1) => [...keys.keys()].filter((k) => k.includes(`\\${cls}\\shell\\`) && !k.endsWith('\\command')).sort()
    .filter((k) => count === 1 || keys.get(k).MultiSelectModel !== 'Single').map((k) => keys.get(k)['']);
  return { keys, run, menu };
}

test('context menu follows the select / compare flow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-shell-'));
  const state = path.join(dir, 'state', 'left.json');
  const file = path.join(dir, 'a & b.txt');
  fs.writeFileSync(file, 'x');
  const reg = fakeRegistry();
  try {
    Shell.apply(Shell.plan(null, launcher), reg.run);
    assert.deepStrictEqual(reg.menu('*'), ['Janus Diff: Select Left File', 'Janus Diff: Compare']);
    assert.deepStrictEqual(reg.menu('Directory'), ['Janus Diff: Select Left Folder', 'Janus Diff: Compare']);

    Shell.selectLeft(state, file, launcher, reg.run);
    assert.deepStrictEqual(reg.menu('*'), ['Janus Diff: Compare to "a && b.txt"', 'Janus Diff: Select Left File', 'Janus Diff: Compare']);
    assert.deepStrictEqual(reg.menu('*', 2), ['Janus Diff: Compare']);
    assert.deepStrictEqual(reg.menu('Directory', 2), ['Janus Diff: Compare']);
    assert.strictEqual(reg.keys.get('HKCU\\Software\\Classes\\Directory\\shell\\JanusDiff.3Selected\\command')[''],
      '"C:\\Apps\\Janus Diff.exe" --compare-selected "%1"');
    assert.deepStrictEqual(reg.menu('Directory'), ['Janus Diff: Select Left Folder', 'Janus Diff: Compare']);
    assert.strictEqual(reg.keys.get('HKCU\\Software\\Classes\\*\\shell\\JanusDiff.1Compare\\command')[''],
      '"C:\\Apps\\Janus Diff.exe" --compare-to "%1"');

    Shell.selectLeft(state, dir, launcher, reg.run);
    assert.deepStrictEqual(reg.menu('*'), ['Janus Diff: Select Left File', 'Janus Diff: Compare']);
    assert.strictEqual(reg.menu('Directory').length, 3);

    assert.deepStrictEqual(Shell.takeLeft(state, launcher, reg.run), { path: dir, isDir: true });
    assert.deepStrictEqual(reg.menu('Directory'), ['Janus Diff: Select Left Folder', 'Janus Diff: Compare']);
    assert.strictEqual(Shell.takeLeft(state, launcher, reg.run), null);

    Shell.apply(Shell.removalPlan(), reg.run);
    assert.strictEqual(reg.keys.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('development launcher includes the app path', () => {
  const ops = Shell.plan(null, { exe: 'C:\\e\\electron.exe', args: ['C:\\src\\app'], icon: 'C:\\src\\app\\installer\\icon.ico' });
  assert.strictEqual(ops[0].command, '"C:\\e\\electron.exe" "C:\\src\\app" --select-left "%1"');
  assert.strictEqual(ops[0].icon, 'C:\\src\\app\\installer\\icon.ico');
  assert.strictEqual(Shell.plan(null, launcher)[0].icon, launcher.exe);
});

test('git settings wait for the window and use forward slashes', () => {
  assert.deepStrictEqual(Shell.gitSettings(launcher)[0],
    ['difftool.janusdiff.cmd', '"C:/Apps/Janus Diff.exe" --wait "$LOCAL" "$REMOTE"']);
});

test('command line parsing', () => {
  const cwd = path.resolve('/work');
  assert.deepStrictEqual(parseCli(['a.txt', path.resolve('/x/b.txt')], cwd),
    { mode: 'open', paths: [path.join(cwd, 'a.txt'), path.resolve('/x/b.txt')], wait: false, target: null });
  assert.strictEqual(parseCli(['--no-sandbox', '--wait', 'a', 'b'], cwd).wait, true);
  assert.deepStrictEqual(parseCli(['--no-sandbox', '--wait', 'a', 'b', 'c'], cwd).paths.length, 2);
  const sel = parseCli(['--select-left', 'f.txt'], cwd);
  assert.deepStrictEqual([sel.mode, sel.target, sel.paths], ['select-left', path.join(cwd, 'f.txt'), []]);
  assert.strictEqual(parseCli(['--compare-to'], cwd).mode, 'open');
  assert.deepStrictEqual([parseCli(['--compare-selected', 'f.txt'], cwd).mode, parseCli(['--compare-selected'], cwd).mode], ['compare-selected', 'open']);
  assert.strictEqual(parseCli(['--register-shell'], cwd).mode, 'register-shell');
});
