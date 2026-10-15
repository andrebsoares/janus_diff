'use strict';
// Folder comparison engine: aligns two directory trees by name and classifies
// every pair with quick tests (size, timestamp) and optional content tests
// (CRC, binary, rules-based).
const fs = require('fs');
const path = require('path');
const TextDiff = require('./textdiff');

const DEFAULT_CRITERIA = Object.freeze({
  compareSize: true,
  compareTimestamp: true,
  timestampTolerance: 2, // seconds
  filenameCase: false,
  content: 'none', // none | crc | binary | rules
  skipContentIfQuickSame: false,
  contentOverridesQuick: false,
  filters: '*',
  rules: TextDiff.DEFAULT_RULES,
});

const CONTENT_CONCURRENCY = 8;
const CHUNK = 1 << 16;

function globToRegExp(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + body + '$', 'i');
}

// "*.js;*.ts;-*.min.js;-node_modules/;-src/gen/;-/README.md" — a leading "-"
// excludes, a trailing slash targets folders, and a mask with a slash inside
// or in front matches the path relative to the compared folders instead of
// the name.
function parseFilters(spec) {
  const f = { incFiles: [], excFiles: [], incDirs: [], excDirs: [] };
  for (let raw of String(spec || '*').split(';')) {
    raw = raw.trim();
    if (!raw) continue;
    const exclude = raw.startsWith('-');
    if (exclude) raw = raw.slice(1);
    const isDir = /[\\/]$/.test(raw);
    if (isDir) raw = raw.slice(0, -1);
    raw = raw.replace(/\\/g, '/');
    const anchored = /^\.?\//.test(raw);
    raw = raw.replace(/^\.?\//, '');
    if (!raw) continue;
    if (raw === '*.*') raw = '*';
    f[(exclude ? 'exc' : 'inc') + (isDir ? 'Dirs' : 'Files')].push({ re: globToRegExp(raw), byPath: anchored || raw.includes('/') });
  }
  return f;
}

// rel is the item's path relative to the compared folders, "/"-separated;
// it defaults to the name, i.e. an item at the top level.
function passesFilter(f, name, isDir, rel) {
  const inc = isDir ? f.incDirs : f.incFiles;
  const exc = isDir ? f.excDirs : f.excFiles;
  const hit = (m) => m.re.test(m.byPath ? rel || name : name);
  if (exc.some(hit)) return false;
  return inc.length === 0 || inc.some(hit);
}

async function listDir(dir, rel, filters, caseSensitive) {
  const out = new Map();
  if (!dir) return out;
  let entries;
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return out;
  }
  await Promise.all(entries.map(async (name) => {
    let st;
    try {
      st = await fs.promises.stat(path.join(dir, name));
    } catch {
      return;
    }
    const isDir = st.isDirectory();
    if (!passesFilter(filters, name, isDir, rel ? rel + '/' + name : name)) return;
    let key = caseSensitive ? name : name.toLowerCase();
    if (out.has(key)) key = name;
    out.set(key, { name, isDir, size: isDir ? 0 : st.size, mtime: st.mtimeMs });
  }));
  return out;
}

let crcTable;
function crc32(buf, crc) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

async function fileCrc(file) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: CHUNK })) crc = crc32(chunk, crc);
  return crc;
}

async function readFully(handle, buf) {
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await handle.read(buf, got, buf.length - got, null);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return got;
}

async function binaryEqual(a, b) {
  const [ha, hb] = await Promise.all([fs.promises.open(a, 'r'), fs.promises.open(b, 'r')]);
  try {
    const ba = Buffer.allocUnsafe(CHUNK), bb = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const [na, nb] = await Promise.all([readFully(ha, ba), readFully(hb, bb)]);
      if (na !== nb) return false;
      if (!na) return true;
      if (ba.compare(bb, 0, nb, 0, na) !== 0) return false;
    }
  } finally {
    await Promise.all([ha.close(), hb.close()]);
  }
}

