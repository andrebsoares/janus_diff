'use strict';
// Folder Compare view: both trees aligned row by row, colored by comparison
// result, with copy / delete / rename / synchronize operations.

const DV_ROW = 20;

const DV_KEYS = {
  'Ctrl+R': 'CopyRight', 'Ctrl+L': 'CopyLeft', Del: 'Delete', 'Shift+Del': 'PermanentDelete', F2: 'Rename',
  'Ctrl+A': 'SelectAll', F5: 'Refresh', 'Ctrl+F5': 'Refresh', 'Ctrl+N': 'DiffNext', 'Ctrl+P': 'DiffPrev',
  'Ctrl+F': 'Find', F3: 'FindNext', 'Shift+F3': 'FindPrev', 'Ctrl+Alt+L': 'Legend', Enter: 'Open', 'Ctrl+M': 'CompareContents', 'Ctrl+E': 'Exclude',
  Up: 'Up', Down: 'Down', 'Shift+Up': 'SelUp', 'Shift+Down': 'SelDown', PageUp: 'PageUp', PageDown: 'PageDown',
  'Shift+PageUp': 'SelPageUp', 'Shift+PageDown': 'SelPageDown', Home: 'Top', End: 'Bottom', 'Shift+Home': 'SelTop', 'Shift+End': 'SelBottom', Left: 'Collapse', Right: 'Expand', BkSp: 'UpOneLevel', 'Alt+Left': 'GoLeft', 'Alt+Right': 'GoRight',
};

const DV_CRITERIA_FIELDS = [
  { type: 'heading', label: 'Quick tests' },
  { key: 'compareSize', type: 'check', label: 'Compare file size' },
  { key: 'compareTimestamp', type: 'check', label: 'Compare timestamps' },
  { key: 'timestampTolerance', type: 'number', label: 'Second tolerance' },
  { key: 'filenameCase', type: 'check', label: 'Compare filename case' },
  { type: 'heading', label: 'Requires opening files' },
  { key: 'content', type: 'select', label: 'Compare contents', options: [['none', '(off)'], ['crc', 'CRC comparison'], ['binary', 'Binary comparison'], ['rules', 'Rules-based comparison']] },
  { key: 'skipContentIfQuickSame', type: 'check', label: 'Skip if quick tests indicate files are the same' },
  { key: 'contentOverridesQuick', type: 'check', label: 'Override quick test results' },
  { type: 'heading', label: 'Name filters' },
  { key: 'filters', type: 'text', label: 'Masks ( ; separates, - excludes, trailing / = folder )' },
];

const DV_LEGEND = [
  ['file same', 'Same file'], ['file orphan', 'Orphan file'], ['file newer', 'Newer file'], ['file older', 'Older file'], ['file newer', 'Difference files'],
  ['dir same', 'Only contains same files'], ['dir orphan', 'Contains orphan files'], ['dir newer', 'Contains newer/difference files'],
  ['dir older', 'Contains older files'], ['dir mixed', 'Contains newer/difference and orphan files'],
];

const DV_STATUS_TEXT = {
  same: 'Same', diff: 'Different', newerLeft: 'Left is newer', newerRight: 'Right is newer', orphanLeft: 'Left orphan', orphanRight: 'Right orphan',
};

class DirView {
  constructor(app, left, right) {
    this.app = app;
    this.type = 'dir';
    this.keymap = DV_KEYS;
    this.roots = { left: left || '', right: right || '' };
    this.criteria = { compareSize: true, compareTimestamp: true, timestampTolerance: 2, filenameCase: false, content: 'none', skipContentIfQuickSame: false, contentOverridesQuick: false, filters: '*' };
    this.tree = [];
    this.flat = [];
    this.expanded = new Set();
    this.selected = new Set();
    this.filter = 'all';
    this.cur = 0;
    this.anchor = 0;
    this.side = 'left';
    this.findText = '';
    this.message = '';
    this.build();
    this.refresh();
  }

