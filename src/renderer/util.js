'use strict';
// Small DOM helpers shared by every view.

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c !== null && c !== undefined && c !== false) el.append(c);
  }
  return el;
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtSize(n) {
  return n.toLocaleString('en-US');
}

function fmtDate(ms) {
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// "Ctrl+Shift+N"-style name of a keyboard event.
function keyCombo(e) {
  const names = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Delete: 'Del', Escape: 'Esc', Backspace: 'BkSp', Insert: 'Ins', ' ': 'Space' };
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else key = names[key] || key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + key;
}

// Toolbar from [[label, command, tooltip], '|', ...]; returns the element and a
// map of buttons so views can toggle their pressed state.
function buildToolbar(spec, run) {
  const buttons = {};
  const bar = h('div', { class: 'toolbar' });
  for (const s of spec) {
    if (s === '|') { bar.append(h('span', { class: 'tb-sep' })); continue; }
    const [label, command, title] = s;
    const b = h('button', { class: 'tb-btn', title: title || '', tabIndex: -1, onclick: () => run(command) }, label);
    buttons[command] = b;
    bar.append(b);
  }
  return { bar, buttons };
}

// One side's path box with a browse button.
function buildPathBox(placeholder, onEnter, onBrowse, extra) {
  const input = h('input', {
    class: 'path-input', type: 'text', placeholder, spellcheck: false,
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(input.value.trim()); } },
  });
  const box = h('div', { class: 'path-box' }, input, extra || null,
    h('button', { class: 'tb-btn', title: 'Browse...', tabIndex: -1, onclick: onBrowse }, '…'));
  return { box, input };
}

// Virtual vertical scrolling: a fixed-height viewport, a separate native
// scrollbar, and a callback that draws only the visible rows.
class VScroller {
  constructor(viewport, bar, rowH, onRender) {
    this.viewport = viewport;
    this.bar = bar;
    this.rowH = rowH;
    this.onRender = onRender;
    this.count = 0;
    this.spacer = h('div', { class: 'vspacer' });
    bar.append(this.spacer);
    bar.addEventListener('scroll', () => this.refresh());
    viewport.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.shiftKey) return;
      bar.scrollTop += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    new ResizeObserver(() => this.refresh()).observe(viewport);
  }

  get pageRows() {
    return Math.max(1, Math.floor(this.viewport.clientHeight / this.rowH) - 1);
  }

  setCount(n) {
    this.count = n;
    this.spacer.style.height = n * this.rowH + 'px';
    this.refresh();
  }

  refresh() {
    const top = this.bar.scrollTop;
    const first = Math.floor(top / this.rowH);
    const n = Math.ceil(this.viewport.clientHeight / this.rowH) + 1;
    this.first = first;
    this.onRender(first, Math.min(n, Math.max(0, this.count - first)), top - first * this.rowH);
  }

  ensureVisible(k, center) {
    const top = this.bar.scrollTop, viewH = this.viewport.clientHeight, y = k * this.rowH;
    if (center && (y < top || y + this.rowH > top + viewH)) this.bar.scrollTop = Math.max(0, y - viewH / 3);
    else if (y < top) this.bar.scrollTop = y;
    else if (y + this.rowH > top + viewH) this.bar.scrollTop = y + this.rowH - viewH;
    this.refresh();
  }
}

// Follows a drag that started with the left button on a VScroller list until
// the button is released: onMove gets the row under the pointer (clamped to
// the list), the row boundary nearest to it and the pointer position. Above
// or below `area` the list keeps scrolling, faster the further out the
// pointer is. onEnd runs once at the end; returns a function that ends it.
function dragRows(area, scroller, onMove, onEnd) {
  let x = 0, y = null, done = false;
  const update = () => {
    if (y === null) return;
    const r = area.getBoundingClientRect(), bottom = r.top + area.clientHeight;
    const out = y < r.top ? y - r.top : y > bottom ? y - bottom : 0;
    if (out) scroller.bar.scrollTop += Math.sign(out) * Math.max(2, Math.round(Math.abs(out) / 3));
    const pos = (Math.max(r.top, Math.min(bottom - 1, y)) - r.top + scroller.bar.scrollTop) / scroller.rowH;
    const last = Math.max(0, scroller.count - 1);
    onMove({ row: Math.max(0, Math.min(last, Math.floor(pos))), gap: Math.max(0, Math.min(scroller.count, Math.round(pos))), x, y });
  };
  const move = (e) => {
    if (!(e.buttons & 1)) { stop(); return; }
    x = e.clientX;
    y = e.clientY;
    update();
  };
  const timer = setInterval(update, 30);
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('mouseup', stop, true);
    window.removeEventListener('blur', stop);
    if (onEnd) onEnd();
  };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseup', stop, true);
  window.addEventListener('blur', stop);
  return stop;
}

