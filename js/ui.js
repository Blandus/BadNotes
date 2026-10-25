import { h, clamp } from './util.js';
import { icon } from './icons.js';

// ---------- Toast ----------
let toastT;
export function toast(msg, ms = 2400) {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT);
  if (ms) toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- Popovers & menus ----------
let current = null;
export function closePopover() { current?.close(); }

// anchor: Element or {x, y}
export function popover(anchor, content, { className = '' } = {}) {
  closePopover();
  const pop = h('div', { class: 'popover ' + className }, content);
  document.body.append(pop);
  const place = () => {
    const a = anchor instanceof Element ? anchor.getBoundingClientRect()
      : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0 };
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const x = clamp(a.left + a.width / 2 - pw / 2, 8, innerWidth - pw - 8);
    let y = a.bottom + 8;
    const above = y + ph > innerHeight - 8;
    if (above) y = Math.max(8, a.top - ph - 8);
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
    pop.style.transformOrigin = `${a.left + a.width / 2 - x}px ${above ? ph : 0}px`;
  };
  place();
  const onDown = e => {
    if (pop.contains(e.target)) return;
    if (anchor instanceof Element && anchor.contains(e.target)) return; // anchor click toggles
    close();
  };
  const onKey = e => { if (e.key === 'Escape') close(); };
  setTimeout(() => { document.addEventListener('pointerdown', onDown, true); document.addEventListener('keydown', onKey); });
  function close() {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    pop.remove();
    if (current === api) current = null;
  }
  const api = { close, el: pop, place, anchor };
  current = api;
  return api;
}

// items: [{label, icon, action, danger, checked, disabled}] or '-'
export function menu(anchor, items, opts) {
  if (current && current.anchor === anchor) return closePopover();
  let p;
  const list = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map(it => it === '-'
    ? h('div', { class: 'menu-sep' })
    : h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', disabled: it.disabled,
      onclick: () => { p.close(); it.action(); },
    },
      h('span', { class: 'menu-label' }, it.label),
      it.checked !== undefined ? h('span', { class: 'menu-icon' }, it.checked ? icon('check', 18) : '')
        : it.swatch ? h('span', { class: 'menu-swatch', style: { background: it.swatch } })
          : it.icon ? h('span', { class: 'menu-icon' }, icon(it.icon, 18)) : '')));
  p = popover(anchor, list, opts);
  return p;
}

// ---------- Sheets (iOS-style modal with Cancel / Title / Done) ----------
export function sheet({ title, body, done = 'Fertig', onDone, cancel = true, className = '' }) {
  return new Promise(resolve => {
    const back = h('div', { class: 'backdrop' });
    const finish = v => {
      document.removeEventListener('keydown', onKey);
      back.classList.add('closing');
      setTimeout(() => back.remove(), 200);
      resolve(v);
    };
    const submit = async () => { const v = onDone ? await onDone() : true; if (v !== false) finish(v); };
    const onKey = e => {
      if (e.key === 'Escape') finish(null);
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submit(); }
    };
    document.addEventListener('keydown', onKey);
    const box = h('div', { class: 'sheet ' + className, role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' },
        cancel ? h('button', { class: 'textbtn', onclick: () => finish(null) }, 'Abbrechen') : h('span'),
        h('div', { class: 'sheet-title' }, title),
        done ? h('button', { class: 'textbtn strong', onclick: submit }, done) : h('span')),
      h('div', { class: 'sheet-body' }, body));
    back.append(box);
    back.addEventListener('pointerdown', e => { if (e.target === back) finish(null); });
    document.body.append(back);
    box.querySelector('input:not([type=color]):not([type=checkbox])')?.focus();
  });
}

// suggestions: tappable chips under the field that fill it in
export async function promptText(title, value = '', placeholder = '', suggestions = []) {
  const input = h('input', { class: 'field', value, placeholder });
  setTimeout(() => input.select());
  const sugg = suggestions.filter(s => s !== value);
  const body = sugg.length ? h('div', { class: 'form' }, input,
    h('div', { class: 'suggest-label' }, 'Vorschläge'),
    h('div', { class: 'suggest-chips' }, sugg.map(s => h('button', {
      class: 'suggest-chip', onclick: () => { input.value = s; input.focus(); input.select(); },
    }, s)))) : input;
  const v = await sheet({ title, body, onDone: () => input.value.trim() || false });
  return v || null;
}

// Small centred alert with two buttons.
export function confirmBox(title, message, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const back = h('div', { class: 'backdrop' });
    const finish = v => { back.classList.add('closing'); setTimeout(() => back.remove(), 200); resolve(v); };
    back.append(h('div', { class: 'alert', role: 'alertdialog' },
      h('div', { class: 'alert-title' }, title),
      message && h('div', { class: 'alert-msg' }, message),
      h('div', { class: 'alert-btns' },
        h('button', { onclick: () => finish(false) }, 'Abbrechen'),
        h('button', { class: danger ? 'danger strong' : 'strong', onclick: () => finish(true) }, okLabel))));
    document.body.append(back);
  });
}

// Segmented control
export function segmented(options, value, onChange) {
  const wrap = h('div', { class: 'segmented' });
  const render = v => {
    wrap.replaceChildren(...options.map(([val, label]) => h('button', {
      class: val === v ? 'active' : '', onclick: () => { render(val); onChange(val); },
    }, label)));
  };
  render(value);
  return wrap;
}

export function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox', class: 'switch' });
  input.checked = !!checked;
  input.onchange = () => onChange(input.checked);
  return h('label', { class: 'toggle-row' }, h('span', {}, label), input);
}
