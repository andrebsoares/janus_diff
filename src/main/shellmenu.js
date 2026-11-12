'use strict';
// Windows Explorer context menu ("Janus Diff: Select Left File" / "Compare to
// ..." / "Compare") and git difftool registration.
//
// The menu is made of static verbs under HKCU\Software\Classes. Their labels
// cannot be computed by Explorer, so the app rewrites them whenever the
// remembered left side changes.
//
// With several items selected only "Compare" is offered: the select / compare
// to verbs are limited to a single item. A static verb cannot be limited to
// multiple items, so "Compare" also shows for one item and opens it alone.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CLASSES = 'HKCU\\Software\\Classes';
const TARGETS = { file: '*', dir: 'Directory' };
// Explorer lists static verbs by key name, so "Compare to" comes first.
const VERBS = { compare: 'JanusDiff.1Compare', select: 'JanusDiff.2Select', selected: 'JanusDiff.3Selected' };
const MAX_LABEL_NAME = 60;

function verbKey(kind, verb) {
  return `${CLASSES}\\${TARGETS[kind]}\\shell\\${VERBS[verb]}`;
}

function allKeys() {
  return Object.keys(TARGETS).flatMap((kind) => Object.keys(VERBS).map((verb) => verbKey(kind, verb)));
}

const quote = (s) => `"${s}"`;

// launcher: { exe, args, icon } — args is the app path when running from
// source; icon defaults to the executable.
function commandLine(launcher, flag) {
  return [launcher.exe, ...launcher.args].map(quote).join(' ') + ` ${flag} "%1"`;
}

function compareLabel(leftPath) {
  let name = path.win32.basename(leftPath) || leftPath;
  if (name.length > MAX_LABEL_NAME) name = name.slice(0, MAX_LABEL_NAME - 1) + '…';
  // "&" would otherwise mark a keyboard accelerator.
  return `Janus Diff: Compare to "${name.replace(/&/g, '&&')}"`;
}

// Registry operations that bring the menu in line with the remembered left
// side: left is null or { path, isDir }.
function plan(left, launcher) {
  const ops = [];
  for (const kind of Object.keys(TARGETS)) {
    const isDir = kind === 'dir';
    ops.push({
      op: 'add',
      key: verbKey(kind, 'select'),
      label: isDir ? 'Janus Diff: Select Left Folder' : 'Janus Diff: Select Left File',
      command: commandLine(launcher, '--select-left'),
      icon: launcher.icon || launcher.exe,
      multi: 'Single',
    });
    ops.push({ op: 'add', key: verbKey(kind, 'selected'), label: 'Janus Diff: Compare', command: commandLine(launcher, '--compare-selected'), icon: launcher.icon || launcher.exe, multi: 'Player' });
    // A file can only be compared with a file, a folder with a folder.
    if (left && left.isDir === isDir) {
      ops.push({ op: 'add', key: verbKey(kind, 'compare'), label: compareLabel(left.path), command: commandLine(launcher, '--compare-to'), icon: launcher.icon || launcher.exe, multi: 'Single' });
    } else {
      ops.push({ op: 'delete', key: verbKey(kind, 'compare') });
    }
  }
  return ops;
}

function removalPlan() {
  return allKeys().map((key) => ({ op: 'delete', key }));
}

function regExe(args) {
  if (process.platform !== 'win32') return;
  execFileSync('reg.exe', args, { stdio: 'ignore', windowsHide: true });
}

function apply(ops, run = regExe) {
  for (const o of ops) {
    if (o.op === 'delete') {
      try {
        run(['delete', o.key, '/f']);
      } catch { /* the key was not there */ }
      continue;
    }
    run(['add', o.key, '/ve', '/d', o.label, '/f']);
    run(['add', o.key, '/v', 'Icon', '/d', o.icon, '/f']);
    run(['add', o.key, '/v', 'MultiSelectModel', '/d', o.multi, '/f']);
    run(['add', `${o.key}\\command`, '/ve', '/d', o.command, '/f']);
  }
}

function loadLeft(stateFile) {
  try {
    const left = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return left && typeof left.path === 'string' ? left : null;
  } catch {
    return null;
  }
}

function saveLeft(stateFile, left) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(left));
}

// Remembers p as the left side and updates the menu.
function selectLeft(stateFile, p, launcher, run) {
  const left = { path: p, isDir: fs.statSync(p).isDirectory() };
  saveLeft(stateFile, left);
  apply(plan(left, launcher), run);
  return left;
}

// Returns the remembered left side (or null) and puts the menu back to its
// initial state.
function takeLeft(stateFile, launcher, run) {
  const left = loadLeft(stateFile);
  saveLeft(stateFile, null);
  apply(plan(null, launcher), run);
  return left;
}

// `git difftool` deletes its temporary files as soon as the tool exits, hence
// --wait. Forward slashes survive git's shell quoting.
//
// git appends repository file names to these commands, and Chromium reads any
// argument that starts with -- as one of its switches, wherever it is: a file
// named `--gpu-launcher=<command>` at the root of a cloned repository would
// run that command. The bare -- before git's arguments ends the switches.
//
// `git jd` is `git diff` with diff.external set for that one command: it opens
// much faster than `git difftool`, whose helper script costs about two seconds
// per file on Windows, and leaves plain `git diff` printing to the terminal.
function gitSettings(launcher) {
  const cmd = [launcher.exe, ...launcher.args].map((s) => quote(s.replace(/\\/g, '/'))).join(' ');
  const external = `${cmd} --git-external --`.replace(/"/g, '\\"');
  return [
    ['difftool.janusdiff.cmd', `${cmd} --wait -- "$LOCAL" "$REMOTE"`],
    ['diff.tool', 'janusdiff'],
    ['difftool.prompt', 'false'],
    ['alias.jd', `-c "diff.external=${external}" diff`],
  ];
}

function gitSetup(launcher, run = (args) => execFileSync('git', args, { stdio: 'ignore', windowsHide: true })) {
  for (const [key, value] of gitSettings(launcher)) run(['config', '--global', key, value]);
}

module.exports = { plan, removalPlan, apply, allKeys, selectLeft, takeLeft, loadLeft, gitSettings, gitSetup, compareLabel };
