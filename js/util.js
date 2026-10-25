export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const r1 = v => Math.round(v * 10) / 10;
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Tiny hyperscript helper: h('button', {class: 'x', onclick}, 'Label', childEl)
export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') for (const [p, val] of Object.entries(v)) p.startsWith('--') ? e.style.setProperty(p, val) : (e.style[p] = val);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function fmtDate(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return 'Heute, ' + time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Gestern, ' + time;
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function pickFile(accept) {
  return new Promise(res => {
    const i = h('input', { type: 'file', accept });
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}

export function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

// Long-press (touch) or right-click → callback(x, y)
export function onContext(el, fn) {
  el.addEventListener('contextmenu', e => { e.preventDefault(); fn(e.clientX, e.clientY); });
  let t;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    t = setTimeout(() => { el._longPressed = true; fn(e.clientX, e.clientY); }, 500);
  });
  const cancel = () => clearTimeout(t);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointermove', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('click', e => { if (el._longPressed) { el._longPressed = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}
