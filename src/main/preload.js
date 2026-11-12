'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
// The sandboxed preload cannot load Node's path module.
const sep = process.platform === 'win32' ? '\\' : '/';
const isSep = (ch) => ch === '/' || (sep === '\\' && ch === '\\');
const trimEnd = (p) => {
  let end = p.length;
  while (end > 1 && isSep(p[end - 1]) && !(sep === '\\' && p[end - 2] === ':')) end--;
  return p.slice(0, end);
};
const lastSep = (p) => {
  for (let i = p.length - 1; i >= 0; i--) if (isSep(p[i])) return i;
  return -1;
};
const path = {
  sep,
  join: (...parts) => parts.filter(Boolean).map((part, i) => (i ? part.replace(/^[\\/]+/, '') : part))
    .reduce((acc, part) => (acc && !isSep(acc[acc.length - 1]) ? acc + sep + part : acc + part), ''),
  dirname: (p) => {
    p = trimEnd(p);
    const i = lastSep(p);
    if (i < 0) return p;
    if (i === 0) return p.slice(0, 1);
    return trimEnd(p.slice(0, i + 1));
  },
  basename: (p) => {
    p = trimEnd(p);
    return p.slice(lastSep(p) + 1);
  },
};

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  args: call('app:args'),
  version: call('app:version'),
  guide: call('app:guide'),
  checkUpdate: call('update:check'),
  downloadUpdate: call('update:download'),
  cancelUpdate: call('update:cancel'),
  installUpdate: call('update:install'),
  openUpdatePage: call('update:page'),
  setMenuView: call('menu:view'),
  pickFolder: call('dialog:pickFolder'),
  pickFile: call('dialog:pickFile'),
  saveFileDialog: call('dialog:saveFile'),
  stat: call('fs:stat'),
  isBinary: call('fs:isBinary'),
  readText: call('fs:readText'),
  writeText: call('fs:writeText'),
  readBinary: call('fs:readBinary'),
  compareFolders: call('dir:compare'),
  cancelCompare: call('dir:cancel'),
  recheckContents: call('dir:recheck'),
  copy: call('ops:copy'),
  remove: call('ops:delete'),
  rename: call('ops:rename'),
  mkdir: call('ops:mkdir'),
  showInFolder: call('shell:show'),
  readClipboard: call('clipboard:readText'),
  loadSessions: call('sessions:load'),
  rememberSession: call('sessions:remember'),
  onCommand: (fn) => ipcRenderer.on('menu:command', (_e, command) => fn(command)),
  onOpen: (fn) => ipcRenderer.on('app:open', (_e, paths) => fn(paths)),
  onDirProgress: (fn) => ipcRenderer.on('dir:progress', (_e, p) => fn(p)),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, p) => fn(p)),
  pathForFile: (file) => webUtils.getPathForFile(file),
  path,
});