  get title() {
    const name = (p) => (p ? api.path.basename(p) || p : 'New');
    return `${name(this.roots.left)} <--> ${name(this.roots.right)}`;
  }

  build() {
    const tb = buildToolbar([
      ['✱ All', 'FavCompareAll', 'Show all'], ['≠ Diffs', 'FavDiff', 'Show differences'], ['= Same', 'FavSame', 'Show same'], ['◇ Orphans', 'FavOrphan', 'Show orphans'],
      ['Rules', 'Rules', 'Session settings: comparison criteria and filters'], '|',
      ['⇨ Copy', 'CopyRight', 'Copy to right (Ctrl+R)'], ['⇦ Copy', 'CopyLeft', 'Copy to left (Ctrl+L)'], ['✕ Delete', 'Delete', 'Delete (Del)'], '|',
      ['≟ Contents', 'CompareContents', 'Compare the contents of the selected files (Ctrl+M)'], ['⊘ Exclude', 'Exclude', 'Exclude the selection from the comparison (Ctrl+E)'], '|',
      ['⊞ Expand', 'ExpandAll', 'Expand all folders'], ['⊟ Collapse', 'CollapseAll', 'Collapse all folders'], '|',
      ['↓ Next', 'DiffNext', 'Next difference (Ctrl+N)'], ['↑ Prev', 'DiffPrev', 'Previous difference (Ctrl+P)'], '|',
      ['⇄ Swap', 'Swap', 'Swap sides'], ['⟳ Refresh', 'Refresh', 'Refresh (F5)'], ['Sync ▾', 'SyncMenu', 'Synchronize'], ['Legend', 'Legend', 'Color legend'],
    ], (c) => this.command(c));
    this.buttons = tb.buttons;
    this.pathBox = {};
    for (const side of ['left', 'right']) {
      const up = h('button', { class: 'tb-btn', title: 'Up one level', tabIndex: -1, onclick: () => this.upOneLevel(side) }, '↰');
      this.pathBox[side] = buildPathBox(side === 'left' ? 'Left folder' : 'Right folder',
        (p) => { this.roots[side] = p; this.refresh(); }, () => this.browse(side), up);
      this.pathBox[side].input.value = this.roots[side];
    }
    const cols = () => [h('span', {}, 'Name'), h('span', { class: 'r' }, 'Size'), h('span', {}, 'Modified')];
    this.head = h('div', { class: 'dv-head dv-grid' }, cols(), h('span'), cols());
    this.rowsEl = h('div', { class: 'dv-rows' });
    this.viewport = h('div', { class: 'dv-viewport' }, this.rowsEl);
    this.viewport.addEventListener('mousedown', (e) => this.onMouse(e));
    const bar = h('div', { class: 'vscroll' });
    this.body = h('div', { class: 'dv-body' }, this.viewport, bar);
    this.scroller = new VScroller(this.viewport, bar, DV_ROW, (first, n, off) => this.render(first, n, off));
    this.status = h('div', { class: 'statusbar' });
    this.el = h('div', { class: 'view dirview' }, tb.bar,
      h('div', { class: 'pathbar dv-paths' }, this.pathBox.left.box, this.pathBox.right.box),
      this.head, this.body, this.status);
  }

  onShow() {
    this.scroller.refresh();
  }

  onClose() {
    return true;
  }

  session() {
    return { type: 'dir', left: this.roots.left, right: this.roots.right };
  }

  async browse(side) {
    const p = await api.pickFolder(this.roots[side] || this.roots[side === 'left' ? 'right' : 'left']);
    if (!p) return;
    this.roots[side] = p;
    this.refresh();
  }

  upOneLevel(side) {
    for (const s of side ? [side] : ['left', 'right']) {
      if (this.roots[s]) this.roots[s] = api.path.dirname(this.roots[s]);
    }
    this.refresh();
  }