function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), encoding: 'utf8bom', binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le', 2), encoding: 'utf16le', binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), encoding: 'utf16be', binary: false };
  }
  const binary = buf.subarray(0, 8192).includes(0);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8', binary };
  } catch {
    return { text: buf.toString('latin1'), encoding: 'latin1', binary };
  }
}

function encodeText(text, encoding) {
  switch (encoding) {
    case 'utf8bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    case 'utf16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
    case 'utf16be': {
      const body = Buffer.from(text, 'utf16le');
      body.swap16();
      return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
    }
    case 'latin1': return Buffer.from(text, 'latin1');
    default: return Buffer.from(text, 'utf8');
  }
}

async function rulesEqual(a, b, rules) {
  const [ba, bb] = await Promise.all([fs.promises.readFile(a), fs.promises.readFile(b)]);
  const da = decodeText(ba), db = decodeText(bb);
  if (da.binary || db.binary) return ba.equals(bb);
  const res = TextDiff.compareLines(TextDiff.splitLines(da.text).lines, TextDiff.splitLines(db.text).lines, rules);
  return res.stats.important === 0;
}

function contentEqual(a, b, c) {
  if (c.content === 'crc') return Promise.all([fileCrc(a), fileCrc(b)]).then(([x, y]) => x === y);
  if (c.content === 'rules') return rulesEqual(a, b, c.rules);
  return binaryEqual(a, b);
}

// Quick tests only; returns true when nothing indicates a difference.
function quickSame(l, r, c) {
  if (c.compareSize && l.size !== r.size) return false;
  if (c.compareTimestamp && Math.abs(l.mtime - r.mtime) > c.timestampTolerance * 1000) return false;
  return true;
}

function classify(node, same, c) {
  if (same) { node.status = 'same'; return; }
  const dt = node.left.mtime - node.right.mtime;
  if (c.compareTimestamp && Math.abs(dt) > c.timestampTolerance * 1000) {
    node.status = dt > 0 ? 'newerLeft' : 'newerRight';
  } else {
    node.status = 'diff';
  }
}

const FLAG_OF = { same: 'same', diff: 'diff', newerLeft: 'newerL', newerRight: 'newerR', orphanLeft: 'orphanL', orphanRight: 'orphanR' };

// Folders summarise what they contain.
function aggregate(node) {
  if (!node.isDir) return { [FLAG_OF[node.status]]: true };
  const flags = {};
  for (const child of node.children) Object.assign(flags, aggregate(child));
  if (!node.left) flags.orphanR = true;
  if (!node.right) flags.orphanL = true;
  node.flags = flags;
  node.status = !node.left ? 'orphanRight' : !node.right ? 'orphanLeft'
    : Object.keys(flags).every((k) => k === 'same') ? 'same' : 'diff';
  return flags;
}