// Popup menu at a mouse position. items: [[label, shortcut, run, disabled], '|'].
// Closes on a pick, a click elsewhere, a key, a scroll or losing the window.
const ContextMenu = {
  el: null,

  show(x, y, items) {
    ContextMenu.close();
    const menu = h('div', { class: 'ctx-menu' }, items.map((it) => {
      if (it === '|') return h('div', { class: 'ctx-sep' });
      const [label, key, run, disabled] = it;
      return h('div', {
        class: 'ctx-item' + (disabled ? ' disabled' : ''),
        onmousedown: (e) => e.stopPropagation(),
        onclick: () => { if (disabled) return; ContextMenu.close(); run(); },
      }, h('span', { class: 'ctx-label' }, label), h('span', { class: 'ctx-key' }, key || ''));
    }));
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(0, Math.min(x, window.innerWidth - r.width - 2)) + 'px';
    menu.style.top = Math.max(0, Math.min(y, window.innerHeight - r.height - 2)) + 'px';
    ContextMenu.el = menu;
    document.addEventListener('mousedown', ContextMenu.close, true);
    document.addEventListener('keydown', ContextMenu.onKey, true);
    document.addEventListener('wheel', ContextMenu.close, true);
    window.addEventListener('blur', ContextMenu.close);
  },

  onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
    ContextMenu.close();
  },

  close(e) {
    if (!ContextMenu.el || (e && e.type === 'mousedown' && ContextMenu.el.contains(e.target))) return;
    ContextMenu.el.remove();
    ContextMenu.el = null;
    document.removeEventListener('mousedown', ContextMenu.close, true);
    document.removeEventListener('keydown', ContextMenu.onKey, true);
    document.removeEventListener('wheel', ContextMenu.close, true);
    window.removeEventListener('blur', ContextMenu.close);
  },
};

const Modal = {
  open: false,
  // Closes the open dialog as if the button with this value was chosen.
  close: () => {},

  // buttons: [[label, value, isDefault]]; resolves with the chosen value, or
  // null when dismissed.
  show(title, body, buttons) {
    return new Promise((resolve) => {
      const root = document.getElementById('modal-root');
      const done = (value) => {
        root.replaceChildren();
        Modal.open = false;
        Modal.close = () => {};
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const def = buttons.find((b) => b[2]) || buttons[0];
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); done(def[1]); }
      };
      const btns = buttons.map(([label, value, isDef]) => h('button', { class: 'dlg-btn' + (isDef ? ' default' : ''), onclick: () => done(value) }, label));
      const dlg = h('div', { class: 'dlg' }, h('div', { class: 'dlg-title' }, title), h('div', { class: 'dlg-body' }, body), h('div', { class: 'dlg-buttons' }, btns));
      root.replaceChildren(h('div', { class: 'dlg-backdrop' }, dlg));
      Modal.open = true;
      Modal.close = done;
      document.addEventListener('keydown', onKey, true);
      const focus = dlg.querySelector('input, select') || btns[buttons.indexOf(def)];
      focus.focus();
      if (focus.select) focus.select();
    });
  },

  message(title, text) {
    return Modal.show(title, h('div', { class: 'dlg-text' }, text), [['OK', true, true]]);
  },

  confirm(title, text, okLabel) {
    return Modal.show(title, h('div', { class: 'dlg-text' }, text), [[okLabel || 'OK', true, true], ['Cancel', null]]);
  },

  async prompt(title, label, value) {
    const input = h('input', { type: 'text', class: 'dlg-input', value: value || '', spellcheck: false });
    const ok = await Modal.show(title, h('label', { class: 'dlg-field' }, label, input), [['OK', true, true], ['Cancel', null]]);
    return ok ? input.value : null;
  },

  // fields: [{key, label, type: 'check'|'text'|'number'|'select'|'heading', options}]
  async form(title, fields, values) {
    const controls = {};
    const body = h('div', { class: 'dlg-form' }, fields.map((f) => {
      if (f.type === 'heading') return h('div', { class: 'dlg-heading' }, f.label);
      let c;
      if (f.type === 'check') {
        c = h('input', { type: 'checkbox', checked: !!values[f.key] });
        controls[f.key] = () => c.checked;
        return h('label', { class: 'dlg-check' }, c, f.label);
      }
      if (f.type === 'select') {
        c = h('select', { class: 'dlg-input' }, f.options.map(([v, text]) => h('option', { value: v, selected: values[f.key] === v }, text)));
        controls[f.key] = () => c.value;
      } else {
        c = h('input', { type: f.type, class: 'dlg-input', value: values[f.key], spellcheck: false });
        controls[f.key] = () => (f.type === 'number' ? Number(c.value) || 0 : c.value);
      }
      return h('label', { class: 'dlg-field' }, f.label, c);
    }));
    const ok = await Modal.show(title, body, [['OK', true, true], ['Cancel', null]]);
    if (!ok) return null;
    const out = {};
    for (const [k, get] of Object.entries(controls)) out[k] = get();
    return out;
  },
};
