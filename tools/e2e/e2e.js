'use strict';
// End-to-end test of Janus Diff with Playwright (Electron mode), on Windows
// or on Linux under Xvfb. See README.md.
// Usage: node tools/e2e/e2e.js [output-dir]   (default: tools/e2e/out)
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJ = path.resolve(__dirname, '../..');
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
const WORK = path.join(OUT, 'work');
const EXE = require(path.join(PROJ, 'node_modules/electron'));
const WIN = process.platform === 'win32';
// Containers run as a user without the setuid sandbox helper.
const SWITCHES = WIN ? [] : ['--no-sandbox'];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info) {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info !== undefined ? '  ' + JSON.stringify(info) : ''}`);
}
function skip(name, reason) {
  results.push({ name, ok: true, skipped: reason });
  console.log(`SKIP  ${name}  (${reason})`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshData(tag) {
  const dir = path.join(WORK, tag);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(process.execPath, [path.join(__dirname, 'make_data.js'), dir]);
  return { L: path.join(dir, 'left'), R: path.join(dir, 'right'), dir };
}

// Playwright puts its own switches before the app path; main.js finds the
// app path anyway, so the pair to compare goes straight on the command line.
async function launch(tag, paths, extra = []) {
  const ud = path.join(WORK, 'ud-' + tag);
  const app = await electron.launch({
    executablePath: EXE, cwd: PROJ,
    args: [...SWITCHES, ...extra, PROJ, '--wait', `--user-data-dir=${ud}`, ...paths],
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.waitForFunction(() => typeof App !== 'undefined' && App.active && App.active.type !== 'home', null, { timeout: 15000 });
  await sleep(1200);
  errors.length = 0;
  return { app, page, errors, ud };
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name + '.png') });
const dialogs = (page) => page.evaluate(() => [...document.querySelectorAll('.dlg-title')].map((t) => t.textContent));
const clickDialogButton = (page, label) => page.evaluate((label) => [...document.querySelectorAll('.dlg-btn')].find((b) => b.textContent === label).click(), label);

// Center of a text-view row cell (side, visible index k) in page coordinates.
async function tvRow(page, side, k, part = 'tx') {
  return page.evaluate(([side, k, part]) => {
    const v = App.active;
    const el = v.rowsEl[side].querySelector(`.row[data-k="${k}"] .${part}`) || v.rowsEl[side].querySelector(`.row[data-k="${k}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 };
  }, [side, k, part]);
}
const tvState = (page) => page.evaluate(() => {
  const v = App.active;
  return { cur: v.cur, anchor: v.anchor, side: v.side, left: v.sides.left.lines.slice(), right: v.sides.right.lines.slice(),
    dirty: [v.sides.left.dirty, v.sides.right.dirty], undo: v.undo.length, status: v.status.textContent, title: v.title };
});
// The floating copy button and the text it overlaps, if any (rows whose
// text box intersects the button in either pane).
const selButton = (page) => page.evaluate(() => {
  const v = App.active, b = v.selBtn, r = b.getBoundingClientRect();
  const range = document.createRange(), hits = [];
  for (const side of ['left', 'right']) {
    const pane = v.panes[side].getBoundingClientRect();
    for (const tx of v.rowsEl[side].querySelectorAll('.row .tx')) {
      if (!tx.firstChild) continue;
      range.selectNodeContents(tx);
      const t = range.getBoundingClientRect();
      const right = Math.min(t.right, pane.right);
      if (t.top < r.bottom - 1 && t.bottom > r.top + 1 && t.left < r.right && right > r.left) hits.push(`${side}:${tx.parentElement.dataset.k}`);
    }
  }
  return { vis: getComputedStyle(b).display !== 'none' && r.width > 0, text: b.textContent, x: r.left + r.width / 2, y: r.top + r.height / 2,
    row: Math.round((r.top - v.panes[v.side].getBoundingClientRect().top + v.scroller.bar.scrollTop) / 18), hits };
});