  // ---- scanning ----------------------------------------------------------

  async refresh() {
    for (const side of ['left', 'right']) this.pathBox[side].input.value = this.roots[side];
    this.app.updateTabs();
    if (!this.roots.left && !this.roots.right) { this.setTree([]); return; }
    const token = this.scanToken = (this.scanToken || 0) + 1;
    this.message = 'Scanning folders…';
    this.renderStatus();
    try {
      for (const side of ['left', 'right']) {
        if (!this.roots[side]) continue;
        const st = await api.stat(this.roots[side]);
        if (!st.exists || !st.isDir) throw new Error(`${this.roots[side]} is not a folder`);
      }
      const res = await api.compareFolders(this.roots.left, this.roots.right, this.criteria);
      if (token !== this.scanToken) return;
      this.message = '';
      this.setTree(res.children);
      if (this.roots.left && this.roots.right) api.rememberSession(this.session());
    } catch (err) {
      if (token !== this.scanToken) return;
      this.message = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      this.setTree([]);
    }
  }

  onProgress(p) {
    if (!this.message.startsWith('Scanning') && !this.message.startsWith('Comparing')) return;
    this.message = p.toCompare ? `Comparing contents… ${p.compared}/${p.toCompare}` : `Scanning folders… ${p.scanned} files`;
    this.renderStatus();
  }

  setTree(tree) {
    this.tree = tree;
    this.selected.clear();
    this.counts = { same: 0, diff: 0, orphanLeft: 0, orphanRight: 0 };
    const count = (nodes) => nodes.forEach((n) => {
      if (n.isDir) { count(n.children); return; }
      const k = n.status.startsWith('newer') ? 'diff' : n.status;
      this.counts[k]++;
    });
    count(tree);
    this.reflow();
  }

  matches(node) {
    switch (this.filter) {
      case 'diff': return node.status !== 'same';
      case 'same': return node.status === 'same';
      case 'orphan': return node.status === 'orphanLeft' || node.status === 'orphanRight';
      default: return true;
    }
  }

  // Rebuilds the flat list of visible rows from the tree, filter and expanded set.
  reflow() {
    const curRel = this.flat[this.cur] && this.flat[this.cur].node.rel;
    const flat = [];
    const visit = (nodes, depth) => {
      let any = false;
      for (const node of nodes) {
        if (!node.isDir) {
          if (this.matches(node)) { flat.push({ node, depth }); any = true; }
          continue;
        }
        const at = flat.length;
        flat.push({ node, depth });
        const open = this.expanded.has(node.rel);
        const mark = flat.length;
        const childAny = visit(node.children, depth + 1);
        if (!open) flat.length = mark;
        const empty = !node.children.length;
        if (childAny || (empty && this.matches(node)) || this.filter === 'all') any = true;
        else flat.length = at;
      }
      return any;
    };
    visit(this.tree, 0);
    this.flat = flat;
    let cur = curRel === undefined ? 0 : flat.findIndex((f) => f.node.rel === curRel);
    if (cur < 0) cur = Math.min(this.cur, Math.max(0, flat.length - 1));
    this.cur = this.anchor = cur;
    for (const [cmd, f] of [['FavCompareAll', 'all'], ['FavDiff', 'diff'], ['FavSame', 'same'], ['FavOrphan', 'orphan']]) this.buttons[cmd].classList.toggle('on', this.filter === f);
    this.scroller.setCount(flat.length);
  }

  // ---- rendering ---------------------------------------------------------

  sideClass(node, side) {
    const L = side === 'left';
    if (!node.isDir) {
      switch (node.status) {
        case 'same': return 'same';
        case 'diff': return 'newer';
        case 'newerLeft': return L ? 'newer' : 'older';
        case 'newerRight': return L ? 'older' : 'newer';
        default: return 'orphan';
      }
    }
    const f = node.flags || {};
    const diff = f.diff || (L ? f.newerL : f.newerR);
    const orphan = L ? f.orphanL : f.orphanR;
    const older = L ? f.newerR : f.newerL;
    if (diff && orphan) return 'mixed';
    if (diff) return 'newer';
    if (orphan) return 'orphan';
    if (older) return 'older';
    return 'same';
  }

