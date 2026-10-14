'use strict';
// Hex Compare view: byte-by-byte (unaligned) comparison of two files.

const HV_ROW = 18;
const HV_COLS = 16;

const HV_KEYS = {
  F5: 'Refresh', 'Ctrl+N': 'DiffNext', 'Ctrl+P': 'DiffPrev', Up: 'Up', Down: 'Down',
  PageUp: 'PageUp', PageDown: 'PageDown', 'Ctrl+Home': 'Top', 'Ctrl+End': 'Bottom', 'Ctrl+G': 'GoTo',
};

class HexView {
  constructor(app, left, right) {
    this.app = app;
    this.type = 'hex';
    this.keymap = HV_KEYS;
    this.sides = { left: { path: '', data: new Uint8Array(0) }, right: { path: '', data: new Uint8Array(0) } };
    this.filter = 'all';
    this.vis = [];
    this.cur = 0;
    this.message = '';
    this.build();
    this.load('left', left).then(() => this.load('right', right));
  }

  get title() {
    const name = (s) => (s.path ? api.path.basename(s.path) : 'New');
    return `${name(this.sides.left)} <--> ${name(this.sides.right)} (hex)`;
  }

  build() {
    const tb = buildToolbar([
      ['✱ All', 'FavCompareAll', 'Show all rows'], ['≠ Diffs', 'FavDiff', 'Show only rows with differences'], ['= Same', 'FavSame', 'Show only matching rows'], '|',
      ['↓ Next', 'DiffNext', 'Next difference (Ctrl+N)'], ['↑ Prev', 'DiffPrev', 'Previous difference (Ctrl+P)'], '|',
      ['⇄ Swap', 'Swap', 'Swap sides'], ['⟳ Reload', 'Refresh', 'Reload files (F5)'],
    ], (c) => this.command(c));
    this.buttons = tb.buttons;
    this.pathBox = {};
    this.rowsEl = {};
    const panes = {};
    for (const side of ['left', 'right']) {
      this.pathBox[side] = buildPathBox(side === 'left' ? 'Left file' : 'Right file', (p) => this.load(side, p), () => this.browse(side));
      this.rowsEl[side] = h('div', { class: 'tv-rows' });
      panes[side] = h('div', { class: 'tv-pane hex' }, this.rowsEl[side]);
      panes[side].addEventListener('mousedown', (e) => {
        const rowEl = e.target.closest('.row');
        if (rowEl) { this.cur = Number(rowEl.dataset.k); this.scroller.refresh(); }
      });
      panes[side].addEventListener('dragover', (e) => e.preventDefault());
      panes[side].addEventListener('drop', (e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) this.load(side, api.pathForFile(f));
      });
    }
    const bar = h('div', { class: 'vscroll' });
    this.body = h('div', { class: 'tv-body' }, h('span'), panes.left, panes.right, bar);
    this.scroller = new VScroller(this.body, bar, HV_ROW, (first, n, off) => this.render(first, n, off));
    this.status = h('div', { class: 'statusbar' });
    this.el = h('div', { class: 'view textview' }, tb.bar,
      h('div', { class: 'pathbar tv-grid' }, h('span'), this.pathBox.left.box, this.pathBox.right.box, h('span')),
      this.body, this.status);
  }

  onShow() {
    this.scroller.refresh();
  }

  onClose() {
    return true;
  }

  session() {
    return { type: 'hex', left: this.sides.left.path, right: this.sides.right.path };
  }

  async browse(side) {
    const p = await api.pickFile(this.sides[side].path);
    if (p) this.load(side, p);
  }

  async load(side, p) {
    const s = this.sides[side];
    s.path = p || '';
    s.data = new Uint8Array(0);
    this.pathBox[side].input.value = s.path;
    this.message = '';
    if (p) {
      try {
        s.data = await api.readBinary(p);
      } catch (err) {
        this.message = `${p}: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
      }
    }
    this.recompare();
    if (this.sides.left.path && this.sides.right.path) api.rememberSession(this.session());
    this.app.updateTabs();
  }

  recompare() {
    const a = this.sides.left.data, b = this.sides.right.data;
    const total = Math.ceil(Math.max(a.length, b.length) / HV_COLS);
    this.rowDiff = new Uint8Array(total);
    let diffBytes = 0;
    const max = Math.max(a.length, b.length), min = Math.min(a.length, b.length);
    for (let i = 0; i < max; i++) {
      if (i >= min || a[i] !== b[i]) { this.rowDiff[(i / HV_COLS) | 0] = 1; diffBytes++; }
    }
    this.diffBytes = diffBytes;
    this.refilter();
  }

  refilter() {
    this.vis = [];
    for (let r = 0; r < this.rowDiff.length; r++) {
      if (this.filter === 'all' || (this.filter === 'diff') === !!this.rowDiff[r]) this.vis.push(r);
    }
    this.cur = Math.min(this.cur, Math.max(0, this.vis.length - 1));
    for (const [cmd, f] of [['FavCompareAll', 'all'], ['FavDiff', 'diff'], ['FavSame', 'same']]) this.buttons[cmd].classList.toggle('on', this.filter === f);
    this.scroller.setCount(this.vis.length);
  }

  rowHtml(k, side) {
    const r = this.vis[k];
    const data = this.sides[side].data, other = this.sides[side === 'left' ? 'right' : 'left'].data;
    const base = r * HV_COLS;
    let hex = '', ascii = '';
    for (let c = 0; c < HV_COLS; c++) {
      const i = base + c;
      if (i >= data.length) { hex += '   '; ascii += ' '; continue; }
      const v = data[i];
      const diff = i >= other.length || other[i] !== v;
      const hx = v.toString(16).toUpperCase().padStart(2, '0');
      const ch = v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '.';
      hex += (diff ? `<span class="c-sig">${hx}</span>` : hx) + ' ';
      ascii += diff ? `<span class="c-sig">${ch}</span>` : ch;
    }
    const cls = 'row' + (this.rowDiff[r] ? ' diff' : '') + (k === this.cur ? ' cur' : '') + (base >= data.length ? ' gap' : '');
    return `<div class="${cls}" data-k="${k}"><span class="num hexnum">${base.toString(16).toUpperCase().padStart(8, '0')}</span><span class="tx">${hex} ${ascii}</span></div>`;
  }

  render(first, n, offset) {
    for (const side of ['left', 'right']) {
      let html = '';
      for (let k = first; k < first + n; k++) html += this.rowHtml(k, side);
      this.rowsEl[side].innerHTML = html;
      this.rowsEl[side].style.transform = `translateY(${-offset}px)`;
    }
    const L = this.sides.left.data.length, R = this.sides.right.data.length;
    this.status.innerHTML = `<span class="st-main">${esc(this.message || (this.diffBytes ? `${fmtSize(this.diffBytes)} different byte(s)` : L || R ? 'Binary same' : ''))}</span>`
      + `<span>${fmtSize(L)} bytes | ${fmtSize(R)} bytes</span>`;
  }

  moveTo(k) {
    if (!this.vis.length) return;
    this.cur = Math.max(0, Math.min(this.vis.length - 1, k));
    this.scroller.ensureVisible(this.cur, true);
  }

  gotoDiff(dir) {
    let k = this.cur;
    // Leave the current run of differing rows first, then find the next one.
    while (k >= 0 && k < this.vis.length && this.rowDiff[this.vis[k]] && this.vis[k] - this.vis[this.cur] === k - this.cur) k += dir;
    while (k >= 0 && k < this.vis.length && !this.rowDiff[this.vis[k]]) k += dir;
    if (k >= 0 && k < this.vis.length) { this.message = ''; this.moveTo(k); return; }
    this.message = dir > 0 ? 'No more differences below' : 'No more differences above';
    this.scroller.refresh();
  }

  async goTo() {
    const v = await Modal.prompt('Go To', 'Offset (hex):', '');
    const off = parseInt(v, 16);
    if (Number.isNaN(off)) return;
    const k = this.vis.indexOf(Math.floor(off / HV_COLS));
    if (k >= 0) this.moveTo(k);
  }

  command(c) {
    switch (c) {
      case 'FavCompareAll': this.filter = 'all'; this.refilter(); break;
      case 'FavDiff': this.filter = 'diff'; this.refilter(); break;
      case 'FavSame': this.filter = 'same'; this.refilter(); break;
      case 'DiffNext': this.gotoDiff(1); break;
      case 'DiffPrev': this.gotoDiff(-1); break;
      case 'Swap': {
        const s = this.sides;
        [s.left, s.right] = [s.right, s.left];
        this.pathBox.left.input.value = s.left.path;
        this.pathBox.right.input.value = s.right.path;
        this.recompare();
        this.app.updateTabs();
        break;
      }
      case 'Refresh': this.load('left', this.sides.left.path).then(() => this.load('right', this.sides.right.path)); break;
      case 'BrowseLeft': this.browse('left'); break;
      case 'BrowseRight': this.browse('right'); break;
      case 'GoTo': this.goTo(); break;
      case 'Up': this.moveTo(this.cur - 1); break;
      case 'Down': this.moveTo(this.cur + 1); break;
      case 'PageUp': this.moveTo(this.cur - this.scroller.pageRows); break;
      case 'PageDown': this.moveTo(this.cur + this.scroller.pageRows); break;
      case 'Top': this.moveTo(0); break;
      case 'Bottom': this.moveTo(this.vis.length - 1); break;
      default: return false;
    }
    return true;
  }
}
