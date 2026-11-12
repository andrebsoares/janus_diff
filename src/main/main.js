'use strict';
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, net, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Dir = require('../core/dircompare');
const Shell = require('./shellmenu');
const Updater = require('./updater');
const { build: { publish: PUBLISH } } = require('../../package.json');
const { parseCli, appArgs } = require('./cli');

const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_RECENT = 30;

let win;
// Comparisons requested before the page could receive them; it asks for them
// through app:args once it is listening.
let pageListening = false;
let pendingOpens = [];

function openInWindow(paths) {
  if (pageListening) win.webContents.send('app:open', paths);
  else pendingOpens.push(paths);
}

function sessionsFile() {
  return path.join(app.getPath('userData'), 'sessions.json');
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
  } catch {
    return [];
  }
}

// How to start this same app again: the executable alone when packaged, plus
// the app path when running from source.
function launcher() {
  if (app.isPackaged) return { exe: process.execPath, args: [] };
  // From source the executable is electron.exe, which carries Electron's icon.
  return { exe: process.execPath, args: [app.getAppPath()], icon: path.join(app.getAppPath(), 'installer', 'icon.ico') };
}

function leftStateFile() {
  return path.join(app.getPath('userData'), 'shell-left.json');
}

// Runs an integration task from the Tools menu and reports the outcome.
function runTool(title, done, fn) {
  let message = done;
  let type = 'info';
  try {
    fn();
  } catch (err) {
    message = err.message;
    type = 'error';
  }
  dialog.showMessageBox(win, { type, title, message });
}

function explorerTool(title, done, ops) {
  if (process.platform !== 'win32') {
    dialog.showMessageBox(win, { type: 'info', title, message: 'The Explorer context menu is only available on Windows.' });
    return;
  }
  runTool(title, done, () => Shell.apply(ops()));
}

function send(command) {
  if (win && !win.isDestroyed()) win.webContents.send('menu:command', command);
}

// Commands each kind of tab handles; the menu disables the others. Commands
// listed in none of them (tabs, new sessions, help) are always enabled.
const COMMON_COMMANDS = ['Swap', 'Refresh', 'BrowseLeft', 'BrowseRight', 'DiffNext', 'DiffPrev', 'FavCompareAll', 'FavDiff', 'FavSame'];
const VIEW_COMMANDS = {
  dir: [...COMMON_COMMANDS, 'Rules', 'CopyRight', 'CopyLeft', 'Open', 'CompareContents', 'Exclude', 'Delete', 'PermanentDelete', 'Rename', 'NewFolder',
    'UpdateRight', 'UpdateLeft', 'UpdateBoth', 'MirrorRight', 'MirrorLeft', 'SelectAll', 'ExpandAll', 'CollapseAll', 'Find', 'FindNext', 'FindPrev', 'FavOrphan', 'Legend'],
  text: [...COMMON_COMMANDS, 'Rules', 'Save', 'SaveAs', 'SavePatch', 'CopyRight', 'CopyLeft', 'Undo', 'Redo', 'CopyPatch', 'CopyLineRight', 'CopyLineLeft',
    'PasteSide', 'PasteLeft', 'PasteRight', 'FullEdit', 'InsertItemAfter', 'AlignWith', 'SelectAll', 'SelectSection', 'Find', 'FindNext', 'FindPrev', 'GoTo',
    'InsigIgnored', 'ShowWS', 'ShowItemNum'],
  hex: [...COMMON_COMMANDS, 'GoTo'],
};
const VIEW_SPECIFIC = new Set(Object.values(VIEW_COMMANDS).flat());

// Shortcuts are displayed here but handled by the renderer, because the same
// key means different things in different views (Ctrl+N, F5, F7...).
function menuItem(label, command, accelerator, view) {
  const enabled = !VIEW_SPECIFIC.has(command) || (VIEW_COMMANDS[view] || []).includes(command);
  return { label, accelerator, enabled, registerAccelerator: false, click: () => send(command) };
}

const sep = { type: 'separator' };