  cellsHtml(node, depth, side) {
    const info = node[side];
    if (!info) return '<span class="nm"></span><span></span><span></span>';
    const cls = this.sideClass(node, side);
    const tw = node.isDir ? `<span class="tw">${this.expanded.has(node.rel) ? '▾' : '▸'}</span>` : '<span class="tw none"></span>';
    const icon = `<span class="ico ${node.isDir ? 'dir' : 'file'} ${cls}"></span>`;
    return `<span class="nm ${cls}" style="padding-left:${depth * 16 + 2}px">${tw}${icon}${esc(info.name)}</span>`
      + `<span class="r ${cls}">${node.isDir ? '' : fmtSize(info.size)}</span><span class="${cls}">${fmtDate(info.mtime)}</span>`;
  }

  render(first, n, offset) {
    let html = '';
    for (let k = first; k < first + n; k++) {
      const { node, depth } = this.flat[k];
      const center = node.isDir ? '' : node.status === 'same' ? '=' : node.left && node.right ? '≠' : '';
      const cls = 'dv-row dv-grid' + (this.selected.has(node.rel) ? ' sel' : '') + (k === this.cur ? ' cur cur-' + this.side : '');
      html += `<div class="${cls}" data-k="${k}">${this.cellsHtml(node, depth, 'left')}`
        + `<span class="mid ${node.status === 'same' ? '' : 'ne'}">${center}</span>${this.cellsHtml(node, depth, 'right')}</div>`;
    }
    this.rowsEl.innerHTML = html;
    this.rowsEl.style.transform = `translateY(${-offset}px)`;
    this.renderStatus();
  }

  renderStatus() {
    const c = this.counts || { same: 0, diff: 0, orphanLeft: 0, orphanRight: 0 };
    const cur = this.flat[this.cur];
    this.status.innerHTML = `<span class="st-main">${esc(this.message || (cur ? `${cur.node.rel} — ${DV_STATUS_TEXT[cur.node.status]}` : 'Enter two folders to compare'))}</span>`
      + `<span>${c.diff} different</span><span>${c.orphanLeft} left orphan(s)</span><span>${c.orphanRight} right orphan(s)</span><span>${c.same} same</span>`
      + `<span>${this.selected.size} selected</span>`;
  }

  // ---- selection ---------------------------------------------------------

  onMouse(e) {
    const rowEl = e.target.closest('.dv-row');
    if (!rowEl) return;
    const k = Number(rowEl.dataset.k);
    const node = this.flat[k].node;
    const rect = rowEl.getBoundingClientRect();
    this.side = e.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
    if (e.target.classList.contains('tw') && node.isDir) {
      this.toggle(node);
      return;
    }
    if (e.shiftKey) {
      this.cur = k;
      this.selectRange();
    } else if (e.ctrlKey) {
      this.cur = this.anchor = k;
      if (this.selected.has(node.rel)) this.selected.delete(node.rel); else this.selected.add(node.rel);
    } else {
      this.cur = this.anchor = k;
      this.selected = new Set([node.rel]);
    }
    this.scroller.refresh();
    if (e.button !== 0) return;
    // Redrawing on mousedown replaces the clicked element, so the browser
    // never fires dblclick; the click count on mousedown is reliable.
    if (e.detail === 2) {
      this.open();
      return;
    }
    // Dragging with the button held selects the rows from the anchor on.
    if (e.ctrlKey) return;
    dragRows(this.viewport, this.scroller, ({ row }) => {
      if (row === this.cur) return;
      this.cur = row;
      this.selectRange();
      this.scroller.refresh();
    });
  }

