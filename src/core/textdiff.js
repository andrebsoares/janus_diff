// Text comparison engine: line alignment (Myers O(ND), linear space), importance
// rules, closeness matching inside change blocks and in-line character diffs.
// Loaded both by Node (tests, folder "rules-based" comparison) and by the renderer.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TextDiff = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // "Importance" settings; true means a difference of that kind is important.
  const DEFAULT_RULES = Object.freeze({
    leadingWS: true,
    embeddedWS: true,
    trailingWS: false,
    characterCase: true,
    orphansAlwaysImportant: true,
  });

  const MAX_EDIT_COST = 5000;
  const MAX_PAIRING_CELLS = 250000;
  const MAX_INLINE_CHARS = 4000;
  const CLOSENESS_THRESHOLD = 0.5;

  function splitLines(text) {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    const cr = (text.match(/\r/g) || []).length - crlf;
    let eol = '\n';
    if (crlf >= lf && crlf >= cr && crlf > 0) eol = '\r\n';
    else if (cr > lf) eol = '\r';
    const lines = text.split(/\r\n|\n|\r/);
    let finalNewline = false;
    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
      finalNewline = true;
    }
    if (lines.length === 1 && lines[0] === '') lines.pop();
    return { lines, eol, finalNewline };
  }

  function joinLines(lines, eol, finalNewline) {
    return lines.join(eol) + (finalNewline && lines.length ? eol : '');
  }

  // Reduces a line to what is important under the rules; two lines whose keys
  // match differ only in unimportant ways.
  function sigKey(line, rules) {
    let s = line;
    if (!rules.trailingWS) s = s.replace(/\s+$/, '');
    if (!rules.leadingWS) s = s.replace(/^\s+/, '');
    if (!rules.embeddedWS) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
      s = m[1] + m[2].replace(/\s+/g, '') + m[3];
    }
    if (!rules.characterCase) s = s.toLowerCase();
    return s;
  }

  // Finds the middle snake of the shortest edit script between a[aLo,aHi) and
  // b[bLo,bHi). Returns null when the edit cost exceeds the cap.
  function midSnake(a, aLo, aHi, b, bLo, bHi, vf, vb, off) {
    const N = aHi - aLo, M = bHi - bLo;
    const delta = N - M;
    const odd = (delta & 1) !== 0;
    const max = Math.min((N + M + 1) >> 1, MAX_EDIT_COST);
    vf[off + 1] = 0;
    vb[off + 1] = 0;
    for (let d = 0; d <= max; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])) ? vf[off + k + 1] : vf[off + k - 1] + 1;
        let y = x - k;
        const x0 = x, y0 = y;
        while (x < N && y < M && a[aLo + x] === b[bLo + y]) { x++; y++; }
        vf[off + k] = x;
        const kr = delta - k;
        if (odd && kr >= -(d - 1) && kr <= d - 1 && x + vb[off + kr] >= N) return [x0, y0, x, y];
      }
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && vb[off + k - 1] < vb[off + k + 1])) ? vb[off + k + 1] : vb[off + k - 1] + 1;
        let y = x - k;
        const x0 = x, y0 = y;
        while (x < N && y < M && a[aHi - 1 - x] === b[bHi - 1 - y]) { x++; y++; }
        vb[off + k] = x;
        const kf = delta - k;
        if (!odd && kf >= -d && kf <= d && x + vf[off + kf] >= N) return [N - x, M - y, N - x0, M - y0];
      }
    }
    return null;
  }

  // Marks deleted elements of a and inserted elements of b.
  function myers(a, b) {
    const N = a.length, M = b.length;
    const delA = new Uint8Array(N), insB = new Uint8Array(M);
    const off = N + M + 2;
    const vf = new Int32Array(2 * off + 2), vb = new Int32Array(2 * off + 2);
    const stack = [[0, N, 0, M]];
    while (stack.length) {
      let [aLo, aHi, bLo, bHi] = stack.pop();
      while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { aLo++; bLo++; }
      while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi--; }
      if (aLo === aHi) { for (let j = bLo; j < bHi; j++) insB[j] = 1; continue; }
      if (bLo === bHi) { for (let i = aLo; i < aHi; i++) delA[i] = 1; continue; }
      const s = midSnake(a, aLo, aHi, b, bLo, bHi, vf, vb, off);
      if (!s) {
        for (let i = aLo; i < aHi; i++) delA[i] = 1;
        for (let j = bLo; j < bHi; j++) insB[j] = 1;
        continue;
      }
      stack.push([aLo, aLo + s[0], bLo, bLo + s[1]]);
      stack.push([aLo + s[2], aHi, bLo + s[3], bHi]);
    }
    return { delA, insB };
  }

  function internPair(aKeys, bKeys) {
    const ids = new Map();
    const conv = (keys) => {
      const out = new Int32Array(keys.length);
      for (let i = 0; i < keys.length; i++) {
        let id = ids.get(keys[i]);
        if (id === undefined) { id = ids.size; ids.set(keys[i], id); }
        out[i] = id;
      }
      return out;
    };
    return [conv(aKeys), conv(bKeys)];
  }

  function tokenBag(line) {
    const bag = new Map();
    const tokens = line.match(/\w+|[^\s\w]/g) || [];
    for (const t of tokens) bag.set(t, (bag.get(t) || 0) + 1);
    return { bag, n: tokens.length };
  }

  function closeness(x, y) {
    if (!x.n || !y.n) return 0;
    let common = 0;
    const [small, big] = x.bag.size <= y.bag.size ? [x.bag, y.bag] : [y.bag, x.bag];
    for (const [t, c] of small) {
      const o = big.get(t);
      if (o) common += Math.min(c, o);
    }
    return (2 * common) / (x.n + y.n);
  }

  // Pairs deleted lines with inserted lines of one change block. Close lines are
  // matched first (order preserving); what is left between matches is laid side
  // by side from the top, and the surplus becomes orphans.
  function pairBlock(dels, inss, leftLines, rightLines, emit) {
    const n = dels.length, m = inss.length;
    const anchors = [];
    if (n && m && n * m <= MAX_PAIRING_CELLS) {
      const lb = dels.map((i) => tokenBag(leftLines[i]));
      const rb = inss.map((j) => tokenBag(rightLines[j]));
      const w = m + 1;
      const score = new Float32Array((n + 1) * w);
      const step = new Uint8Array((n + 1) * w);
      for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
          let best = score[(i - 1) * w + j], dir = 1;
          if (score[i * w + j - 1] > best) { best = score[i * w + j - 1]; dir = 2; }
          const c = closeness(lb[i - 1], rb[j - 1]);
          if (c >= CLOSENESS_THRESHOLD && score[(i - 1) * w + j - 1] + c > best) {
            best = score[(i - 1) * w + j - 1] + c; dir = 3;
          }
          score[i * w + j] = best;
          step[i * w + j] = dir;
        }
      }
      for (let i = n, j = m; i > 0 && j > 0;) {
        const dir = step[i * w + j];
        if (dir === 3) { anchors.push([i - 1, j - 1]); i--; j--; } else if (dir === 1) i--; else j--;
      }
      anchors.reverse();
    }
    anchors.push([n, m]);
    let pi = 0, pj = 0;
    for (const [ai, aj] of anchors) {
      const zip = Math.min(ai - pi, aj - pj);
      for (let k = 0; k < zip; k++) emit('diff', dels[pi + k], inss[pj + k]);
      for (let i = pi + zip; i < ai; i++) emit('left', dels[i], -1);
      for (let j = pj + zip; j < aj; j++) emit('right', -1, inss[j]);
      if (ai < n) emit('diff', dels[ai], inss[aj]);
      pi = ai + 1; pj = aj + 1;
    }
  }

  // Manual alignments as [leftLine, rightLine] pairs, in order; pairs that are
  // out of range or cross an earlier one are dropped.
  function usableAligns(aligns, N, M) {
    const out = [];
    let pl = -1, pr = -1;
    for (const [l, r] of (aligns || []).slice().sort((p, q) => p[0] - q[0])) {
      if (l <= pl || r <= pr || l >= N || r >= M) continue;
      out.push([l, r]);
      pl = l; pr = r;
    }
    return out;
  }

  // Row types: same, insig (unimportant difference), diff (important
  // difference), left / right (orphan line on that side). Each pair in aligns
  // forces those two lines onto one row (marked manual); the lines before and
  // after it are compared separately.
  function compareLines(leftLines, rightLines, rules, aligns) {
    rules = Object.assign({}, DEFAULT_RULES, rules);
    const lk = leftLines.map((l) => sigKey(l, rules));
    const rk = rightLines.map((l) => sigKey(l, rules));
    const [a, b] = internPair(lk, rk);
    const rows = [];
    const emit = (type, l, r) => {
      if (!rules.orphansAlwaysImportant && (type === 'left' || type === 'right')) {
        const text = type === 'left' ? leftLines[l] : rightLines[r];
        if (sigKey(text, rules).trim() === '') type = type === 'left' ? 'insigLeft' : 'insigRight';
      }
      rows.push({ type, l, r });
    };
    const range = (aLo, aHi, bLo, bHi) => {
      const { delA, insB } = myers(a.subarray(aLo, aHi), b.subarray(bLo, bHi));
      let i = aLo, j = bLo;
      while (i < aHi || j < bHi) {
        if (i < aHi && j < bHi && !delA[i - aLo] && !insB[j - bLo]) {
          emit(leftLines[i] === rightLines[j] ? 'same' : 'insig', i, j);
          i++; j++;
          continue;
        }
        const dels = [], inss = [];
        while (i < aHi && delA[i - aLo]) dels.push(i++);
        while (j < bHi && insB[j - bLo]) inss.push(j++);
        pairBlock(dels, inss, leftLines, rightLines, emit);
      }
    };
    const N = leftLines.length, M = rightLines.length;
    let pl = 0, pr = 0;
    for (const [l, r] of usableAligns(aligns, N, M)) {
      range(pl, l, pr, r);
      rows.push({ type: leftLines[l] === rightLines[r] ? 'same' : a[l] === b[r] ? 'insig' : 'diff', l, r, manual: true });
      pl = l + 1; pr = r + 1;
    }
    range(pl, N, pr, M);
    return { rows, sections: buildSections(rows), stats: countRows(rows) };
  }

  function isImportant(type) {
    return type === 'diff' || type === 'left' || type === 'right';
  }

  // A section is a run of consecutive non-matching rows.
  function buildSections(rows) {
    const sections = [];
    let cur = null;
    rows.forEach((row, idx) => {
      if (row.type === 'same') { cur = null; row.sec = -1; return; }
      if (!cur) { cur = { start: idx, end: idx, important: false }; sections.push(cur); }
      cur.end = idx;
      if (isImportant(row.type)) cur.important = true;
      row.sec = sections.length - 1;
    });
    return sections;
  }

  function countRows(rows) {
    const stats = { same: 0, insig: 0, diff: 0, left: 0, right: 0 };
    for (const r of rows) {
      if (r.type === 'insigLeft' || r.type === 'insigRight') stats.insig++;
      else stats[r.type]++;
    }
    stats.important = stats.diff + stats.left + stats.right;
    return stats;
  }

  function runsOf(marks, text, rules, other) {
    const runs = [];
    const lead = /^\s*/.exec(text)[0].length;
    const trail = text.length - /\s*$/.exec(text)[0].length;
    for (let i = 0; i < marks.length;) {
      if (!marks[i]) { i++; continue; }
      let e = i;
      while (e < marks.length && marks[e]) e++;
      const piece = text.slice(i, e);
      let insig = false;
      if (/^\s+$/.test(piece)) {
        if (e <= lead) insig = !rules.leadingWS;
        else if (i >= trail) insig = !rules.trailingWS;
        else insig = !rules.embeddedWS;
      }
      runs.push([i, e, insig ? 'insig' : 'sig']);
      i = e;
    }
    // Case-only differences line up as equal characters when case is unimportant.
    if (!rules.characterCase && other !== undefined && text.length === other.length) {
      for (let i = 0; i < text.length; i++) {
        if (!marks[i] && text[i] !== other[i]) runs.push([i, i + 1, 'insig']);
      }
      runs.sort((p, q) => p[0] - q[0]);
    }
    return runs;
  }

  // Character ranges that differ between two lines: [[start, end, 'sig'|'insig']].
  function inlineDiff(left, right, rules) {
    rules = Object.assign({}, DEFAULT_RULES, rules);
    if (left === right) return { left: [], right: [] };
    if (left.length > MAX_INLINE_CHARS || right.length > MAX_INLINE_CHARS) {
      return { left: left ? [[0, left.length, 'sig']] : [], right: right ? [[0, right.length, 'sig']] : [] };
    }
    const codes = (s) => {
      const src = rules.characterCase ? s : s.toLowerCase();
      const out = new Int32Array(s.length);
      // toLowerCase can change length for a few code points; fall back to raw.
      const use = src.length === s.length ? src : s;
      for (let i = 0; i < s.length; i++) out[i] = use.charCodeAt(i);
      return out;
    };
    const { delA, insB } = myers(codes(left), codes(right));
    return { left: runsOf(delA, left, rules, right), right: runsOf(insB, right, rules, left) };
  }

  // Unified diff ("patch") of two texts following the alignment in rows, as
  // produced by compareLines. Lines are compared exactly, whatever the rules
  // said; each run of changed rows prints its removals before its additions.
  // opts: { leftName, rightName, context = 3, leftFinalNewline = true,
  // rightFinalNewline = true }. Returns '' when the texts are identical.
  function unifiedDiff(rows, leftLines, rightLines, opts) {
    opts = opts || {};
    const context = opts.context === undefined ? 3 : opts.context;
    const lastL = opts.leftFinalNewline === false ? leftLines.length - 1 : -1;
    const lastR = opts.rightFinalNewline === false ? rightLines.length - 1 : -1;
    const ops = [];
    let dels = [], adds = [];
    const flush = () => { ops.push(...dels, ...adds); dels = []; adds = []; };
    for (const row of rows) {
      // A last line without a newline differs from one that has it.
      if (row.l >= 0 && row.r >= 0 && leftLines[row.l] === rightLines[row.r] && (row.l === lastL) === (row.r === lastR)) {
        flush();
        ops.push({ t: ' ', l: row.l, r: row.r });
        continue;
      }
      if (row.l >= 0) dels.push({ t: '-', l: row.l });
      if (row.r >= 0) adds.push({ t: '+', r: row.r });
    }
    flush();
    const changed = [];
    ops.forEach((op, i) => { if (op.t !== ' ') changed.push(i); });
    if (!changed.length) return '';

    // Lines of each side before op i, for the hunk headers.
    const beforeL = [], beforeR = [];
    let nl = 0, nr = 0;
    for (const op of ops) {
      beforeL.push(nl); beforeR.push(nr);
      if (op.t !== '+') nl++;
      if (op.t !== '-') nr++;
    }
    const out = [`--- ${opts.leftName || 'left'}`, `+++ ${opts.rightName || 'right'}`];
    const range = (start, count) => (count === 1 ? `${start}` : `${count ? start : start - 1},${count}`);
    for (let c = 0; c < changed.length;) {
      const lo = Math.max(0, changed[c] - context);
      let end = changed[c];
      // Changes at most twice the context apart share one hunk.
      while (c + 1 < changed.length && changed[c + 1] - end - 1 <= 2 * context) end = changed[++c];
      c++;
      const hi = Math.min(ops.length - 1, end + context);
      const body = [];
      let cl = 0, cr = 0;
      for (let i = lo; i <= hi; i++) {
        const op = ops[i];
        const text = op.t === '+' ? rightLines[op.r] : leftLines[op.l];
        body.push(op.t + text);
        if (op.t !== '+') cl++;
        if (op.t !== '-') cr++;
        if ((op.t !== '+' && op.l === lastL) || (op.t === '+' && op.r === lastR)) body.push('\\ No newline at end of file');
      }
      out.push(`@@ -${range(beforeL[lo] + 1, cl)} +${range(beforeR[lo] + 1, cr)} @@`, ...body);
    }
    return out.join('\n') + '\n';
  }

  return { DEFAULT_RULES, splitLines, joinLines, sigKey, myers, compareLines, inlineDiff, isImportant, buildSections, unifiedDiff };
});
