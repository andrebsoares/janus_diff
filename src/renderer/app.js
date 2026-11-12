'use strict';
// Application shell: tab strip, home view, keyboard and menu command routing.

const APP_KEYS = {
  'Ctrl+T': 'TabNew', 'Ctrl+W': 'CloseTab', 'Ctrl+F4': 'CloseTab', 'Ctrl+Tab': 'TabNext', 'Ctrl+Shift+Tab': 'TabPrev', F1: 'Shortcuts',
};

const DISK_CHECK_MS = 1500;
// The automatic update check waits until startup is over.
const UPDATE_CHECK_DELAY_MS = 5000;

// Groups of [keys, description]; SHORTCUT_COLUMNS lays them out in the F1 dialog.
const SHORTCUT_HELP = [
  ['All views', [['Ctrl+T', 'New tab'], ['Ctrl+W, Ctrl+F4', 'Close tab'], ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'], ['F5', 'Refresh / reload'], ['Ctrl+N / Ctrl+P', 'Next / previous difference'], ['F1', 'This list']]],
  ['Text Compare', [['Ctrl+R / Ctrl+L', 'Copy section (or selection) to right / left'], ['Ctrl+Shift+R / L', 'Copy only the line(s) to right / left, then go to the next difference'],
    ['Click → / ←', 'Copy that line, or the whole selection (Shift+click: its section)'],
    ['Drag, Shift+click', 'Select lines; then → / ←, Ctrl+Shift+R / L or the floating button copies them'],
    ['Shift+Up/Down, PgUp/PgDn, Home/End', 'Extend the selection'], ['Drag the selection', 'Drop it on the other pane to insert a copy there (Esc cancels)'], ['Right-click', 'Copy line / section menu'], ['Click the text, F2, Enter, or type', 'Edit: Enter breaks the line, arrows move between lines, Esc reverts the line'], ['F7', 'Align line with a line on the other side (Esc cancels)'], ['Ctrl+Enter', 'Insert line after'], ['Del', 'Delete selected line(s), or the character while editing'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S, F12', 'Save, Save As'], ['Ctrl+F, F3, Shift+F3', 'Find, find next, find previous'], ['Ctrl+G', 'Go to line'], ['Ctrl+D', 'Select section'], ['Ctrl+C', 'Copy the text of the line(s)'], ['Alt+Left / Right, F6', 'Focus left / right pane, switch pane'], ['Ctrl+Shift+C', 'Copy as unified diff (patch)'], ['Ctrl+Shift+V', 'Compare the clipboard text on this side']]],
  ['Folder Compare', [['Enter', 'Open folder / compare files'], ['Ctrl+R / Ctrl+L', 'Copy to right / left'], ['Ctrl+M', 'Compare contents of selection'], ['Ctrl+E', 'Exclude selection'], ['Del, Shift+Del', 'Delete, permanent delete'], ['F2', 'Rename'], ['Ctrl+A', 'Select all'], ['Drag, Shift+click, Ctrl+click', 'Select a range / add or remove an item'], ['Shift+Up/Down, PgUp/PgDn, Home/End', 'Extend the selection'], ['Ctrl+F, F3, Shift+F3', 'Find filename, next, previous'], ['Left / Right', 'Collapse / expand'], ['Backspace', 'Up one level'], ['Alt+Left / Right', 'Active side (delete, rename, new folder)'], ['Ctrl+Alt+L', 'Legend']]],
  ['Hex Compare', [['Ctrl+G', 'Go to offset (hex)'], ['Ctrl+Home / Ctrl+End', 'Start / end of the files'], ['Up/Down/PgUp/PgDn', 'Move']]],
];
const SHORTCUT_COLUMNS = [['All views', 'Hex Compare'], ['Text Compare'], ['Folder Compare']];

// Small marker identifying a session type in tabs and on the home view.
function typeGlyph(type) {
  if (type === 'dir') return h('span', { class: 'ico dir same' });
  return { home: '⌂', text: '≡', hex: '01', help: '?', update: '⇧' }[type] || '';
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
        tile('Hex Compare', 'Compare two binary files byte by byte', 'NewHex', 'hex'),
        this.updateSlot = h('div', {}),
        h('h2', { class: 'home-gap' }, 'Help'),
        tile('User Guide', 'How to use every feature of Janus Diff', 'Guide', 'help')),
      h('div', { class: 'home-col wide' }, h('h2', {}, 'Recent sessions'), this.list));
  }

  async onShow() {
    const u = this.app.update;
    this.updateSlot.replaceChildren(...(u ? [h('h2', { class: 'home-gap' }, 'Update'),
      h('button', { class: 'home-tile update', onclick: () => Updates.offer(u) },
        h('span', { class: 'home-glyph' }, typeGlyph('update')), h('span', { class: 'home-label' }, `Janus Diff ${u.version} is available`),
        h('span', { class: 'home-desc' }, `You have version ${u.current}. Click to see what is new and update.`))] : []));
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
    api.onUpdateProgress((p) => Updates.onProgress(p));
    // Files changed by other programs are picked up on focus and while visible.
    const checkDisk = () => { if (!Modal.open && !document.hidden && this.active && this.active.checkDisk) this.active.checkDisk(); };
    window.addEventListener('focus', checkDisk);
    setInterval(checkDisk, DISK_CHECK_MS);
    window.addEventListener('beforeunload', (e) => {
      if (this.quitting) return;
      const dirty = this.tabs.some((t) => t.sides && (t.sides.left.dirty || t.sides.right.dirty));
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = false;
      this.closeAll();
    });
    api.args().then(async (opens) => {
      if (!opens.length) this.add(new HomeView(this));
      for (const paths of opens) await this.openPaths(paths);
    });
    setTimeout(() => Updates.check(true), UPDATE_CHECK_DELAY_MS);
  },

  async closeAll() {
    if (!(await this.confirmQuit())) return;
    this.quitting = true;
    window.close();
  },

  // Gives each tab the chance to save or keep its changes; false when one
  // of them cancels.
  async confirmQuit() {
    for (const tab of this.tabs.slice()) {
      this.activate(tab);
      if (!(await tab.onClose())) return false;
      if (tab.sides) tab.sides.left.dirty = tab.sides.right.dirty = false;
    }
    return true;
  },

  // Remembers an available update and shows it on the home tabs.
  setUpdate(info) {
    this.update = info && info.available ? info : null;
    if (this.active && this.active.type === 'home') this.active.onShow();
  },

  async openPaths(paths) {
    const [left, right] = [paths[0] || '', paths[1] || ''];
    const st = left ? await api.stat(left) : { exists: false };
    if (st.exists && st.isDir) this.add(new DirView(this, left, right));
    else await this.openFiles(left, right);
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
    const View = { dir: DirView, text: TextView, hex: HexView, help: HelpView }[s.type];
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
    api.setMenuView(view.type);
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
    if (!run) {
      if (!inField && this.active && this.active.typed) this.active.typed(e);
      return;
    }
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
        Modal.show('Keyboard Shortcuts', h('div', { class: 'shortcuts' }, SHORTCUT_COLUMNS.map((names) => h('div', {},
          SHORTCUT_HELP.filter(([group]) => names.includes(group)).map(([group, keys]) => h('div', { class: 'sc-group' },
            h('div', { class: 'dlg-heading' }, group), keys.map(([k, d]) => h('div', { class: 'sc-row' }, h('kbd', {}, k), h('span', {}, d)))))))),
        [['User Guide', 'guide'], ['Close', true, true]]).then((v) => { if (v === 'guide') this.command('Guide'); });
        return;
      case 'Guide': {
        // One guide tab; opening it again brings that tab forward.
        const open = this.tabs.find((t) => t.type === 'help');
        if (open) this.activate(open);
        else this.openSession({ type: 'help' }, true);
        return;
      }
      case 'CheckUpdates':
        Updates.check(false);
        return;
      case 'About':
        api.version().then((v) => Modal.message('About', `Janus Diff ${v}\n\nAn independent folder, text and hex comparison tool.`));
        return;
      default:
        if (this.active) this.active.command(c);
    }
  },
};

// The message of an error thrown by the main process, without Electron's
// "Error invoking remote method" prefix.
function remoteError(err) {
  return String(err && err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// Update check, download and install (Help -> Check for Updates). The main
// process keeps the release and the downloaded file; this is only the dialogs.
const Updates = {
  busy: false,
  onProgress: () => {},

  // quiet: the automatic check at startup, which only shows an available
  // update on the home tab and says nothing otherwise.
  async check(quiet) {
    if (this.busy) return;
    let info;
    try {
      info = await api.checkUpdate(quiet);
    } catch (err) {
      if (!quiet) Modal.message('Check for Updates', `Could not check for updates.\n\n${remoteError(err)}`);
      return;
    }
    if (!info) return;
    App.setUpdate(info);
    if (quiet) return;
    if (info.available) this.offer(info);
    else Modal.message('Check for Updates', `Janus Diff ${info.current} is the latest version.`);
  },

  async offer(info) {
    if (this.busy || Modal.open) return;
    const notes = h('div', { class: 'update-notes' });
    notes.innerHTML = Markdown.render(info.notes || 'No release notes.').html;
    notes.addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      e.preventDefault();
      api.openUpdatePage(a.href);
    });
    const canInstall = info.kind !== 'none' && !!info.asset;
    const size = canInstall && info.asset.size ? ` (${(info.asset.size / 1048576).toFixed(1)} MB)` : '';
    const how = info.kind === 'none'
      ? 'This copy cannot update itself (it runs from source or on another system); get the new version from the release page.'
      : !info.asset ? 'This release has no file for this copy of Janus Diff; see the release page.'
        : info.kind === 'installer' ? `Update Now downloads the installer${size}, closes Janus Diff, updates it and starts it again.`
          : `Update Now downloads the new portable executable${size} next to the current one, closes Janus Diff and starts the new version. The old file can be deleted afterwards.`;
    const body = h('div', { class: 'update-dlg' },
      h('div', { class: 'dlg-text' }, `Version ${info.version} is available. You have version ${info.current}.`),
      h('div', { class: 'dlg-heading' }, 'What is new'), notes,
      h('div', { class: 'dlg-text update-how' }, how));
    const buttons = [...(canInstall ? [['Update Now', 'install', true]] : []), ['Release Page', 'page', !canInstall], ['Later', null]];
    const choice = await Modal.show('Update Available', body, buttons);
    if (choice === 'page') api.openUpdatePage(info.page);
    else if (choice === 'install') this.install(info);
  },

  async install(info) {
    this.busy = true;
    try {
      const bar = h('div', { class: 'update-bar' });
      const label = h('div', { class: 'dlg-text' }, 'Starting the download...');
      const mb = (n) => (n / 1048576).toFixed(1);
      this.onProgress = ({ received, total }) => {
        if (total) bar.style.width = Math.min(100, (received / total) * 100) + '%';
        label.textContent = total ? `Downloading: ${mb(received)} of ${mb(total)} MB` : `Downloading: ${mb(received)} MB`;
      };
      let result = null, error = null;
      const dialog = Modal.show(`Downloading Janus Diff ${info.version}`,
        h('div', { class: 'update-dlg' }, label, h('div', { class: 'update-track' }, bar)), [['Cancel', 'cancel']]);
      const download = api.downloadUpdate().then((r) => { result = r; }, (err) => { error = err; }).then(() => Modal.close('done'));
      if ((await dialog) !== 'done') {
        api.cancelUpdate();
        await download;
        return;
      }
      if (error) {
        Modal.message('Update', `The update could not be downloaded.\n\n${remoteError(error)}`);
        return;
      }
      const where = result.kind === 'portable' ? `\n\nThe new version was saved as:\n${result.file}` : '';
      if (!(await Modal.confirm('Update', `Janus Diff ${info.version} is ready. Janus Diff will close now to update.${where}`, 'Update Now'))) return;
      if (!(await App.confirmQuit())) return;
      App.quitting = true;
      try {
        await api.installUpdate();
      } catch (err) {
        App.quitting = false;
        Modal.message('Update', `The update could not be started.\n\n${remoteError(err)}`);
      }
    } finally {
      this.onProgress = () => {};
      this.busy = false;
    }
  },
};

App.init();