  selectRange() {
    this.selected.clear();
    for (let k = Math.min(this.cur, this.anchor); k <= Math.max(this.cur, this.anchor); k++) this.selected.add(this.flat[k].node.rel);
  }

  moveTo(k, extend, center) {
    if (!this.flat.length) return;
    this.cur = Math.max(0, Math.min(this.flat.length - 1, k));
    if (extend) this.selectRange();
    else { this.anchor = this.cur; this.selected = new Set([this.flat[this.cur].node.rel]); }
    this.scroller.ensureVisible(this.cur, center);
  }

  toggle(node, open) {
    const want = open === undefined ? !this.expanded.has(node.rel) : open;
    if (want) this.expanded.add(node.rel); else this.expanded.delete(node.rel);
    this.reflow();
  }

  expandAll(open) {
    this.expanded.clear();
    const visit = (nodes) => nodes.forEach((n) => { if (n.isDir) { this.expanded.add(n.rel); visit(n.children); } });
    if (open) visit(this.tree);
    this.reflow();
  }

  // Selected nodes without those already covered by a selected ancestor.
  selection() {
    const out = [];
    const visit = (nodes) => nodes.forEach((n) => {
      if (this.selected.has(n.rel)) out.push(n);
      else if (n.isDir) visit(n.children);
    });
    visit(this.tree);
    return out;
  }

  pathOf(node, side) {
    return api.path.join(this.roots[side], ...(side === 'left' ? node.lrel : node.rrel));
  }

  // ---- operations --------------------------------------------------------

  async report(title, res) {
    if (res.errors.length) await Modal.message(title, `${res.done} done, ${res.errors.length} failed:\n\n${res.errors.slice(0, 12).join('\n')}`);
    await this.refresh();
  }

  async copy(to) {
    const from = to === 'left' ? 'right' : 'left';
    if (!this.roots[to]) return;
    const items = this.selection().filter((n) => n[from]).map((n) => ({ from: this.pathOf(n, from), to: this.pathOf(n, to) }));
    if (!items.length) return;
    const overwrite = this.selection().filter((n) => n[from] && n[to] && !n.isDir).length;
    const text = `Copy ${items.length} item(s) to the ${to} side?` + (overwrite ? `\n${overwrite} existing file(s) will be replaced.` : '');
    if (!(await Modal.confirm('Copy', text, 'Copy'))) return;
    await this.report('Copy', await api.copy(items));
  }

  async remove(permanent) {
    const items = this.selection().filter((n) => n[this.side]).map((n) => ({ path: this.pathOf(n, this.side) }));
    if (!items.length) return;
    const text = `Delete ${items.length} item(s) from the ${this.side} side?\n` + (permanent ? 'They will be permanently deleted.' : 'They will be moved to the recycle bin.');
    if (!(await Modal.confirm('Delete', text, 'Delete'))) return;
    await this.report('Delete', await this.deleteItems(items, !!permanent));
  }

  // Deletes items; those the recycle bin refuses (no trash on the volume or
  // the desktop) can be deleted permanently after an explicit confirmation.
  async deleteItems(items, permanent) {
    const res = await api.remove(items, permanent);
    if (permanent || !res.failed.length) return res;
    const text = `${res.failed.length} item(s) could not be moved to the recycle bin:\n\n${res.errors.slice(0, 12).join('\n')}`
      + `${res.errors.length > 12 ? '\n…' : ''}\n\nDelete them permanently instead? This cannot be undone.`;
    const ok = await Modal.show('Recycle Bin Unavailable', h('div', { class: 'dlg-text' }, text), [['Delete Permanently', true], ['Cancel', null, true]]);
    if (!ok) return res;
    const again = await api.remove(res.failed, true);
    return { done: res.done + again.done, errors: again.errors, failed: again.failed };
  }