async function compareFolders(leftRoot, rightRoot, criteria, onProgress) {
  const c = Object.assign({}, DEFAULT_CRITERIA, criteria);
  c.rules = Object.assign({}, TextDiff.DEFAULT_RULES, c.rules);
  const filters = parseFilters(c.filters);
  const pending = [];
  let scanned = 0;

  // lrel / rrel are each side's own relative path (names can differ in case);
  // for a missing side they give where a copy would land.
  async function walk(leftDir, rightDir, rel, lrel, rrel) {
    const [lm, rm] = await Promise.all([
      listDir(leftDir, rel, filters, c.filenameCase),
      listDir(rightDir, rel, filters, c.filenameCase),
    ]);
    const keys = [...new Set([...lm.keys(), ...rm.keys()])];
    const nodes = [];
    for (const key of keys) {
      let l = lm.get(key) || null, r = rm.get(key) || null;
      // A file on one side and a folder on the other never match.
      const split = l && r && l.isDir !== r.isDir;
      for (const [nl, nr] of split ? [[l, null], [null, r]] : [[l, r]]) {
        const any = nl || nr;
        const node = {
          name: any.name,
          rel: rel ? rel + '/' + any.name : any.name,
          lrel: lrel.concat((nl || nr).name),
          rrel: rrel.concat((nr || nl).name),
          isDir: any.isDir,
          left: nl && { name: nl.name, size: nl.size, mtime: nl.mtime },
          right: nr && { name: nr.name, size: nr.size, mtime: nr.mtime },
          status: 'same',
        };
        nodes.push(node);
      }
    }
    nodes.sort((x, y) => (y.isDir - x.isDir) || x.name.localeCompare(y.name, undefined, { sensitivity: 'base' }) || (x.name < y.name ? -1 : 1));
    await Promise.all(nodes.map(async (node) => {
      const lp = node.left && path.join(leftDir, node.left.name);
      const rp = node.right && path.join(rightDir, node.right.name);
      if (node.isDir) {
        node.children = await walk(lp, rp, node.rel, node.lrel, node.rrel);
        return;
      }
      scanned++;
      if (onProgress && scanned % 500 === 0) onProgress({ scanned });
      if (!node.left) { node.status = 'orphanRight'; return; }
      if (!node.right) { node.status = 'orphanLeft'; return; }
      const quick = quickSame(node.left, node.right, c);
      if (c.content !== 'none' && !(c.skipContentIfQuickSame && quick)) {
        pending.push({ node, lp, rp, quick });
      } else {
        classify(node, quick, c);
      }
    }));
    return nodes;
  }

  const children = await walk(leftRoot, rightRoot, '', [], []);
  await compareContents(pending, c, (compared) => {
    if (onProgress && compared % 100 === 0) onProgress({ scanned, compared, toCompare: pending.length });
  });
  const root = { name: '', rel: '', isDir: true, left: {}, right: {}, children };
  aggregate(root);
  return { children, flags: root.flags, fileCount: scanned };
}

// Compares the contents of the jobs' files a few at a time and classifies
// their nodes; onDone receives how many were started so far.
async function compareContents(jobs, c, onDone) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONTENT_CONCURRENCY, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      let same;
      try {
        same = await contentEqual(job.lp, job.rp, c);
      } catch {
        same = false;
      }
      classify(job.node, c.contentOverridesQuick ? same : same && job.quick, c);
      if (onDone) onDone(next);
    }
  }));
}

// "Compare Contents" on part of an existing result: the files at rels (a
// folder stands for everything in it) present on both sides are compared
// with criteria.content (default rules-based), which overrides the quick
// tests, and the folders are summarised again. Returns the updated tree.
async function recheckContents(children, leftRoot, rightRoot, rels, criteria, onProgress) {
  const c = Object.assign({}, DEFAULT_CRITERIA, criteria, { contentOverridesQuick: true });
  if (c.content === 'none') c.content = 'rules';
  c.rules = Object.assign({}, TextDiff.DEFAULT_RULES, c.rules);
  const wanted = new Set(rels);
  const jobs = [];
  const visit = (nodes, inside) => nodes.forEach((n) => {
    const hit = inside || wanted.has(n.rel);
    if (n.isDir) visit(n.children, hit);
    else if (hit && n.left && n.right) jobs.push({ node: n, lp: path.join(leftRoot, ...n.lrel), rp: path.join(rightRoot, ...n.rrel) });
  });
  visit(children, false);
  await compareContents(jobs, c, (compared) => {
    if (onProgress && compared % 100 === 0) onProgress({ compared, toCompare: jobs.length });
  });
  aggregate({ name: '', rel: '', isDir: true, left: {}, right: {}, children });
  const same = jobs.filter((j) => j.node.status === 'same').length;
  return { children, compared: jobs.length, same };
}

module.exports = { DEFAULT_CRITERIA, compareFolders, recheckContents, parseFilters, passesFilter, decodeText, encodeText, crc32, binaryEqual };
