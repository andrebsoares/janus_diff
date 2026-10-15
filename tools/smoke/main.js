const { app, BrowserWindow } = require('electron');
const fs = require('fs'), path = require('path');
const [proj, out, L, R] = process.argv.slice(-4);
process.argv = [process.argv[0], '.', L, R];
app.setPath('userData', path.join(out, 'userdata'));
// Run as "electron tools/smoke/main.js" the app would report Electron's version.
app.setVersion(require(path.join(proj, 'package.json')).version);
// Under Xvfb the GPU process crashes now and then and capturePage fails with
// UnknownVizError; software rendering avoids it.
app.disableHardwareAcceleration();
require(path.join(proj, 'src/main/main.js'));

const TIMEOUT_MS = 120000;
const failures = [];
const fail = (what) => { failures.push(what); console.log('FAIL', what); };
setTimeout(() => { console.log('TIMEOUT after', TIMEOUT_MS, 'ms'); app.exit(2); }, TIMEOUT_MS);
process.on('unhandledRejection', (e) => fail('unhandled rejection: ' + (e && e.message)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  wc.on('console-message', (e) => console.log('[console]', e.level, e.message, e.sourceId + ':' + e.lineNumber));
  const js = (code) => wc.executeJavaScript(code, true).catch((e) => { fail('JS ERROR ' + code.slice(0, 80) + ': ' + e.message); });
  const shot = async (name) => {
    await sleep(700);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        fs.writeFileSync(path.join(out, name + '.png'), (await wc.capturePage()).toPNG());
        console.log('shot', name);
        return;
      } catch (e) {
        console.log('shot', name, 'attempt', attempt, 'failed:', e.message);
        await sleep(1000);
      }
    }
    fail('shot ' + name);
  };
  // Answers the open dialog with the button of that label and logs its text.
  const answer = async (label) => {
    console.log('dialog', await js(`JSON.stringify(document.querySelector('.dlg') && document.querySelector('.dlg-body').innerText)`));
    await js(`{ const b = [...document.querySelectorAll('.dlg-btn')].find(b => b.textContent === ${JSON.stringify(label)}); if (b) b.click(); } 0`);
  };
  console.log('errors-at-load', await js(`window.__errs = []; window.addEventListener('error', e => __errs.push(e.message)); window.addEventListener('unhandledrejection', e => __errs.push(String(e.reason && e.reason.message || e.reason))); typeof App + ' tabs=' + App.tabs.length + ' type=' + (App.active && App.active.type)`));
  await js(`App.active.command('ExpandAll')`); await shot('1-dir');
  console.log('dir rows', await js(`JSON.stringify(App.active.flat.map(f => f.node.rel + ':' + f.node.status))`));
  await js(`App.active.command('FavDiff')`); await shot('2-dir-diffs');
  await js(`App.active.command('Legend')`); await shot('3-legend');
  await js(`{ document.querySelector('.dlg-btn').click(); App.active.command('FavCompareAll'); const v = App.active; v.moveTo(v.flat.findIndex(f => f.node.rel === 'src/app.js')); v.open(); } 0`);
  await sleep(1200); await shot('4-text');
  console.log('text', await js(`JSON.stringify({type: App.active.type, stats: App.active.stats, secs: App.active.sections.length, cur: App.active.cur, title: App.active.title})`));
  await js(`App.active.command('DiffNext')`); await js(`App.active.command('CopyRight')`); await shot('5-text-copied');
  console.log('after copy', await js(`JSON.stringify({stats: App.active.stats, dirty: App.active.sides.right.dirty, undo: App.active.undo.length})`));
  await js(`App.active.command('Undo'); App.active.command('InsigIgnored'); App.active.command('FavDiff')`); await shot('6-text-diffs-only');
  console.log('after undo', await js(`JSON.stringify({stats: App.active.stats, dirty: App.active.sides.right.dirty, vis: App.active.vis.length})`));
  await js(`{ App.activate(App.tabs[0]); const v = App.active; v.moveTo(v.flat.findIndex(f => f.node.rel === 'logo.bin')); v.open(); } 0`);
  await sleep(1200); await shot('7-hex');
  console.log('hex', await js(`JSON.stringify({type: App.active.type, diffBytes: App.active.diffBytes})`));
  await js(`App.command('TabNew')`); await sleep(500); await shot('8-home');
  await js(`{ App.activate(App.tabs[0]); App.active.sync('MirrorRight'); } 0`); await sleep(500); await shot('9-sync-confirm');
  await js(`document.querySelector('.dlg-btn.default').click()`); await sleep(2500);
  // Failed deletions (no recycle bin, e.g. in a container) offer a permanent
  // delete; the result dialog, if any, must be closed before the view refreshes.
  if (await js(`!!document.querySelector('.dlg-btn') && [...document.querySelectorAll('.dlg-btn')].some(b => b.textContent === 'Delete Permanently')`)) {
    await answer('Delete Permanently'); await sleep(2500);
  }
  if (await js(`!!document.querySelector('.dlg')`)) { await answer('OK'); await sleep(2500); }
  const mirror = await js(`JSON.stringify({counts: App.active.counts, dlg: !!document.querySelector('.dlg')})`);
  console.log('after mirror', mirror);
  const c = mirror && JSON.parse(mirror).counts;
  if (!c || c.diff || c.orphanLeft || c.orphanRight) fail('Mirror to Right left differences: ' + mirror);
  const errs = await js(`JSON.stringify(window.__errs)`);
  console.log('page errors', errs);
  if (errs !== '[]') fail('page errors');
  console.log(failures.length ? `SMOKE FAILED (${failures.length})` : 'SMOKE OK');
  app.exit(failures.length ? 1 : 0);
});