  async rename() {
    const cur = this.flat[this.cur];
    if (!cur || !cur.node[this.side]) return;
    const name = await Modal.prompt('Rename', `New name (${this.side} side):`, cur.node[this.side].name);
    if (!name || name === cur.node[this.side].name) return;
    try {
      await api.rename(this.pathOf(cur.node, this.side), name);
    } catch (err) {
      await Modal.message('Rename', err.message);
    }
    this.refresh();
  }

  async newFolder() {
    if (!this.roots[this.side]) return;
    const name = await Modal.prompt('New Folder', `Folder name (${this.side} side):`, 'New Folder');
    if (!name) return;
    const cur = this.flat[this.cur];
    const rels = cur ? (this.side === 'left' ? cur.node.lrel : cur.node.rrel) : [];
    const parent = cur && cur.node.isDir && this.expanded.has(cur.node.rel) ? rels : rels.slice(0, -1);
    await api.mkdir(api.path.join(this.roots[this.side], ...parent, name));
    this.refresh();
  }

  // Builds the copy / delete plan for a synchronize command.
  syncPlan(mode) {
    const copies = [], deletes = [];
    const copy = (n, to) => copies.push({ from: this.pathOf(n, to === 'left' ? 'right' : 'left'), to: this.pathOf(n, to) });
    const visit = (nodes) => nodes.forEach((n) => {
      const s = n.status;
      if (n.isDir && n.left && n.right) { visit(n.children); return; }
      if (s === 'same') return;
      if (mode === 'UpdateRight' || mode === 'UpdateBoth') { if (s === 'newerLeft' || s === 'orphanLeft') copy(n, 'right'); }
      if (mode === 'UpdateLeft' || mode === 'UpdateBoth') { if (s === 'newerRight' || s === 'orphanRight') copy(n, 'left'); }
      if (mode === 'MirrorRight') { if (n.left) copy(n, 'right'); else deletes.push({ path: this.pathOf(n, 'right') }); }
      if (mode === 'MirrorLeft') { if (n.right) copy(n, 'left'); else deletes.push({ path: this.pathOf(n, 'left') }); }
    });
    visit(this.tree);
    return { copies, deletes };
  }

  async sync(mode) {
    if (!this.roots.left || !this.roots.right) return;
    const { copies, deletes } = this.syncPlan(mode);
    const label = mode.replace(/([a-z])([A-Z])/, '$1 $2');
    if (!copies.length && !deletes.length) { await Modal.message(label, 'Nothing to do — the folders are already synchronized.'); return; }
    const text = `${label}:\n\n${copies.length} item(s) will be copied` + (deletes.length ? `\n${deletes.length} item(s) will be deleted (recycle bin)` : '') + '\n\nContinue?';
    if (!(await Modal.confirm('Synchronize', text, 'Start'))) return;
    const res = await api.copy(copies);
    const del = deletes.length ? await this.deleteItems(deletes, false) : { done: 0, errors: [] };
    await this.report('Synchronize', { done: res.done + del.done, errors: res.errors.concat(del.errors) });
  }

  async syncMenu() {
    const mode = await Modal.show('Synchronize', h('div', { class: 'dlg-text' },
      'Update copies newer and orphan files.\nMirror makes the target identical to the source, deleting its orphans.'),
    [['Update Right', 'UpdateRight', true], ['Update Left', 'UpdateLeft'], ['Update Both', 'UpdateBoth'], ['Mirror to Right', 'MirrorRight'], ['Mirror to Left', 'MirrorLeft'], ['Cancel', null]]);
    if (mode) this.sync(mode);
  }

  open() {
    const cur = this.flat[this.cur];
    if (!cur) return;
    const node = cur.node;
    if (node.isDir) { this.toggle(node); return; }
    this.app.openFiles(node.left ? this.pathOf(node, 'left') : '', node.right ? this.pathOf(node, 'right') : '');
  }