// ------------------------------------------------------------------------
async function folderTests() {
  const d = freshData('dir');
  const { app, page, errors } = await launch('dir', [d.L, d.R]);
  try {
    const st = await page.evaluate(() => ({ type: App.active.type, counts: App.active.counts }));
    check('dir: abre comparação de pastas', st.type === 'dir', st.counts);
    check('dir: contagens', st.counts && st.counts.diff >= 3 && st.counts.orphanLeft >= 2 && st.counts.orphanRight >= 1, st.counts);

    // Modified column fits (Segoe UI on Windows).
    await page.evaluate(() => App.active.command('ExpandAll'));
    await sleep(300);
    const clipped = await page.evaluate(() => [...App.active.el.querySelectorAll('.dv-row > span:nth-child(3), .dv-row > span:last-child')]
      .filter((s) => s.textContent && s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent));
    check('dir: coluna Modified não corta', clipped.length === 0, clipped.slice(0, 3));
    await shot(page, 'w01-dir');

    // Ctrl+N from the top walks into the collapsed folder.
    await page.evaluate(() => { App.active.command('CollapseAll'); App.active.cur = 0; App.active.scroller.refresh(); });
    await page.keyboard.press('Control+N');
    await sleep(200);
    const first = await page.evaluate(() => App.active.flat[App.active.cur].node.rel);
    check('dir: Ctrl+N chega na 1ª diferença dentro da pasta', /\//.test(first), first);

    // Drag-select rows with the real mouse.
    await page.evaluate(() => { App.active.command('ExpandAll'); App.active.cur = 0; App.active.scroller.refresh(); });
    await sleep(200);
    const pos = (k, side = 0) => page.evaluate(([k, side]) => { const r = App.active.el.querySelectorAll(`.dv-row[data-k="${k}"] .nm`)[side].getBoundingClientRect(); return { x: r.left + 60, y: r.top + r.height / 2 }; }, [k, side]);
    const a = await pos(1), b = await pos(4);
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
    const sel = await page.evaluate(() => App.active.selected.size);
    check('dir: arrastar seleciona 4 linhas', sel === 4, sel);

    // Delete on the side where the item does not exist explains why in the status bar.
    const target = path.join(d.R, 'only_right.txt');
    const k = await page.evaluate(() => App.active.flat.findIndex((f) => f.node.rel === 'only_right.txt'));
    let p = await pos(k, 0);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Delete');
    await sleep(400);
    const empty = { dlg: await page.locator('.dlg-backdrop').count(), msg: await page.evaluate(() => App.active.status.querySelector('.st-main').textContent) };
    check('dir: Delete no lado vazio (órfão do outro lado) explica na barra de status',
      empty.dlg === 0 && fs.existsSync(target) && /^Nothing to delete on the left side — "only_right.txt" exists only on the right/.test(empty.msg), empty);
    await shot(page, 'w02-dir-delete-empty-side');
    await page.keyboard.press('F2');
    await sleep(300);
    const ren = { dlg: await page.locator('.dlg-backdrop').count(), msg: await page.evaluate(() => App.active.status.querySelector('.st-main').textContent) };
    check('dir: F2 no lado vazio também explica', ren.dlg === 0 && /^Nothing to rename on the left side/.test(ren.msg), ren);

    // Delete to the recycle bin on the side where it exists.
    p = await pos(k, 1);
    await page.mouse.click(p.x, p.y);
    await page.keyboard.press('Delete');
    await sleep(400);
    const dlg1 = await dialogs(page);
    await shot(page, 'w03-dir-delete-confirm');
    await page.keyboard.press('Enter'); // default button: Delete
    await sleep(1500);
    const dlg2 = await dialogs(page);
    if (WIN) {
      check('dir: Delete para a Lixeira do Windows remove o arquivo', !fs.existsSync(target), { antes: dlg1, depois: dlg2 });
      check('dir: sem diálogo "Recycle Bin Unavailable" no Windows', !dlg2.includes('Recycle Bin Unavailable'), dlg2);
    } else if (dlg2.includes('Recycle Bin Unavailable')) {
      // Without gio (containers) the trash fails; the app offers a permanent delete.
      await shot(page, 'w03b-dir-recycle-bin-unavailable');
      await clickDialogButton(page, 'Delete Permanently');
      await sleep(1200);
      check('dir: sem lixeira (Linux sem gio) oferece exclusão permanente e remove', !fs.existsSync(target), { antes: dlg1, depois: dlg2 });
    } else {
      check('dir: Delete para a lixeira remove o arquivo', !fs.existsSync(target), { antes: dlg1, depois: dlg2 });
    }
    while (await page.locator('.dlg-backdrop').count()) { await page.keyboard.press('Escape'); await sleep(200); }

    // Compare Contents (Ctrl+M) on crlf.txt + encoding.txt, rules-based.
    await page.evaluate(() => {
      const v = App.active; v.selected.clear();
      for (const f of v.flat) if (['crlf.txt', 'encoding.txt'].includes(f.node.rel)) v.selected.add(f.node.rel);
      v.cur = v.flat.findIndex((f) => f.node.rel === 'crlf.txt'); v.scroller.refresh();
    });
    await page.keyboard.press('Control+M');
    await sleep(300);
    await page.keyboard.press('Enter');
    await sleep(1200);
    const cc = await page.evaluate(() => ({ msg: App.active.status.textContent,
      st: App.active.flat.filter((f) => ['crlf.txt', 'encoding.txt'].includes(f.node.rel)).map((f) => f.node.status) }));
    check('dir: Compare Contents (Ctrl+M) iguala CRLF/latin1', cc.st.every((s) => s === 'same'), cc);
    await shot(page, 'w04-dir-compare-contents');

    // F1 help.
    await page.keyboard.press('F1');
    await sleep(300);
    const help = await page.evaluate(() => ({ title: document.querySelector('.dlg-title')?.textContent, rows: document.querySelectorAll('.sc-row').length }));
    check('app: F1 abre ajuda', help.title === 'Keyboard Shortcuts' && help.rows > 20, help);
    await shot(page, 'w05-help');
    await page.keyboard.press('Escape');

    check('dir: sem erros de console', errors.length === 0, errors);
  } finally { await app.close(); }
}

// ------------------------------------------------------------------------
async function textTests() {
  const d = freshData('text');
  const L = path.join(d.L, 'src/app.js'), R = path.join(d.R, 'src/app.js');
  const { app, page, errors } = await launch('text', [L, R]);
  try {
    let s = await tvState(page);
    check('text: abre comparação de texto (caminhos direto na linha de comando)', s.left.length > 20 && s.right.length > 20 && s.title === 'app.js <--> app.js', s.title);
    await shot(page, 'w10-text');

    const info = await page.evaluate(() => {
      const v = App.active;
      const ks = v.vis.map((ri, k) => ({ k, row: v.rows[ri] })).filter((x) => v.kind(x.row) === 'diff');
      return ks.map((x) => ({ k: x.k, l: x.row.l, r: x.row.r, sec: x.row.sec }));
    });
    check('text: há linhas diferentes', info.length >= 5, info.length);

    // 1) Single-line copy via gutter arrow on a changed line.
    const changed = info.find((x) => x.l >= 0 && x.r >= 0);
    const leftText = s.left[changed.l];
    let p = await tvRow(page, 'left', changed.k, 'line-btn');
    await page.mouse.click(p.x, p.y);
    await sleep(250);
    s = await tvState(page);
    check('text: seta do gutter copia só a linha', s.right.includes(leftText) && s.undo === 1, { linha: leftText });
    await page.keyboard.press('Control+Z');
    await sleep(200);

    // 2) Drag-select several rows with the real mouse, then copy with the floating button.
    s = await tvState(page);
    const before = s.right.slice();
    const a = info[0].k, b = info[Math.min(3, info.length - 1)].k;
    const pa = await tvRow(page, 'left', a), pb = await tvRow(page, 'left', b);
    await page.mouse.move(pa.x + 60, pa.y); await page.mouse.down();
    await page.mouse.move(pb.x + 60, pb.y, { steps: 10 }); await page.mouse.up();
    await sleep(250);
    s = await tvState(page);
    const n = Math.abs(s.cur - s.anchor) + 1;
    check('text: arrastar seleciona o intervalo', s.anchor === a && s.cur === b, { anchor: s.anchor, cur: s.cur });
    const btn = await selButton(page);
    check('text: botão flutuante aparece', btn.vis && /Copy\s+\d+\s+lines/i.test(btn.text), btn.text);
    check('text: botão flutuante não cobre texto', btn.hits.length === 0, btn.hits);
    check('text: barra de status explica a seleção', /selected/i.test(s.status), s.status.slice(0, 80));
    await shot(page, 'w11-text-drag-select');
    await page.mouse.click(btn.x, btn.y);
    await sleep(250);
    s = await tvState(page);
    check('text: botão copia o bloco num único passo de undo', s.undo === 1 && s.dirty[1], { n, undo: s.undo });
    await shot(page, 'w12-text-block-copied');
    await page.keyboard.press('Control+Z');
    await sleep(200);
    s = await tvState(page);
    check('text: Ctrl+Z restaura tudo', JSON.stringify(s.right) === JSON.stringify(before) && !s.dirty[1]);

    // 3) Arrow inside a selection copies the whole selection.
    await page.mouse.move(pa.x + 60, pa.y); await page.mouse.down();
    await page.mouse.move(pb.x + 60, pb.y, { steps: 6 }); await page.mouse.up();
    await sleep(200);
    const mid = info.find((x) => x.k > a && x.k < b) || info[1];
    p = await tvRow(page, 'left', mid.k, 'line-btn');
    const tip = await page.evaluate(([k]) => App.active.rowsEl.left.querySelector(`.row[data-k="${k}"] .line-btn`)?.title, [mid.k]);
    await page.mouse.click(p.x, p.y);
    await sleep(250);
    s = await tvState(page);
    check('text: seta dentro da seleção copia o bloco', /selected lines/.test(tip || '') && s.undo === 1, tip);
    await page.keyboard.press('Control+Z');
    await sleep(200);

    // 4) Right-click menu on a line.
    p = await tvRow(page, 'left', changed.k);
    await page.mouse.click(p.x + 60, p.y, { button: 'right' });
    await sleep(250);
    const items = await page.evaluate(() => [...document.querySelectorAll('.ctx-item .ctx-label')].map((e) => e.textContent));
    check('text: clique direito abre menu com Copy Line/Section', items.some((t) => /Copy Line/.test(t)) && items.some((t) => /Copy Section/.test(t)), items);
    await shot(page, 'w13-text-context-menu');
    await page.keyboard.press('Escape');
    await sleep(150);

    // 5) Drag-and-drop the selected block onto the other pane.
    await page.mouse.click(pa.x + 60, pa.y);
    s = await tvState(page);
    const rightLen = s.right.length;
    await page.mouse.move(pa.x + 60, pa.y); await page.mouse.down();
    await page.mouse.move(pb.x + 60, pb.y, { steps: 6 }); await page.mouse.up();
    await sleep(200);
    const mid2 = await tvRow(page, 'left', a + 1);
    const dropAt = await tvRow(page, 'right', 1);
    await page.mouse.move(mid2.x + 60, mid2.y); await page.mouse.down();
    await page.mouse.move(dropAt.x + 80, dropAt.y, { steps: 12 });
    await sleep(150);
    const mark = await page.evaluate(() => { const m = App.active.dropMark; return { shown: m.style.display !== 'none', text: m.textContent }; });
    await shot(page, 'w14-text-drag-block');
    await page.mouse.up();
    await sleep(300);
    s = await tvState(page);
    check('text: arrastar bloco para o outro painel mostra marca de inserção', mark.shown, mark.text);
    check('text: soltar insere as linhas no outro lado', s.right.length > rightLen, { antes: rightLen, depois: s.right.length });
    await page.keyboard.press('Control+Z');
    await sleep(200);

    // 6) Keyboard: Ctrl+Shift+R on a single line then save with Ctrl+S (file on disk).
    await page.evaluate((k) => { const v = App.active; v.side = 'left'; v.cur = v.anchor = k; v.scroller.refresh(); }, changed.k);
    await page.keyboard.press('Control+Shift+R');
    await sleep(200);
    await page.keyboard.press('Control+S');
    await sleep(800);
    const onDisk = fs.readFileSync(R, 'utf8');
    check('text: Ctrl+Shift+R + Ctrl+S grava a linha no arquivo', onDisk.includes(leftText) && !onDisk.includes('\r\n'));

    // 7) External change reload (simulate an editor saving the file).
    await sleep(500);
    fs.writeFileSync(R, onDisk.replace('port: 9090', 'port: 7777'));
    await sleep(2500);
    s = await tvState(page);
    check('text: recarrega quando o arquivo muda no disco', s.right.some((l) => l.includes('7777')), s.status.slice(0, 80));

    // 8) Clipboard compare (Ctrl+Shift+V) with CRLF and accents.
    await app.evaluate(({ clipboard }) => clipboard.writeText("'use strict';\r\nconst fs = require('fs');\r\nAção — coração ✓\r\n"));
    await page.evaluate(() => { App.active.side = 'right'; });
    await page.keyboard.press('Control+Shift+V');
    await sleep(600);
    s = await tvState(page);
    check('text: Ctrl+Shift+V compara com a área de transferência (acentos/CRLF)', /Clipboard/.test(s.title) && s.right.some((l) => l === 'Ação — coração ✓'), { title: s.title, linhas: s.right.slice(0, 3) });
    await shot(page, 'w15-text-clipboard');

    check('text: sem erros de console', errors.length === 0, errors);
  } finally { await app.close(); }
}

// The floating button must not hide code even when the lines around the
// selection are long: on long.txt only every 6th line is short.
async function selButtonTests() {
  const d = freshData('long');
  const { app, page, errors } = await launch('long', [path.join(d.L, 'long.txt'), path.join(d.R, 'long.txt')]);
  try {
    for (const side of ['left', 'right']) {
      await page.evaluate(() => App.active.moveTo(0));
      await sleep(150);
      const a = await tvRow(page, side, 0), b = await tvRow(page, side, 3);
      await page.mouse.move(a.x + 60, a.y); await page.mouse.down();
      await page.mouse.move(b.x + 60, b.y, { steps: 5 }); await page.mouse.up();
      await sleep(250);
      const btn = await selButton(page);
      check(`selbtn: linhas longas, seleção à ${side === 'left' ? 'esquerda' : 'direita'}: botão visível sem cobrir texto`,
        btn.vis && /Copy 4 lines/.test(btn.text) && btn.hits.length === 0, btn);
      await shot(page, `w16-text-selbtn-long-${side}`);
      await page.mouse.click(btn.x, btn.y);
      await sleep(250);
      const s = await tvState(page);
      check(`selbtn: clique no botão copia as 4 linhas (${side})`, s.undo === 1 && s.dirty[side === 'left' ? 1 : 0], { undo: s.undo, dirty: s.dirty });
      await page.keyboard.press('Control+Z');
      await sleep(200);
    }
    check('selbtn: sem erros de console', errors.length === 0, errors);
  } finally { await app.close(); }
}

// ------------------------------------------------------------------------
async function crlfLatin1Tests() {
  const d = freshData('enc');
  for (const [file, expect] of [['crlf.txt', (b) => b.includes('\r\n')], ['encoding.txt', (b) => b.includes(Buffer.from([0xe7]))]]) {
    const L = path.join(d.L, file), R = path.join(d.R, file);
    const { app, page, errors } = await launch('enc-' + file, [L, R]);
    try {
      // Edit the left side through F2 and save; encoding/EOL must be preserved.
      await page.evaluate(() => { const v = App.active; v.side = 'left'; v.cur = v.anchor = 0; v.scroller.refresh(); });
      await page.keyboard.press('F2');
      await sleep(200);
      await page.keyboard.press('End');
      await page.keyboard.type(' ç');
      await page.keyboard.press('Enter');
      await sleep(200);
      await page.keyboard.press('Control+S');
      await sleep(700);
      const buf = fs.readFileSync(L);
      check(`save: ${file} mantém ${file === 'crlf.txt' ? 'CRLF' : 'latin1'} após editar (F2) e salvar`, expect(buf), buf.slice(0, 24).toString('hex'));
      if (errors.length) check(`save: ${file} sem erros`, false, errors);
    } finally { await app.close(); }
  }
}

async function hexTests() {
  const d = freshData('hex');
  const { app, page, errors } = await launch('hex', [path.join(d.L, 'logo.bin'), path.join(d.R, 'logo.bin')]);
  try {
    const st = await page.evaluate(() => ({ type: App.active.type }));
    check('hex: logo.bin abre em hex', st.type === 'hex', st);
    await page.keyboard.press('Control+N');
    await sleep(200);
    await shot(page, 'w20-hex');
    check('hex: sem erros', errors.length === 0, errors);
  } finally { await app.close(); }
}

// High-DPI rendering (Windows 125% / 150%).
async function dpiShots() {
  for (const f of ['1.25', '1.5']) {
    const d = freshData('dpi' + f);
    const { app, page } = await launch('dpi' + f, [path.join(d.L, 'src/app.js'), path.join(d.R, 'src/app.js')], [`--force-device-scale-factor=${f}`]);
    try {
      const dpr = await page.evaluate(() => devicePixelRatio);
      if (Math.abs(dpr - Number(f)) >= 0.01 && !WIN) {
        skip(`dpi ${f}`, `devicePixelRatio ${dpr}: este servidor X não aplica --force-device-scale-factor`);
        continue;
      }
      const a = await tvRow(page, 'left', 3), b = await tvRow(page, 'left', 8);
      await page.mouse.move(a.x + 60, a.y); await page.mouse.down(); await page.mouse.move(b.x + 60, b.y, { steps: 5 }); await page.mouse.up();
      await sleep(250);
      const tb = await page.evaluate(() => { const bar = App.active.el.querySelector('.toolbar') || App.active.el.firstElementChild; return { h: bar.getBoundingClientRect().height, sw: bar.scrollWidth, cw: bar.clientWidth }; });
      const btn = await selButton(page);
      check(`dpi ${f}: devicePixelRatio aplicado`, Math.abs(dpr - Number(f)) < 0.01, dpr);
      check(`dpi ${f}: barra de ferramentas sem estouro horizontal`, tb.sw <= tb.cw + 1, tb);
      check(`dpi ${f}: botão flutuante não cobre texto`, btn.vis && btn.hits.length === 0, btn.hits);
      await shot(page, `w30-dpi-${f}`);
    } finally { await app.close(); }
  }
}

async function homeAndSessions() {
  // userData of the folder test should have sessions.json written.
  const sj = path.join(WORK, 'ud-dir', 'sessions.json');
  check('app: sessions.json gravado no userData isolado (--user-data-dir)', fs.existsSync(sj), sj);
}

(async () => {
  for (const [name, fn] of [['folders', folderTests], ['text', textTests], ['selbtn', selButtonTests], ['encoding', crlfLatin1Tests], ['hex', hexTests], ['dpi', dpiShots], ['sessions', homeAndSessions]]) {
    try { await fn(); } catch (e) { check(`${name}: exceção`, false, String(e.stack || e).split('\n').slice(0, 4).join(' | ')); }
  }
  const failed = results.filter((r) => !r.ok), skipped = results.filter((r) => r.skipped);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed${skipped.length ? ` (${skipped.length} skipped)` : ''}`);
  process.exit(failed.length ? 1 : 0);
})();
