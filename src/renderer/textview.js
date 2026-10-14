'use strict';
// Text Compare view: two aligned panes, section navigation, copy between
// sides, manual alignment, line editing and saving.

const TV_ROW = 18;
const TV_TAB = 4;

const TV_KEYS = {
  'Ctrl+S': 'Save', F12: 'SaveAs', F5: 'Refresh', 'Ctrl+Z': 'Undo', 'Ctrl+Y': 'Redo', 'Ctrl+Shift+Z': 'Redo',
  'Ctrl+R': 'CopyRight', 'Ctrl+L': 'CopyLeft', 'Ctrl+Shift+R': 'CopyItemRight', 'Ctrl+Shift+L': 'CopyItemLeft',
  'Ctrl+Enter': 'InsertItemAfter', 'Ctrl+A': 'SelectAll', 'Ctrl+D': 'SelectSection', F2: 'FullEdit', Enter: 'FullEdit',
  'Ctrl+N': 'DiffNext', 'Ctrl+P': 'DiffPrev', 'Ctrl+F': 'Find', F3: 'FindNext', 'Shift+F3': 'FindPrev',
  'Ctrl+G': 'GoTo', Del: 'Delete', 'Alt+Left': 'GoLeft', 'Alt+Right': 'GoRight', F6: 'GoNext', 'Shift+F6': 'GoNext',
  Up: 'Up', Down: 'Down', PageUp: 'PageUp', PageDown: 'PageDown', 'Ctrl+Home': 'Top', 'Ctrl+End': 'Bottom',
  'Shift+Up': 'SelUp', 'Shift+Down': 'SelDown', 'Ctrl+C': 'CopyText', F7: 'AlignWith', Esc: 'AlignCancel',
};

const TV_TYPE_CAPTION = {
  same: 'Same', insig: 'Unimportant Difference', diff: 'Important Difference',
  left: 'Important Left Orphan', right: 'Important Right Orphan',
  insigLeft: 'Unimportant Left Orphan', insigRight: 'Unimportant Right Orphan',
};

const TV_RULE_FIELDS = [
  { type: 'heading', label: 'Importance — differences in these are important:' },
  { key: 'leadingWS', type: 'check', label: 'Leading whitespace' },
  { key: 'embeddedWS', type: 'check', label: 'Embedded whitespace' },
  { key: 'trailingWS', type: 'check', label: 'Trailing whitespace' },
  { key: 'characterCase', type: 'check', label: 'Character case' },
  { key: 'orphansAlwaysImportant', type: 'check', label: 'Orphan lines are always important' },
];

function tvNewSide() {
  return { path: '', lines: [], eol: '\n', finalNewline: true, encoding: 'utf8', dirty: false, binary: false, maxLen: 0 };
}

class TextView {
  constructor(app, left, right) {
    this.app = app;
    this.type = 'text';
    this.keymap = TV_KEYS;
    this.sides = { left: tvNewSide(), right: tvNewSide() };
    this.rules = Object.assign({}, TextDiff.DEFAULT_RULES);
    this.filter = 'all';
    this.ignoreInsig = false;
    this.showWS = false;
    this.showNums = true;
    this.rows = [];
    this.sections = [];
    this.vis = [];
    this.cur = 0;
    this.anchor = 0;
    this.side = 'left';
    this.undo = [];
    this.redo = [];
    // Manual alignments, [leftLine, rightLine], and the line picked by F7
    // that is waiting for its counterpart.
    this.aligns = [];
    this.alignFrom = null;
    this.findText = '';
    this.build();
    this.load('left', left).then(() => this.load('right', right));
  }

  get title() {
    const name = (s) => (s.path ? api.path.basename(s.path) : 'New');
    const dirty = this.sides.left.dirty || this.sides.right.dirty ? '*' : '';
    return `${name(this.sides.left)} <--> ${name(this.sides.right)}${dirty}`;
  }