  gotoDiff(dir) {
    // Going down from a collapsed folder with differences enters it first,
    // or the walk below would step over its contents.
    const here = this.flat[this.cur];
    if (dir > 0 && here && here.node.isDir && here.node.status !== 'same' && here.node.children.length && !this.expanded.has(here.node.rel)) {
      this.expanded.add(here.node.rel);
      this.reflow();
    }
    for (let k = this.cur + dir; k >= 0 && k < this.flat.length; k += dir) {
      const node = this.flat[k].node;
      if (node.status === 'same') continue;
      if (node.isDir && node.children.length) {
        // Differences live inside: open the folder and keep walking.
        if (!this.expanded.has(node.rel)) {
          this.expanded.add(node.rel);
          this.reflow();
          k = this.flat.findIndex((f) => f.node === node);
          if (dir < 0) k += this.countVisibleDescendants(k) + 1;
        }
        continue;
      }
      this.message = '';
      this.moveTo(k, false, true);
      return;
    }
    this.message = dir > 0 ? 'No more differences below' : 'No more differences above';
    this.renderStatus();
  }

  countVisibleDescendants(k) {
    const depth = this.flat[k].depth;
    let n = 0;
    while (k + n + 1 < this.flat.length && this.flat[k + n + 1].depth > depth) n++;
    return n;
  }

  async find(dir, ask) {
    if (ask || !this.findText) {
      const t = await Modal.prompt('Find Filename', 'Name contains:', this.findText);
      if (!t) return;
      this.findText = t;
    }
    const needle = this.findText.toLowerCase();
    const n = this.flat.length;
    for (let step = 1; step <= n; step++) {
      const k = ((this.cur + dir * step) % n + n) % n;
      if (this.flat[k].node.name.toLowerCase().includes(needle)) { this.message = ''; this.moveTo(k, false, true); return; }
    }
    this.message = `"${this.findText}" not found in the visible rows`;
    this.renderStatus();
  }

