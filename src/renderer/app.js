'use strict';
// Application shell: tab strip, home view, keyboard and menu command routing.

const APP_KEYS = {
  'Ctrl+T': 'TabNew', 'Ctrl+W': 'CloseTab', 'Ctrl+F4': 'CloseTab', 'Ctrl+Tab': 'TabNext', 'Ctrl+Shift+Tab': 'TabPrev', F1: 'Shortcuts',
};

const SHORTCUT_HELP = [
  ['All views', [['Ctrl+T', 'New tab'], ['Ctrl+W', 'Close tab'], ['Ctrl+Tab', 'Next tab'], ['F5', 'Refresh / reload'], ['Ctrl+N / Ctrl+P', 'Next / previous difference'], ['Ctrl+R / Ctrl+L', 'Copy to right / left']]],
  ['Text Compare', [['Ctrl+Shift+R / L', 'Copy line to right / left'], ['F2', 'Edit line'], ['F7', 'Align line with a line on the other side'], ['Ctrl+Enter', 'Insert line after'], ['Del', 'Delete line(s)'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S, F12', 'Save, Save As'], ['Ctrl+F, F3', 'Find, find next'], ['Ctrl+G', 'Go to line'], ['Ctrl+D', 'Select section'], ['Alt+Left / Right', 'Focus left / right pane']]],
  ['Folder Compare', [['Enter', 'Open folder / compare files'], ['Del, Shift+Del', 'Delete, permanent delete'], ['F2', 'Rename'], ['Ctrl+A', 'Select all'], ['Ctrl+F', 'Find filename'], ['Left / Right', 'Collapse / expand'], ['Backspace', 'Up one level'], ['Ctrl+Alt+L', 'Legend']]],
];

// Small marker identifying a session type in tabs and on the home view.
function typeGlyph(type) {
  if (type === 'dir') return h('span', { class: 'ico dir same' });
  return { home: '⌂', text: '≡', hex: '01' }[type] || '';
}

class HomeView {
  constructor(app) {
    this.app = app;
    this.type = 'home';
    this.title = 'Home';
    this.keymap = {};
    this.list = h('div', { class: 'home-list' });
    const tile = (label, desc, cmd, type) => h('button', { class: 'home-tile', onclick: () => app.command(cmd) },
      h('span', { class: 'home-glyph' }, typeGlyph(type)), h('span', { class: 'home-label' }, label), h('span', { class: 'home-desc' }, desc));
    this.el = h('div', { class: 'view homeview' },
      h('div', { class: 'home-col' },
        h('h2', {}, 'Start new session'),
        tile('Folder Compare', 'Compare two folder trees side by side and synchronize them', 'NewDir', 'dir'),
        tile('Text Compare', 'Compare and edit two text files line by line', 'NewText', 'text'),
        tile('Hex Compare', 'Compare two binary files byte by byte', 'NewHex', 'hex')),
      h('div', { class: 'home-col wide' }, h('h2', {}, 'Recent sessions'), this.list));
  }

  async onShow() {
    const sessions = await api.loadSessions();
    const names = { dir: 'Folder Compare', text: 'Text Compare', hex: 'Hex Compare' };
    this.list.replaceChildren(...(sessions.length ? sessions.map((s) => h('button', { class: 'home-item', onclick: () => this.app.openSession(s, true) },
      h('span', { class: 'home-kind' }, names[s.type] || s.type), h('span', { class: 'home-paths' }, `${s.left}  <-->  ${s.right}`),
      h('span', { class: 'home-time' }, fmtDate(s.time)))) : [h('div', { class: 'home-empty' }, 'No sessions yet.')]));
  }

  onClose() {
    return true;
  }

  command() {
    return false;
  }
}

const App = {
  tabs: [],
  active: null,

  init() {
    this.tabsEl = document.getElementById('tabs');
    this.viewsEl = document.getElementById('views');
    document.addEventListener('keydown', (e) => this.onKey(e));
    api.onCommand((c) => { if (!Modal.open) this.command(c); });
    api.onOpen((paths) => this.openPaths(paths));
    api.onDirProgress((p) => { if (this.active && this.active.onProgress) this.active.onProgress(p); });
    window.addEventListener('beforeunload', (e) => {
      if (this.quitting) return;
      const dirty = this.tabs.some((t) => t.sides && (t.sides.left.dirty || t.sides.right.dirty));
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = false;
      this.closeAll();
    });
    api.args().then((paths) => {
      if (paths.length) this.openPaths(paths); else this.add(new HomeView(this));
    });
  },

  async closeAll() {
    for (const tab of this.tabs.slice()) {
      this.activate(tab);
      if (!(await tab.onClose())) return;
      if (tab.sides) tab.sides.left.dirty = tab.sides.right.dirty = false;
    }
    this.quitting = true;
    window.close();
  },

  async openPaths(paths) {
    const [left, right] = [paths[0] || '', paths[1] || ''];
    const st = left ? await api.stat(left) : { exists: false };
    if (st.exists && st.isDir) this.add(new DirView(this, left, right));
    else this.openFiles(left, right);
  },

  // Opens a file pair in the text view, or the hex view when either is binary.
  async openFiles(left, right) {
    let binary = false;
    for (const p of [left, right]) {
      try {
        if (p && await api.isBinary(p)) binary = true;
      } catch { /* missing files are reported by the view */ }
    }
    this.add(binary ? new HexView(this, left, right) : new TextView(this, left, right));
  },

  openSession(s, replace) {
    const View = { dir: DirView, text: TextView, hex: HexView }[s.type];
    if (!View) return;
    const home = replace && this.active && this.active.type === 'home' ? this.active : null;
    this.add(new View(this, s.left, s.right));
    if (home) this.remove(home);
  },

  add(view) {
    this.tabs.push(view);
    this.viewsEl.append(view.el);
    this.activate(view);
  },

  activate(view) {
    this.active = view;
    for (const t of this.tabs) t.el.classList.toggle('active', t === view);
    this.updateTabs();
    if (view.onShow) view.onShow();
  },

  remove(view) {
    const i = this.tabs.indexOf(view);
    if (i < 0) return;
    this.tabs.splice(i, 1);
    view.el.remove();
    if (!this.tabs.length) this.add(new HomeView(this));
    else if (this.active === view) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    else this.updateTabs();
  },

  async close(view) {
    if (await view.onClose()) this.remove(view);
  },

  updateTabs() {
    if (!this.tabsEl) return;
    this.tabsEl.replaceChildren(...this.tabs.map((t) => h('div', {
      class: 'tab' + (t === this.active ? ' active' : ''), title: t.title,
      onmousedown: (e) => { if (e.button === 1) this.close(t); else if (!e.target.classList.contains('tab-x')) this.activate(t); },
    }, h('span', { class: 'tab-glyph' }, typeGlyph(t.type)), h('span', { class: 'tab-title' }, t.title),
    h('span', { class: 'tab-x', title: 'Close tab', onclick: () => this.close(t) }, '×'))),
    h('div', { class: 'tab new', title: 'New tab (Ctrl+T)', onclick: () => this.command('TabNew') }, '+'));
    document.title = this.active ? `${this.active.title} - Janus Diff` : 'Janus Diff';
  },

  onKey(e) {
    if (Modal.open) return;
    const combo = keyCombo(e);
    if (!combo) return;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const cmd = APP_KEYS[combo] || (!inField && this.active && this.active.keymap[combo]);
    // Inside a text field only function keys reach the view.
    const fromField = inField && !APP_KEYS[combo] && /^(Shift\+)?F\d+$/.test(combo) && this.active && this.active.keymap[combo];
    const run = cmd || fromField;
    if (!run) return;
    e.preventDefault();
    this.command(run);
  },

  command(c) {
    switch (c) {
      case 'TabNew': this.add(new HomeView(this)); return;
      case 'NewDir': this.openSession({ type: 'dir', left: '', right: '' }, true); return;
      case 'NewText': this.openSession({ type: 'text', left: '', right: '' }, true); return;
      case 'NewHex': this.openSession({ type: 'hex', left: '', right: '' }, true); return;
      case 'CloseTab': if (this.active) this.close(this.active); return;
      case 'TabNext': case 'TabPrev': {
        const i = this.tabs.indexOf(this.active) + (c === 'TabNext' ? 1 : -1);
        this.activate(this.tabs[(i + this.tabs.length) % this.tabs.length]);
        return;
      }
      case 'Shortcuts':
        Modal.show('Keyboard Shortcuts', h('div', { class: 'shortcuts' }, SHORTCUT_HELP.map(([group, keys]) => h('div', {},
          h('div', { class: 'dlg-heading' }, group), keys.map(([k, d]) => h('div', { class: 'sc-row' }, h('kbd', {}, k), h('span', {}, d)))))), [['Close', true, true]]);
        return;
      case 'About':
        api.version().then((v) => Modal.message('About', `Janus Diff ${v}\n\nAn independent folder, text and hex comparison tool.`));
        return;
      default:
        if (this.active) this.active.command(c);
    }
  },
};

App.init();
