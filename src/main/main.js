'use strict';
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const Dir = require('../core/dircompare');
const Shell = require('./shellmenu');
const { parseCli } = require('./cli');

const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_RECENT = 30;

let win;

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

// Shortcuts are displayed here but handled by the renderer, because the same
// key means different things in different views (Ctrl+N, F5, F7...).
function item(label, command, accelerator) {
  return { label, accelerator, registerAccelerator: false, click: () => send(command) };
}

const sep = { type: 'separator' };

function buildMenu() {
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
        item('Copy Line to Right', 'CopyLineRight', 'Ctrl+Shift+R'),
        item('Copy Line to Left', 'CopyLineLeft', 'Ctrl+Shift+L'),
        sep,
        item('Compare Clipboard (Current Side)', 'PasteSide', 'Ctrl+Shift+V'),
        item('Compare Clipboard as Left', 'PasteLeft'),
        item('Compare Clipboard as Right', 'PasteRight'),
        sep,
        item('Edit Line', 'FullEdit', 'F2'),
        item('Insert Line After', 'InsertItemAfter', 'Ctrl+Enter'),
        item('Align With...', 'AlignWith', 'F7'),
        item('Select All', 'SelectAll', 'Ctrl+A'),
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
          click: () => runTool('Git Diff Tool', 'Git is configured. Use "git difftool" for files or "git difftool --dir-diff" for a folder view.',
            () => Shell.gitSetup(launcher())),
        },
      ],
    },
    {
      label: '&Help',
      submenu: [item('Keyboard Shortcuts', 'Shortcuts', 'F1'), item('About', 'About')],
    },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 420,
    backgroundColor: '#f0f0f0',
    title: 'Janus Diff',
    icon: path.join(__dirname, '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(buildMenu());
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

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  handle('app:args', () => startPaths);
  handle('app:version', () => app.getVersion());

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
  handle('dir:compare', (left, right, criteria) => Dir.compareFolders(left, right, criteria, progress));
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

const cli = parseCli(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());
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
    if (data && data.paths && data.paths.length) win.webContents.send('app:open', data.paths);
  });
  if (cli.mode === 'compare-selected') gather(cli.target); else startWindow();
}