  // Settles quick-test results (e.g. only the timestamps differ) for the
  // selection by comparing contents; lasts until the next refresh.
  async compareContents() {
    const nodes = this.selection().filter((n) => n.left && n.right);
    if (!nodes.length) {
      this.message = 'Compare Contents: select files or folders present on both sides';
      this.renderStatus();
      return;
    }
    const content = await Modal.show('Compare Contents', h('div', { class: 'dlg-text' },
      `Compare the contents of the ${nodes.length} selected item(s)?\nThe result overrides the size and timestamp tests until the next refresh.`),
    [['Rules-based', 'rules', true], ['Binary', 'binary'], ['CRC', 'crc'], ['Cancel', null]]);
    if (!content) return;
    const token = this.scanToken = (this.scanToken || 0) + 1;
    this.message = 'Comparing contents…';
    this.renderStatus();
    try {
      const res = await api.recheckContents(this.tree, this.roots.left, this.roots.right, nodes.map((n) => n.rel), Object.assign({}, this.criteria, { content }));
      if (token !== this.scanToken) return;
      const selected = new Set(this.selected);
      this.setTree(res.children);
      this.selected = selected;
      this.message = `Compared ${res.compared} file(s): ${res.same} same, ${res.compared - res.same} different`;
    } catch (err) {
      if (token !== this.scanToken) return;
      this.message = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
    this.scroller.refresh();
  }

  // Adds a mask per selected item ("-/rel/path", anchored at the top) to
  // the session's name filters, where Rules can edit or remove it.
  exclude() {
    const nodes = this.selection();
    if (!nodes.length) return;
    const masks = nodes.map((n) => '-/' + n.rel.replace(/[*?;]/g, '?') + (n.isDir ? '/' : ''));
    this.criteria = Object.assign({}, this.criteria, { filters: [this.criteria.filters || '*', ...masks].join(';') });
    this.refresh();
  }

  async editCriteria() {
    const v = await Modal.form('Session Settings — Comparison', DV_CRITERIA_FIELDS, this.criteria);
    if (!v) return;
    this.criteria = v;
    this.refresh();
  }

  legend() {
    const rows = DV_LEGEND.map(([cls, text]) => {
      const [kind, color] = cls.split(' ');
      return h('div', { class: 'legend-row' }, h('span', { class: `ico ${kind} ${color}` }), h('span', { class: color }, text));
    });
    Modal.show('Legend', h('div', { class: 'legend' }, rows), [['Close', true, true]]);
  }

  command(c) {
    const cur = this.flat[this.cur];
    switch (c) {
      case 'FavCompareAll': this.filter = 'all'; this.reflow(); break;
      case 'FavDiff': this.filter = 'diff'; this.reflow(); break;
      case 'FavSame': this.filter = 'same'; this.reflow(); break;
      case 'FavOrphan': this.filter = 'orphan'; this.reflow(); break;
      case 'Rules': this.editCriteria(); break;
      case 'CopyRight': this.copy('right'); break;
      case 'CopyLeft': this.copy('left'); break;
      case 'Delete': this.remove(false); break;
      case 'PermanentDelete': this.remove(true); break;
      case 'Rename': this.rename(); break;
      case 'NewFolder': this.newFolder(); break;
      case 'CompareContents': this.compareContents(); break;
      case 'Exclude': this.exclude(); break;
      case 'ExpandAll': this.expandAll(true); break;
      case 'CollapseAll': this.expandAll(false); break;
      case 'DiffNext': this.gotoDiff(1); break;
      case 'DiffPrev': this.gotoDiff(-1); break;
      case 'Swap': [this.roots.left, this.roots.right] = [this.roots.right, this.roots.left]; this.refresh(); break;
      case 'Refresh': this.refresh(); break;
      case 'SyncMenu': this.syncMenu(); break;
      case 'UpdateRight': case 'UpdateLeft': case 'UpdateBoth': case 'MirrorRight': case 'MirrorLeft': this.sync(c); break;
      case 'Legend': this.legend(); break;
      case 'Open': this.open(); break;
      case 'Find': this.find(1, true); break;
      case 'FindNext': this.find(1); break;
      case 'FindPrev': this.find(-1); break;
      case 'BrowseLeft': this.browse('left'); break;
      case 'BrowseRight': this.browse('right'); break;
      case 'UpOneLevel': this.upOneLevel(); break;
      case 'GoLeft': this.side = 'left'; this.scroller.refresh(); break;
      case 'GoRight': this.side = 'right'; this.scroller.refresh(); break;
      case 'SelectAll': this.selected = new Set(this.flat.map((f) => f.node.rel)); this.scroller.refresh(); break;
      case 'Up': this.moveTo(this.cur - 1); break;
      case 'Down': this.moveTo(this.cur + 1); break;
      case 'SelUp': this.moveTo(this.cur - 1, true); break;
      case 'SelDown': this.moveTo(this.cur + 1, true); break;
      case 'PageUp': this.moveTo(this.cur - this.scroller.pageRows); break;
      case 'PageDown': this.moveTo(this.cur + this.scroller.pageRows); break;
      case 'SelPageUp': this.moveTo(this.cur - this.scroller.pageRows, true); break;
      case 'SelPageDown': this.moveTo(this.cur + this.scroller.pageRows, true); break;
      case 'Top': this.moveTo(0); break;
      case 'Bottom': this.moveTo(this.flat.length - 1); break;
      case 'SelTop': this.moveTo(0, true); break;
      case 'SelBottom': this.moveTo(this.flat.length - 1, true); break;
      case 'Expand': if (cur && cur.node.isDir) this.toggle(cur.node, true); break;
      case 'Collapse': if (cur && cur.node.isDir) this.toggle(cur.node, false); break;
      default: return false;
    }
    return true;
  }
}