// view: the type of the active tab (home, dir, text, hex, help).
function buildMenu(view) {
  const item = (label, command, accelerator) => menuItem(label, command, accelerator, view);
  return Menu.buildFromTemplate([
    {
      label: '&Session',
      submenu: [
        item('New Tab', 'TabNew', 'Ctrl+T'),
        item('New Folder Compare', 'NewDir'),
        item('New Text Compare', 'NewText'),
        item('New Hex Compare', 'NewHex'),
        sep,
        item('Swap Sides', 'Swap'),
        item('Reload / Refresh', 'Refresh', 'F5'),
        item('Session Settings...', 'Rules'),
        sep,
        item('Close Tab', 'CloseTab', 'Ctrl+W'),
        { label: 'Exit', role: 'quit' },
      ],
    },
    {
      label: '&File',
      submenu: [
        item('Open Left...', 'BrowseLeft'),
        item('Open Right...', 'BrowseRight'),
        sep,
        item('Save', 'Save', 'Ctrl+S'),
        item('Save As...', 'SaveAs', 'F12'),
        item('Save Patch...', 'SavePatch'),
      ],
    },
    {
      label: '&Actions',
      submenu: [
        item('Copy to Right', 'CopyRight', 'Ctrl+R'),
        item('Copy to Left', 'CopyLeft', 'Ctrl+L'),
        sep,
        item('Open / Compare Contents', 'Open', 'Enter'),
        item('Compare Contents of Selection...', 'CompareContents', 'Ctrl+M'),
        item('Exclude from Comparison', 'Exclude', 'Ctrl+E'),
        item('Delete', 'Delete', 'Delete'),
        item('Delete Permanently', 'PermanentDelete', 'Shift+Delete'),
        item('Rename', 'Rename', 'F2'),
        item('New Folder...', 'NewFolder'),
        sep,
        {
          label: 'Synchronize',
          submenu: [
            item('Update Right', 'UpdateRight'),
            item('Update Left', 'UpdateLeft'),
            item('Update Both', 'UpdateBoth'),
            item('Mirror to Right', 'MirrorRight'),
            item('Mirror to Left', 'MirrorLeft'),
          ],
        },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        item('Undo', 'Undo', 'Ctrl+Z'),
        item('Redo', 'Redo', 'Ctrl+Y'),
        sep,
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        item('Copy as Unified Diff', 'CopyPatch', 'Ctrl+Shift+C'),
        sep,
        item('Copy Line(s) to Right', 'CopyLineRight', 'Ctrl+Shift+R'),
        item('Copy Line(s) to Left', 'CopyLineLeft', 'Ctrl+Shift+L'),
        sep,
        item('Compare Clipboard (Current Side)', 'PasteSide', 'Ctrl+Shift+V'),
        item('Compare Clipboard as Left', 'PasteLeft'),
        item('Compare Clipboard as Right', 'PasteRight'),
        sep,
        item('Edit Line', 'FullEdit', 'F2'),
        item('Insert Line After', 'InsertItemAfter', 'Ctrl+Enter'),
        item('Align With...', 'AlignWith', 'F7'),
        item('Select All', 'SelectAll', 'Ctrl+A'),
        item('Select Section', 'SelectSection', 'Ctrl+D'),
        item('Expand All', 'ExpandAll'),
        item('Collapse All', 'CollapseAll'),
      ],
    },
    {
      label: 'Sea&rch',
      submenu: [
        item('Next Difference Section', 'DiffNext', 'Ctrl+N'),
        item('Previous Difference Section', 'DiffPrev', 'Ctrl+P'),
        sep,
        item('Find...', 'Find', 'Ctrl+F'),
        item('Find Next', 'FindNext', 'F3'),
        item('Find Previous', 'FindPrev', 'Shift+F3'),
        item('Go To Line...', 'GoTo', 'Ctrl+G'),
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Show All', 'FavCompareAll'),
        item('Show Differences', 'FavDiff'),
        item('Show Same', 'FavSame'),
        item('Show Orphans', 'FavOrphan'),
        sep,
        item('Ignore Unimportant Differences', 'InsigIgnored'),
        item('Visible Whitespace', 'ShowWS'),
        item('Line Numbers', 'ShowItemNum'),
        item('Legend', 'Legend', 'Ctrl+Alt+L'),
        sep,
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '&Tools',
      submenu: [
        {
          label: 'Install Explorer Context Menu',
          click: () => explorerTool('Explorer Context Menu', 'Right-click a file or folder and choose "Janus Diff: Select Left File", or select two and choose "Janus Diff: Compare".',
            () => Shell.plan(Shell.loadLeft(leftStateFile()), launcher())),
        },
        {
          label: 'Remove Explorer Context Menu',
          click: () => explorerTool('Explorer Context Menu', 'The context menu entries were removed.', Shell.removalPlan),
        },
        sep,
        {
          label: 'Configure as Git Diff Tool',
          click: () => runTool('Git Diff Tool', 'Git is configured. Use "git jd" (takes the same arguments as "git diff") or "git difftool" for files, or "git difftool --dir-diff" for a folder view.',
            () => Shell.gitSetup(launcher())),
        },
      ],
    },
    {
      label: '&Help',
      submenu: [item('User Guide', 'Guide'), item('Keyboard Shortcuts', 'Shortcuts', 'F1'), sep, item('Check for Updates...', 'CheckUpdates'), item('About', 'About')],
    },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 420,
    show: false,
    backgroundColor: '#f0f0f0',
    title: 'Janus Diff',
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Shows the window too; width and height are its restored size.
  win.maximize();
  Menu.setApplicationMenu(buildMenu('home'));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

async function statPath(p) {
  try {
    const st = await fs.promises.stat(p);
    return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch {
    return { exists: false };
  }
}

async function probeBinary(p) {
  const handle = await fs.promises.open(p, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return Dir.decodeText(buf.subarray(0, bytesRead)).binary;
  } finally {
    await handle.close();
  }
}

// The User Guide's Markdown, with its images inlined as data URLs so the
// renderer can show them under its content security policy.
async function readGuide() {
  const dir = path.join(__dirname, '..', '..', 'docs');
  const md = await fs.promises.readFile(path.join(dir, 'AJUDA.md'), 'utf8');
  const images = new Map();
  for (const [, src] of md.matchAll(/!\[[^\]]*\]\(([^)\s]+\.png)\)/g)) {
    if (images.has(src)) continue;
    try {
      images.set(src, 'data:image/png;base64,' + (await fs.promises.readFile(path.join(dir, src))).toString('base64'));
    } catch { /* a missing picture leaves a broken image */ }
  }
  return md.replace(/(!\[[^\]]*\]\()([^)\s]+\.png)\)/g, (m, head, src) => (images.has(src) ? head + images.get(src) + ')' : m));
}

// Runs one file operation per item and reports the failures, with the items
// that failed, instead of stopping at the first one.
async function runOps(items, fn) {
  const errors = [], failed = [];
  for (const it of items) {
    try {
      await fn(it);
    } catch (err) {
      errors.push(`${it.path || it.from}: ${err.message}`);
      failed.push(it);
    }
  }
  return { done: items.length - errors.length, errors, failed };
}

// Update state: the release found by the last check and the file
// downloaded for it, so the renderer never hands over URLs or paths to run.
const updates = { info: null, file: null, signal: null };

function updateKind() {
  return Updater.installKind({ packaged: app.isPackaged, platform: process.platform, env: process.env });
}

// Downloads the release file of the last check. The installer goes to the
// temporary folder; the portable version next to the running executable (or
// to Downloads when that folder is not writable), since it is the app itself.
async function downloadUpdate() {
  const { info } = updates;
  if (!info || !info.available || !info.asset) throw new Error('There is no update to download.');
  const signal = { cancelled: false };
  updates.signal = signal;
  const tmpDir = path.join(app.getPath('temp'), 'janus-diff-update');
  const tmp = path.join(tmpDir, info.asset.name);
  try {
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await Updater.download(net.fetch, info.asset, tmp, (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('update:progress', p);
    }, signal);
  } finally {
    updates.signal = null;
  }
  let file = tmp;
  if (info.kind === 'portable') {
    file = null;
    for (const dir of [path.dirname(process.env.PORTABLE_EXECUTABLE_FILE), app.getPath('downloads')]) {
      const dest = path.join(dir, info.asset.name);
      try {
        await fs.promises.copyFile(tmp, dest);
        file = dest;
        break;
      } catch { /* try the next folder */ }
    }
    await fs.promises.rm(tmp, { force: true });
    if (!file) throw new Error('The new version could not be saved next to the current one nor in Downloads.');
  }
  updates.file = file;
  return { file, kind: info.kind, current: process.env.PORTABLE_EXECUTABLE_FILE || null };
}

// Starts the downloaded update and quits. The installer runs silently over
// the current installation (--updated keeps the install folder and mode) and
// starts the app again when done (--force-run); "start" goes through the
// shell so Windows can ask for elevation when the app is installed for all
// users. The portable version is simply started.
function installUpdate() {
  const { file, info } = updates;
  if (!file || !info) throw new Error('Download the update first.');
  const child = info.kind === 'installer'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "" "${file}" /S --updated --force-run"`],
      { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true })
    : spawn(file, [], { detached: true, stdio: 'ignore', cwd: path.dirname(file) });
  child.unref();
  setTimeout(() => app.quit(), 300);
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  handle('app:args', () => {
    pageListening = true;
    const opens = [startPaths, ...pendingOpens].filter((paths) => paths.length);
    pendingOpens = [];
    return opens;
  });
  handle('app:version', () => app.getVersion());
  handle('app:guide', readGuide);

  // quiet: the automatic check at startup, skipped where it makes no sense
  // (running from source) or would run too often (git difftool's --wait).
  handle('update:check', async (quiet) => {
    if (quiet && (!app.isPackaged || cli.wait)) return null;
    updates.info = await Updater.checkLatest(net.fetch, PUBLISH, app.getVersion(), updateKind());
    updates.file = null;
    return updates.info;
  });
  handle('update:download', downloadUpdate);
  handle('update:cancel', () => {
    if (updates.signal) updates.signal.cancelled = true;
  });
  handle('update:install', installUpdate);
  handle('update:page', (url) => {
    if (/^https:\/\/github\.com\//.test(url)) return shell.openExternal(url);
  });

  let menuView = 'home';
  handle('menu:view', (view) => {
    if (view === menuView) return;
    menuView = view;
    Menu.setApplicationMenu(buildMenu(view));
  });

  handle('dialog:pickFolder', async (start) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: start || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:pickFile', async (start) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: start || undefined });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:saveFile', async (start) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: start || undefined });
    return r.canceled ? null : r.filePath;
  });

  handle('fs:stat', statPath);
  handle('fs:isBinary', probeBinary);
  handle('fs:readText', async (p) => {
    const [buf, st] = await Promise.all([fs.promises.readFile(p), fs.promises.stat(p)]);
    return Object.assign(Dir.decodeText(buf), { mtime: st.mtimeMs, size: st.size });
  });
  handle('fs:writeText', async (p, text, encoding) => {
    await fs.promises.writeFile(p, Dir.encodeText(text, encoding));
    return statPath(p);
  });
  handle('fs:readBinary', async (p) => {
    const st = await fs.promises.stat(p);
    if (st.size > MAX_BINARY_BYTES) throw new Error(`File is larger than ${MAX_BINARY_BYTES >> 20} MB`);
    const buf = await fs.promises.readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  const progress = (p) => {
    if (win && !win.isDestroyed()) win.webContents.send('dir:progress', p);
  };
  // Running folder scans by the id the renderer gave them, so one that was
  // superseded (Refresh, other folders) or whose tab was closed can stop.
  const scans = new Map();
  handle('dir:compare', async (left, right, criteria, id) => {
    const signal = { cancelled: false };
    scans.set(id, signal);
    try {
      return await Dir.compareFolders(left, right, criteria, progress, signal);
    } finally {
      if (scans.get(id) === signal) scans.delete(id);
    }
  });
  handle('dir:cancel', (id) => {
    const signal = scans.get(id);
    if (signal) signal.cancelled = true;
  });
  handle('dir:recheck', (children, left, right, rels, criteria) => Dir.recheckContents(children, left, right, rels, criteria, progress));

  handle('ops:copy', (items) => runOps(items, async ({ from, to }) => {
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.cp(from, to, { recursive: true, force: true, preserveTimestamps: true });
  }));
  handle('ops:delete', (items, permanent) => runOps(items, ({ path: p }) => (
    permanent ? fs.promises.rm(p, { recursive: true, force: true }) : shell.trashItem(p)
  )));
  handle('ops:rename', async (from, newName) => {
    if (!newName || /[\\/]/.test(newName)) throw new Error('Invalid name');
    const to = path.join(path.dirname(from), newName);
    if ((await statPath(to)).exists && to.toLowerCase() !== from.toLowerCase()) throw new Error('Target already exists');
    await fs.promises.rename(from, to);
    return to;
  });
  handle('ops:mkdir', (p) => fs.promises.mkdir(p, { recursive: true }));
  handle('shell:show', (p) => shell.showItemInFolder(p));
  handle('clipboard:readText', async () => (await clipboard.readText()) || '');

  handle('sessions:load', loadSessions);
  handle('sessions:remember', (session) => {
    const same = (s) => s.type === session.type && s.left === session.left && s.right === session.right;
    const list = [Object.assign({ time: Date.now() }, session), ...loadSessions().filter((s) => !same(s))].slice(0, MAX_RECENT);
    fs.mkdirSync(path.dirname(sessionsFile()), { recursive: true });
    fs.writeFileSync(sessionsFile(), JSON.stringify(list, null, 2));
    return list;
  });
}

const cli = parseCli(appArgs(process.argv, app.isPackaged), process.cwd());
let startPaths = cli.paths;

// Explorer context menu and setup commands that finish without a window.
// Returns true when the process is done.
function runHeadless() {
  try {
    switch (cli.mode) {
      case 'select-left': Shell.selectLeft(leftStateFile(), cli.target, launcher()); return true;
      case 'register-shell': Shell.apply(Shell.plan(Shell.loadLeft(leftStateFile()), launcher())); return true;
      case 'unregister-shell': Shell.apply(Shell.removalPlan()); return true;
      case 'git-setup': Shell.gitSetup(launcher()); return true;
      case 'compare-to': {
        const left = Shell.takeLeft(leftStateFile(), launcher());
        startPaths = left ? [left.path, cli.target] : [cli.target];
        return false;
      }
      default: return false;
    }
  } catch (err) {
    dialog.showErrorBox('Janus Diff', err.message);
    return true;
  }
}

// Explorer starts one process per selected item, so the items of one
// "Compare" click arrive one by one and are gathered for a moment.
const GATHER_MS = 600;
let gathered = [];
let gatherTimer = null;
let windowStarted = false;

function gather(p) {
  gathered.push(p);
  clearTimeout(gatherTimer);
  gatherTimer = setTimeout(openGathered, GATHER_MS);
}

function openGathered() {
  const loading = windowStarted && (!win || win.webContents.isLoading());
  if (loading) {
    gatherTimer = setTimeout(openGathered, GATHER_MS);
    return;
  }
  const paths = [...new Set(gathered)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  gathered = [];
  if (paths.length > 2) {
    dialog.showErrorBox('Janus Diff', `Select two items to compare; ${paths.length} were selected.`);
    if (!windowStarted) app.exit(0);
  } else if (!windowStarted) {
    startPaths = paths;
    startWindow();
  } else {
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send('app:open', paths);
  }
}

function startWindow() {
  windowStarted = true;
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
}

if (runHeadless()) {
  app.exit(0);
} else if (cli.wait) {
  // Its own process, so the caller can wait for the window to close.
  startWindow();
} else if (!app.requestSingleInstanceLock(cli.mode === 'compare-selected' ? { gather: cli.target } : { paths: startPaths })) {
  app.quit();
} else {
  app.on('second-instance', (_e, _argv, _cwd, data) => {
    if (data && data.gather) {
      gather(data.gather);
      return;
    }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (data && data.paths && data.paths.length) openInWindow(data.paths);
  });
  if (cli.mode === 'compare-selected') gather(cli.target); else startWindow();
}