  build() {
    const tb = buildToolbar([
      ['✱ All', 'FavCompareAll', 'Show all lines'], ['≠ Diffs', 'FavDiff', 'Show only differences'], ['= Same', 'FavSame', 'Show only matching lines'],
      ['≈ Minor', 'InsigIgnored', 'Ignore unimportant differences'], ['Rules', 'Rules', 'Session settings: importance'], '|',
      ['⇨ Copy', 'CopyRight', 'Copy section or selection to right (Ctrl+R)'], ['⇦ Copy', 'CopyLeft', 'Copy section or selection to left (Ctrl+L)'], '|',
      ['↓ Next', 'DiffNext', 'Next difference section (Ctrl+N)'], ['↑ Prev', 'DiffPrev', 'Previous difference section (Ctrl+P)'],
      ['⇅ Align', 'AlignWith', 'Align this line with a line on the other side (F7)'], '|',
      ['↶ Undo', 'Undo', 'Undo (Ctrl+Z)'], ['↷ Redo', 'Redo', 'Redo (Ctrl+Y)'], ['✎ Edit', 'FullEdit', 'Edit line (F2)'], ['Save', 'Save', 'Save (Ctrl+S)'], '|',
      ['⇄ Swap', 'Swap', 'Swap sides'], ['⟳ Reload', 'Refresh', 'Reload files (F5)'], ['¶', 'ShowWS', 'Visible whitespace'], ['#', 'ShowItemNum', 'Line numbers'],
    ], (c) => this.command(c));
    this.buttons = tb.buttons;

    this.pathBox = {};
    this.panes = {};
    this.rowsEl = {};
    for (const side of ['left', 'right']) {
      this.pathBox[side] = buildPathBox(side === 'left' ? 'Left file' : 'Right file',
        (p) => this.load(side, p), () => this.browse(side));
      this.rowsEl[side] = h('div', { class: 'tv-rows' });
      const pane = h('div', { class: 'tv-pane', tabIndex: -1 }, this.rowsEl[side]);
      pane.addEventListener('mousedown', (e) => this.onMouse(e, side));
      pane.addEventListener('scroll', () => {
        const other = this.panes[side === 'left' ? 'right' : 'left'];
        if (other.scrollLeft !== pane.scrollLeft) other.scrollLeft = pane.scrollLeft;
      });
      pane.addEventListener('dragover', (e) => e.preventDefault());
      pane.addEventListener('drop', (e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) this.load(side, api.pathForFile(f));
      });
      this.panes[side] = pane;
    }
    this.thumb = h('canvas', { class: 'tv-thumb', width: 18, height: 100 });
    this.thumb.addEventListener('mousedown', (e) => this.onThumb(e));
    this.thumb.addEventListener('mousemove', (e) => { if (e.buttons & 1) this.onThumb(e); });
    const bar = h('div', { class: 'vscroll' });
    this.body = h('div', { class: 'tv-body' }, this.thumb, this.panes.left, this.panes.right, bar);
    this.scroller = new VScroller(this.body, bar, TV_ROW, (first, n, off) => this.render(first, n, off));

    this.details = h('div', { class: 'tv-details' });
    this.status = h('div', { class: 'statusbar' });
    this.el = h('div', { class: 'view textview' }, tb.bar,
      h('div', { class: 'pathbar tv-grid' }, h('span'), this.pathBox.left.box, this.pathBox.right.box, h('span')),
      this.body, this.details, this.status);

    const probe = h('span', { class: 'tv-probe' }, 'MMMMMMMMMM');
    this.el.append(probe);
    this.probe = probe;
  }

  onShow() {
    this.charW = this.probe.getBoundingClientRect().width / 10 || 7.8;
    this.scroller.refresh();
  }

  session() {
    return { type: 'text', left: this.sides.left.path, right: this.sides.right.path };
  }

  // ---- loading and saving ------------------------------------------------

  async browse(side) {
    const p = await api.pickFile(this.sides[side].path || this.sides[side === 'left' ? 'right' : 'left'].path);
    if (p) this.load(side, p);
  }

  async load(side, p) {
    const s = this.sides[side];
    if (p && s.dirty && p !== s.path && !(await Modal.confirm('Open', `Discard unsaved changes to ${api.path.basename(s.path || 'the ' + side + ' side')}?`, 'Discard'))) return;
    Object.assign(s, tvNewSide(), { path: p || '' });
    this.pathBox[side].input.value = s.path;
    this.message = '';
    if (p) {
      try {
        const st = await api.stat(p);
        if (!st.exists) throw new Error('File not found');
        if (st.isDir) throw new Error('Is a folder');
        const data = await api.readText(p);
        Object.assign(s, TextDiff.splitLines(data.text), { encoding: data.encoding, binary: data.binary });
        if (data.binary) this.message = `${api.path.basename(p)} contains binary data.`;
      } catch (err) {
        this.message = `${p}: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
      }
    }
    this.undo = [];
    this.redo = [];
    this.aligns = [];
    this.recompare();
    this.cur = this.anchor = 0;
    if (this.sides.left.path && this.sides.right.path) {
      api.rememberSession(this.session());
      this.gotoSection(1, true);
    }
    this.app.updateTabs();
  }

  async saveSide(side, forceDialog) {
    const s = this.sides[side];
    let p = s.path;
    if (!p || forceDialog) {
      p = await api.saveFileDialog(s.path);
      if (!p) return false;
    }
    try {
      await api.writeText(p, TextDiff.joinLines(s.lines, s.eol, s.finalNewline), s.encoding);
    } catch (err) {
      await Modal.message('Save', `Could not save ${p}: ${err.message}`);
      return false;
    }
    s.path = p;
    s.dirty = false;
    this.pathBox[side].input.value = p;
    return true;
  }

  async save() {
    for (const side of ['left', 'right']) {
      if (this.sides[side].dirty && !(await this.saveSide(side))) return false;
    }
    this.afterChange();
    return true;
  }

  async onClose() {
    const dirty = ['left', 'right'].filter((s) => this.sides[s].dirty);
    if (!dirty.length) return true;
    const answer = await Modal.show('Close', h('div', { class: 'dlg-text' }, `Save changes to the ${dirty.join(' and ')} side?`),
      [['Save', 'save', true], ["Don't Save", 'discard'], ['Cancel', null]]);
    if (answer === 'save') return this.save();
    return answer === 'discard';
  }

  // ---- comparison --------------------------------------------------------

  recompare(keepLine) {
    const L = this.sides.left, R = this.sides.right;
    const res = TextDiff.compareLines(L.lines, R.lines, this.rules, this.aligns);
    this.alignFrom = null;
    this.rows = res.rows;
    this.sections = res.sections;
    this.stats = res.stats;
    // First row of each section that has a line on a given side: that is
    // where the gutter's copy button goes.
    for (const sec of this.sections) {
      for (const key of ['l', 'r']) {
        sec[key] = -1;
        for (let i = sec.start; i <= sec.end && sec[key] < 0; i++) if (this.rows[i][key] >= 0) sec[key] = i;
      }
    }
    for (const s of [L, R]) {
      let max = 0;
      for (const line of s.lines) {
        const len = line.includes('\t') ? line.length + (TV_TAB - 1) * (line.split('\t').length - 1) : line.length;
        if (len > max) max = len;
      }
      s.maxLen = max;
    }
    this.refilter(keepLine);
  }

  // What a row counts as once "ignore unimportant differences" is applied.
  kind(row) {
    if (row.type === 'same') return 'same';
    if (TextDiff.isImportant(row.type)) return 'diff';
    return this.ignoreInsig ? 'same' : 'insig';
  }

  refilter(keepLine) {
    const key = this.side === 'left' ? 'l' : 'r';
    if (keepLine === undefined && this.vis.length && this.rows.length) {
      const row = this.rows[Math.min(this.vis[this.cur] || 0, this.rows.length - 1)];
      keepLine = row ? Math.max(row.l, row.r) : 0;
    }
    this.vis = [];
    this.rows.forEach((row, i) => {
      const k = this.kind(row);
      if (this.filter === 'all' || (this.filter === 'diff' ? k !== 'same' : k === 'same')) this.vis.push(i);
    });
    let cur = 0;
    if (keepLine !== undefined) {
      cur = this.vis.findIndex((i) => this.rows[i][key] >= keepLine || (this.rows[i][key] < 0 && Math.max(this.rows[i].l, this.rows[i].r) >= keepLine));
      if (cur < 0) cur = Math.max(0, this.vis.length - 1);
    }
    this.cur = this.anchor = cur;
    this.scroller.setCount(this.vis.length);
    this.afterChange();
  }

  afterChange() {
    for (const [cmd, on] of [['FavCompareAll', this.filter === 'all'], ['FavDiff', this.filter === 'diff'], ['FavSame', this.filter === 'same'],
      ['InsigIgnored', this.ignoreInsig], ['ShowWS', this.showWS], ['ShowItemNum', this.showNums]]) {
      this.buttons[cmd].classList.toggle('on', on);
    }
    this.buttons.Undo.disabled = !this.undo.length;
    this.buttons.Redo.disabled = !this.redo.length;
    this.buttons.Save.disabled = !this.sides.left.dirty && !this.sides.right.dirty;
    this.scroller.refresh();
    this.drawThumb();
    this.app.updateTabs();
  }

  // ---- rendering ---------------------------------------------------------

  inline(row) {
    if (!row.inl) row.inl = TextDiff.inlineDiff(this.sides.left.lines[row.l], this.sides.right.lines[row.r], this.rules);
    return row.inl;
  }

  textHtml(text, runs) {
    const show = (s) => {
      let out = esc(s);
      if (this.showWS) out = out.replace(/ /g, '·').replace(/\t/g, '→\t');
      return out;
    };
    if (!runs || !runs.length) return show(text);
    let out = '', pos = 0;
    for (const [s, e, kind] of runs) {
      if (kind === 'insig' && this.ignoreInsig) continue;
      out += show(text.slice(pos, s)) + `<span class="c-${kind}">` + show(text.slice(s, e)) + '</span>';
      pos = e;
    }
    return out + show(text.slice(pos));
  }

  rowHtml(k, side) {
    const row = this.rows[this.vis[k]];
    const key = side === 'left' ? 'l' : 'r';
    const idx = row[key];
    const kind = this.kind(row);
    let cls = 'row';
    let text = '';
    if (idx < 0) {
      cls += ' gap';
    } else {
      const line = this.sides[side].lines[idx];
      if (row.l >= 0 && row.r >= 0 && row.type !== 'same') text = this.textHtml(line, this.inline(row)[side]);
      else text = this.textHtml(line);
      if (kind === 'diff') cls += row.l < 0 || row.r < 0 ? ' diff orphan' : ' diff';
      else if (kind === 'insig') cls += ' insig';
      if (row.manual) cls += ' manual';
      if (this.alignFrom && this.alignFrom.side === side && this.alignFrom.line === idx) cls += ' align-src';
    }
    const lo = Math.min(this.cur, this.anchor), hi = Math.max(this.cur, this.anchor);
    if (k >= lo && k <= hi && lo !== hi) cls += ' sel';
    if (k === this.cur) cls += side === this.side ? ' cur' : ' cur-other';
    let btn = '';
    if (kind !== 'same' && this.sections[row.sec][key] === this.vis[k]) {
      btn = `<span class="copy-btn" title="Copy section to ${side === 'left' ? 'right' : 'left'}">${side === 'left' ? '⇨' : '⇦'}</span>`;
    }
    const num = this.showNums ? `<span class="num">${idx >= 0 ? idx + 1 : ''}</span>` : '';
    return `<div class="${cls}" data-k="${k}">${num}<span class="gut">${btn}</span><span class="tx">${text}</span></div>`;
  }

  render(first, n, offset) {
    const width = Math.ceil((Math.max(this.sides.left.maxLen, this.sides.right.maxLen) + 4) * (this.charW || 8)) + 90;
    for (const side of ['left', 'right']) {
      let html = '';
      for (let k = first; k < first + n; k++) html += this.rowHtml(k, side);
      const el = this.rowsEl[side];
      el.innerHTML = html;
      el.style.transform = `translateY(${-offset}px)`;
      el.style.minWidth = width + 'px';
    }
    this.body.classList.toggle('aligning', !!this.alignFrom);
    this.renderDetails();
    this.drawThumbViewport();
  }

  renderDetails() {
    const row = this.rows[this.vis[this.cur]];
    const L = this.sides.left, R = this.sides.right;
    const line = (side, key) => {
      if (!row || row[key] < 0) return '<div class="det-line gap">&nbsp;</div>';
      const s = this.sides[side];
      const runs = row.l >= 0 && row.r >= 0 && row.type !== 'same' ? this.inline(row)[side] : null;
      const cls = this.kind(row) === 'diff' ? ' diff' : this.kind(row) === 'insig' ? ' insig' : '';
      return `<div class="det-line${cls}">${side === 'left' ? '⇦' : '⇨'} ${this.textHtml(s.lines[row[key]], runs) || '&nbsp;'}</div>`;
    };
    this.details.innerHTML = line('left', 'l') + line('right', 'r');

    const st = this.stats || { important: 0, insig: 0 };
    const secs = this.sections.filter((s) => s.important || !this.ignoreInsig).length;
    const info = (s) => `${s.encoding.toUpperCase()} ${s.eol === '\r\n' ? 'PC' : s.eol === '\r' ? 'Mac' : 'Unix'}${s.dirty ? ' • modified' : ''}`;
    const pos = row ? `${this.side === 'left' ? 'Left' : 'Right'} line ${row[this.side === 'left' ? 'l' : 'r'] + 1 || '—'}` : '';
    this.status.innerHTML = `<span class="st-main">${esc(this.message || `${secs} difference section(s)`)}</span>`
      + `<span>${row ? TV_TYPE_CAPTION[this.kind(row) === 'same' ? 'same' : row.type] : ''}</span>`
      + `<span>${st.important} important, ${st.insig} unimportant line(s)</span><span>${pos}</span>`
      + `<span>${esc(info(L))} | ${esc(info(R))}</span>`;
  }

  drawThumb() {
    const c = this.thumb;
    const hgt = this.body.clientHeight || 100;
    c.height = hgt;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, hgt);
    const total = this.vis.length || 1;
    const scale = hgt / Math.max(total, hgt / 2);
    for (let k = 0; k < this.vis.length; k++) {
      const kind = this.kind(this.rows[this.vis[k]]);
      if (kind === 'same') continue;
      ctx.fillStyle = kind === 'diff' ? '#e00000' : '#3a5fd9';
      ctx.fillRect(2, Math.floor(k * scale), c.width - 4, Math.max(1, Math.ceil(scale)));
    }
    this.thumbScale = scale;
    this.thumbImage = ctx.getImageData(0, 0, c.width, hgt);
    this.drawThumbViewport();
  }

  drawThumbViewport() {
    if (!this.thumbImage) return;
    const ctx = this.thumb.getContext('2d', { willReadFrequently: true });
    ctx.putImageData(this.thumbImage, 0, 0);
    ctx.strokeStyle = '#000000';
    const y = (this.scroller.first || 0) * this.thumbScale;
    ctx.strokeRect(0.5, Math.floor(y) + 0.5, this.thumb.width - 1, Math.max(3, Math.floor(this.body.clientHeight / TV_ROW * this.thumbScale)));
  }

  onThumb(e) {
    const k = Math.floor(e.offsetY / this.thumbScale);
    this.scroller.bar.scrollTop = Math.max(0, k * TV_ROW - this.body.clientHeight / 2);
  }

  // ---- cursor and selection ----------------------------------------------

  onMouse(e, side) {
    const rowEl = e.target.closest('.row');
    if (!rowEl) return;
    const k = Number(rowEl.dataset.k);
    this.side = side;
    this.cur = k;
    if (!e.shiftKey) this.anchor = k;
    if (this.alignFrom && e.button === 0) {
      this.alignPick();
      return;
    }
    if (e.target.classList.contains('copy-btn')) {
      this.anchor = k;
      this.copySection(side === 'left' ? 'right' : 'left');
      return;
    }
    this.scroller.refresh();
    // Redrawing on mousedown replaces the clicked element, so the browser
    // never fires dblclick; the click count on mousedown is reliable.
    if (e.detail === 2 && e.button === 0) {
      e.preventDefault();
      this.editLine();
    }
  }

  moveTo(k, extend, center) {
    if (!this.vis.length) return;
    this.cur = Math.max(0, Math.min(this.vis.length - 1, k));
    if (!extend) this.anchor = this.cur;
    this.scroller.ensureVisible(this.cur, center);
  }

  gotoSection(dir, quiet) {
    const counts = (row) => this.kind(row) !== 'same';
    const curRow = this.rows[this.vis[this.cur]];
    const curSec = curRow && counts(curRow) ? curRow.sec : -1;
    for (let k = this.cur + (quiet ? 0 : dir); k >= 0 && k < this.vis.length; k += dir) {
      const row = this.rows[this.vis[k]];
      if (!counts(row) || (!quiet && row.sec === curSec)) continue;
      // Land on the first counted row of that section.
      while (dir < 0 && k > 0 && this.rows[this.vis[k - 1]].sec === row.sec && counts(this.rows[this.vis[k - 1]])) k--;
      this.message = '';
      this.moveTo(k, false, true);
      return;
    }
    if (!quiet) {
      this.message = dir > 0 ? 'No more differences below' : 'No more differences above';
      this.scroller.refresh();
    }
  }

  // Row indices (into this.rows) the next action applies to: the selection,
  // else the whole difference section under the cursor, else the cursor row.
  targetRows(lineOnly) {
    if (!this.vis.length) return [];
    let a = this.vis[Math.min(this.cur, this.anchor)], b = this.vis[Math.max(this.cur, this.anchor)];
    if (a === b && !lineOnly) {
      const sec = this.rows[a].sec;
      if (sec >= 0) { a = this.sections[sec].start; b = this.sections[sec].end; }
    }
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }

  // ---- editing -----------------------------------------------------------

  pushUndo() {
    const L = this.sides.left, R = this.sides.right;
    this.undo.push({ l: L.lines.slice(), r: R.lines.slice(), dl: L.dirty, dr: R.dirty, al: this.aligns });
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
  }

  restore(from, to) {
    const snap = from.pop();
    if (!snap) return;
    const L = this.sides.left, R = this.sides.right;
    to.push({ l: L.lines, r: R.lines, dl: L.dirty, dr: R.dirty, al: this.aligns });
    L.lines = snap.l; R.lines = snap.r; L.dirty = snap.dl; R.dirty = snap.dr;
    this.aligns = snap.al;
    this.recompare();
  }

  insertionPoint(rowIdx, key, side) {
    for (let i = rowIdx; i < this.rows.length; i++) if (this.rows[i][key] >= 0) return this.rows[i][key];
    return this.sides[side].lines.length;
  }

  replaceLines(side, pos, count, lines) {
    const s = this.sides[side];
    s.lines = s.lines.slice(0, pos).concat(lines, s.lines.slice(pos + count));
    s.dirty = true;
    // Manual alignments follow their lines; one whose line was replaced is dropped.
    const at = side === 'left' ? 0 : 1, shift = lines.length - count;
    this.aligns = this.aligns.filter((p) => p[at] < pos || p[at] >= pos + count)
      .map((p) => (p[at] < pos ? p : at === 0 ? [p[0] + shift, p[1]] : [p[0], p[1] + shift]));
  }

  // F7: the first pick remembers the line under the cursor, the second pick,
  // on the other side, puts the two lines on one row and recompares the rest.
  alignPick() {
    const row = this.rows[this.vis[this.cur]];
    const side = this.side, line = row ? row[side === 'left' ? 'l' : 'r'] : -1;
    const from = this.alignFrom;
    if (line < 0) {
      this.message = 'Align: pick a row that has a line on this side';
    } else if (!from || from.side === side) {
      this.alignFrom = { side, line };
      this.message = `Align ${side} line ${line + 1}: click the matching line on the ${side === 'left' ? 'right' : 'left'} side, or move there and press F7 (Esc cancels)`;
    } else {
      const pair = side === 'left' ? [line, from.line] : [from.line, line];
      this.pushUndo();
      // Earlier alignments that the new one crosses give way to it.
      this.aligns = this.aligns.filter((p) => (p[0] - pair[0]) * (p[1] - pair[1]) > 0).concat([pair]);
      this.message = '';
      this.recompare(line);
      this.scroller.ensureVisible(this.cur, true);
      return;
    }
    this.scroller.refresh();
  }

  copySection(to, lineOnly) {
    const idxs = this.targetRows(lineOnly);
    if (!idxs.length) return;
    const from = to === 'left' ? 'right' : 'left';
    const fk = from === 'left' ? 'l' : 'r', tk = to === 'left' ? 'l' : 'r';
    const src = idxs.filter((i) => this.rows[i][fk] >= 0).map((i) => this.sides[from].lines[this.rows[i][fk]]);
    const tgt = idxs.map((i) => this.rows[i][tk]).filter((x) => x >= 0);
    const pos = tgt.length ? tgt[0] : this.insertionPoint(idxs[0], tk, to);
    this.pushUndo();
    this.replaceLines(to, pos, tgt.length, src);
    this.side = to;
    this.recompare(pos);
  }

  deleteLines() {
    const key = this.side === 'left' ? 'l' : 'r';
    const tgt = this.targetRows(true).map((i) => this.rows[i][key]).filter((x) => x >= 0);
    if (!tgt.length) return;
    this.pushUndo();
    this.replaceLines(this.side, tgt[0], tgt.length, []);
    this.recompare(tgt[0]);
  }

  editLine(insertAt) {
    const row = this.rows[this.vis[this.cur]];
    const side = this.side, key = side === 'left' ? 'l' : 'r';
    const idx = insertAt !== undefined ? -1 : row ? row[key] : -1;
    this.scroller.ensureVisible(this.cur);
    const top = this.cur * TV_ROW - this.scroller.bar.scrollTop;
    const input = h('input', { class: 'tv-edit', type: 'text', spellcheck: false, value: idx >= 0 ? this.sides[side].lines[idx] : '' });
    input.style.top = Math.max(0, top) + 'px';
    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      input.remove();
      if (!commit) return;
      this.pushUndo();
      const pos = idx >= 0 ? idx : insertAt !== undefined ? insertAt : this.insertionPoint(row ? this.vis[this.cur] : 0, key, side);
      this.replaceLines(side, pos, idx >= 0 ? 1 : 0, [input.value]);
      this.recompare(pos);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(input.value !== (idx >= 0 ? this.sides[side].lines[idx] : '')));
    const pane = this.panes[side];
    input.style.left = pane.offsetLeft + 'px';
    input.style.width = pane.clientWidth + 'px';
    this.body.append(input);
    input.focus();
  }

  insertAfter() {
    const row = this.rows[this.vis[this.cur]];
    const key = this.side === 'left' ? 'l' : 'r';
    const pos = !row ? 0 : row[key] >= 0 ? row[key] + 1 : this.insertionPoint(this.vis[this.cur], key, this.side);
    this.editLine(pos);
  }

  async find(dir, ask) {
    if (ask || !this.findText) {
      const t = await Modal.prompt('Find', 'Text to find:', this.findText);
      if (!t) return;
      this.findText = t;
    }
    const needle = this.findText.toLowerCase();
    const key = this.side === 'left' ? 'l' : 'r';
    const n = this.vis.length;
    for (let step = 1; step <= n; step++) {
      const k = ((this.cur + dir * step) % n + n) % n;
      const idx = this.rows[this.vis[k]][key];
      if (idx >= 0 && this.sides[this.side].lines[idx].toLowerCase().includes(needle)) {
        this.message = '';
        this.moveTo(k, false, true);
        return;
      }
    }
    this.message = `"${this.findText}" not found on the ${this.side} side`;
    this.scroller.refresh();
  }

  async goTo() {
    const v = await Modal.prompt('Go To', 'Line number:', '');
    const line = parseInt(v, 10);
    if (!line) return;
    const key = this.side === 'left' ? 'l' : 'r';
    const k = this.vis.findIndex((i) => this.rows[i][key] === line - 1);
    if (k < 0) this.message = `Line ${line} not found`;
    else this.message = '';
    if (k >= 0) this.moveTo(k, false, true); else this.scroller.refresh();
  }

  async editRules() {
    const v = await Modal.form('Session Settings — Importance', TV_RULE_FIELDS, this.rules);
    if (!v) return;
    this.rules = v;
    this.recompare();
  }

  swap() {
    const s = this.sides;
    [s.left, s.right] = [s.right, s.left];
    this.aligns = this.aligns.map(([l, r]) => [r, l]);
    this.pathBox.left.input.value = s.left.path;
    this.pathBox.right.input.value = s.right.path;
    this.undo = [];
    this.redo = [];
    this.recompare();
  }

  async reload() {
    const paths = [this.sides.left.path, this.sides.right.path];
    if ((this.sides.left.dirty || this.sides.right.dirty) && !(await Modal.confirm('Reload', 'Discard unsaved changes and reload both files?', 'Reload'))) return;
    this.sides.left.dirty = this.sides.right.dirty = false;
    await this.load('left', paths[0]);
    await this.load('right', paths[1]);
  }

  copyText() {
    const key = this.side === 'left' ? 'l' : 'r';
    const lines = this.targetRows(true).map((i) => this.rows[i][key]).filter((x) => x >= 0).map((x) => this.sides[this.side].lines[x]);
    if (lines.length) navigator.clipboard.writeText(lines.join('\n'));
  }

  command(c) {
    switch (c) {
      case 'FavCompareAll': this.filter = 'all'; this.refilter(); break;
      case 'FavDiff': this.filter = 'diff'; this.refilter(); break;
      case 'FavSame': this.filter = 'same'; this.refilter(); break;
      case 'InsigIgnored': this.ignoreInsig = !this.ignoreInsig; this.refilter(); break;
      case 'ShowWS': this.showWS = !this.showWS; this.afterChange(); break;
      case 'ShowItemNum': this.showNums = !this.showNums; this.afterChange(); break;
      case 'Rules': this.editRules(); break;
      case 'CopyRight': this.copySection('right'); break;
      case 'CopyLeft': this.copySection('left'); break;
      case 'CopyItemRight': this.copySection('right', true); break;
      case 'CopyItemLeft': this.copySection('left', true); break;
      case 'DiffNext': this.gotoSection(1); break;
      case 'DiffPrev': this.gotoSection(-1); break;
      case 'Undo': this.restore(this.undo, this.redo); break;
      case 'Redo': this.restore(this.redo, this.undo); break;
      case 'Save': this.save(); break;
      case 'SaveAs': this.saveSide(this.side, true).then(() => this.afterChange()); break;
      case 'Refresh': this.reload(); break;
      case 'Swap': this.swap(); break;
      case 'FullEdit': this.editLine(); break;
      case 'InsertItemAfter': this.insertAfter(); break;
      case 'Delete': this.deleteLines(); break;
      case 'SelectAll': this.anchor = 0; this.cur = Math.max(0, this.vis.length - 1); this.scroller.refresh(); break;
      case 'SelectSection': {
        const idxs = this.targetRows(false);
        if (idxs.length) { this.anchor = this.vis.indexOf(idxs[0]); this.cur = this.vis.indexOf(idxs[idxs.length - 1]); }
        if (this.anchor < 0 || this.cur < 0) this.anchor = this.cur = Math.max(this.anchor, this.cur, 0);
        this.scroller.refresh();
        break;
      }
      case 'Find': this.find(1, true); break;
      case 'FindNext': this.find(1); break;
      case 'FindPrev': this.find(-1); break;
      case 'GoTo': this.goTo(); break;
      case 'GoLeft': this.side = 'left'; this.scroller.refresh(); break;
      case 'GoRight': this.side = 'right'; this.scroller.refresh(); break;
      case 'GoNext': this.side = this.side === 'left' ? 'right' : 'left'; this.scroller.refresh(); break;
      case 'BrowseLeft': this.browse('left'); break;
      case 'BrowseRight': this.browse('right'); break;
      case 'Up': this.moveTo(this.cur - 1); break;
      case 'Down': this.moveTo(this.cur + 1); break;
      case 'SelUp': this.moveTo(this.cur - 1, true); break;
      case 'SelDown': this.moveTo(this.cur + 1, true); break;
      case 'PageUp': this.moveTo(this.cur - this.scroller.pageRows); break;
      case 'PageDown': this.moveTo(this.cur + this.scroller.pageRows); break;
      case 'Top': this.moveTo(0); break;
      case 'Bottom': this.moveTo(this.vis.length - 1); break;
      case 'CopyText': this.copyText(); break;
      case 'AlignWith': this.alignPick(); break;
      case 'AlignCancel':
        if (!this.alignFrom) return false;
        this.alignFrom = null;
        this.message = '';
        this.scroller.refresh();
        break;
      default: return false;
    }
    return true;
  }
}
