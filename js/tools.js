// Pointer input on pages: drawing, erasing, lasso selection, shapes, text, laser, gestures.
import { $, h, uid, r1 } from './util.js';
import { icon } from './icons.js';
import { settings, PAGE_W } from './store.js';
import { bbox, unionBox, transformEl, drawStroke, pageH, FONT, LINE_H } from './render.js';
import {
  ed, T, sc, commit, renderEl, elForPage, setZoom, undo, redo, selectTool, renderOptions,
  scrollToPage, currentPage, toggleSearch, PALETTE,
} from './editor.js';
import { toast, popover, closePopover } from './ui.js';

let overlay, octx;
let drawing = null;
const touches = new Map();
let gesture = null;
let clipboard = null;

export function initTools() {
  overlay = $('#overlay');
  octx = overlay.getContext('2d');
  sizeOverlay();
  window.addEventListener('resize', sizeOverlay);
  new ResizeObserver(sizeOverlay).observe(overlay.parentElement);
  sc.addEventListener('pointerdown', onDown);
  sc.addEventListener('pointermove', onMove);
  sc.addEventListener('pointerup', e => onUp(e, true));
  sc.addEventListener('pointercancel', e => onUp(e, false));
  sc.addEventListener('pointerleave', () => { hoverCursor = null; drawOverlay(); });
  sc.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(ed.zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  }, { passive: false });
  document.addEventListener('keydown', onKey);
  document.addEventListener('gesturestart', e => e.preventDefault());
}

function sizeOverlay() {
  const r = overlay.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay();
}

// ---------- Geometry ----------
function toPage(e, el) {
  const r = el.getBoundingClientRect();
  const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
  return [r1((e.clientX - r.left) / r.width * PAGE_W), r1((e.clientY - r.top) / r.height * pageH(el._page)), Math.round(p * 100) / 100];
}
function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  let t = len ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segDist(a, b, c, d) {
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(distToSeg(a, c, d), distToSeg(b, c, d), distToSeg(c, a, b), distToSeg(d, a, b));
}
// Does stroke s come within r of the segment a→b?
function strokeHit(s, a, b, r) {
  const p = s.closed ? [...s.points, s.points[0]] : s.points;
  if (p.length === 1) return distToSeg(p[0], a, b) < r;
  for (let i = 1; i < p.length; i++) if (segDist(p[i - 1], p[i], a, b) < r) return true;
  return false;
}
function pointInPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inBox = (p, b) => p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;

function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const n = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push([r1(a[0] + (b[0] - a[0]) * t), r1(a[1] + (b[1] - a[1]) * t), a[2] + (b[2] - a[2]) * t]);
    }
    out.push(b);
  }
  return out;
}

// Ramer–Douglas–Peucker simplification
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  let max = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) { const d = distToSeg(pts[i], a, b); if (d > max) { max = d; idx = i; } }
  if (max <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

// Turns a rough drawing into a line, polyline, triangle, rectangle, polygon or ellipse.
function recognize(points) {
  const P = points.map(p => [p[0], p[1]]);
  if (P.length < 3) return null;
  let len = 0;
  for (let i = 1; i < P.length; i++) len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
  const xs = P.map(p => p[0]), ys = P.map(p => p[1]);
  const b = { x: Math.min(...xs), y: Math.min(...ys) };
  b.w = Math.max(...xs) - b.x; b.h = Math.max(...ys) - b.y;
  const diag = Math.hypot(b.w, b.h);
  if (diag < 10) return null;
  const s = P[0], e = P[P.length - 1];
  const closed = Math.hypot(e[0] - s[0], e[1] - s[1]) < Math.max(20, len * 0.15);
  if (!closed) {
    const maxDev = Math.max(...P.map(p => distToSeg(p, s, e)));
    if (maxDev < Math.max(6, 0.08 * Math.hypot(e[0] - s[0], e[1] - s[1]))) return { pts: [s, e], closed: false };
    return { pts: rdp(P, Math.max(5, diag * 0.05)), closed: false };
  }
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = Math.max(1, b.w / 2), ry = Math.max(1, b.h / 2);
  const ellipse = () => ({
    pts: Array.from({ length: 72 }, (_, i) => { const a = i / 72 * Math.PI * 2; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; }),
    closed: true,
  });
  const err = P.reduce((a, p) => a + Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1), 0) / P.length;
  if (err < 0.09) return ellipse();
  let v = rdp([...P, P[0]], diag * 0.08).slice(0, -1);
  if (v.length > 3 && Math.hypot(v[0][0] - v[v.length - 1][0], v[0][1] - v[v.length - 1][1]) < diag * 0.1) v = v.slice(0, -1);
  const axis = v.every((p, i) => {
    const q = v[(i + 1) % v.length];
    const ang = Math.abs(Math.atan2(q[1] - p[1], q[0] - p[0])) % (Math.PI / 2);
    return Math.min(ang, Math.PI / 2 - ang) < 0.26;
  });
  if (v.length === 4 && axis) return { pts: [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]], closed: true };
  if (v.length >= 3 && v.length <= 6) return { pts: v, closed: true };
  return ellipse();
}

// ---------- Pointer routing ----------
function onDown(e) {
  if (e.target.closest('.sel-menu, .text-editor')) return;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (settings.fingerDraw && touches.size === 1 && !drawing) return start(e);
    if (drawing?.touch) cancelDrawing();
    startGesture();
    return;
  }
  if (e.button !== 0 || drawing) return;
  start(e);
}

function start(e) {
  const el = e.target.closest('.page');
  if (!el) {
    if (ed.tool === 'lasso') clearSelection();
    if (ed.tool === 'text') finishText();
    return;
  }
  e.preventDefault();
  try { sc.setPointerCapture(e.pointerId); } catch {}
  const idx = ed.pageEls.indexOf(el);
  if (idx >= 0) ed.cur = idx;
  const base = { el, page: el._page, id: e.pointerId, touch: e.pointerType === 'touch' };
  const pt = toPage(e, el);
  ed.busy = true;
  switch (ed.tool) {
    case 'pen': case 'highlighter': case 'shapes': return startStroke(base, pt);
    case 'eraser': return startErase(base, pt, e);
    case 'lasso': return startLasso(base, pt, e);
    case 'text': drawing = { ...base, kind: 'text', pt }; return; // acts on pointerup (keyboard focus needs a tap)
    case 'laser': drawing = { ...base, kind: 'laser', stroke: uid() }; return addLaser(e);
  }
}

function onMove(e) {
  if (drawing && e.pointerId === drawing.id) {
    e.preventDefault();
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    const d = drawing;
    if (d.kind === 'stroke') {
      if (d.straight) d.stroke.points = [d.stroke.points[0], toPage(e, d.el)];
      else for (const ev of evs) d.stroke.points.push(toPage(ev, d.el));
      queueLive();
    } else if (d.kind === 'erase') {
      for (const ev of evs) eraseTo(toPage(ev, d.el));
      d.cursor = [e.clientX, e.clientY]; drawOverlay();
    } else if (d.kind === 'lasso') {
      for (const ev of evs) { d.path.push([ev.clientX, ev.clientY]); d.pagePts.push(toPage(ev, d.el)); }
      drawOverlay();
    } else if (d.kind === 'move' || d.kind === 'resize') {
      transformSelection(toPage(e, d.el));
    } else if (d.kind === 'laser') {
      for (const ev of evs) addLaser(ev);
    }
    return;
  }
  if (e.pointerType === 'touch' && touches.has(e.pointerId) && gesture) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gestureState();
    sc.scrollLeft -= g.cx - gesture.cx;
    sc.scrollTop -= g.cy - gesture.cy;
    gesture.cx = g.cx; gesture.cy = g.cy;
    if (touches.size > 1 && gesture.d > 0) setZoom(gesture.zoom * g.d / gesture.d, g.cx, g.cy);
  } else if (e.pointerType !== 'touch' && ed.tool === 'eraser' && e.target.closest?.('.page')) {
    hoverCursor = [e.clientX, e.clientY]; drawOverlay();
  }
}
let hoverCursor = null;

function onUp(e, ok) {
  if (drawing && e.pointerId === drawing.id) finish(ok);
  if (touches.delete(e.pointerId)) startGesture();
}

function cancelDrawing() {
  const d = drawing; drawing = null; ed.busy = false;
  if (!d) return;
  if (d.kind === 'erase' || d.kind === 'move' || d.kind === 'resize') { d.page.elements = d.before; renderEl(d.el); renderSelection(); }
  else renderEl(d.el);
  drawOverlay();
}

function finish(ok) {
  const d = drawing;
  if (!ok) return cancelDrawing();
  drawing = null; ed.busy = false;
  if (d.kind === 'stroke') {
    let s = d.stroke;
    if (d.shapes) {
      const r = recognize(s.points);
      if (r) s = { ...s, shape: true, closed: r.closed, points: r.pts.map(([x, y]) => [r1(x), r1(y), 0.5]) };
    }
    commit(d.page, [...d.page.elements, s]);
  } else if (d.kind === 'erase') {
    d.page.elements = d.before;
    if (d.work !== d.before) commit(d.page, d.work);
  } else if (d.kind === 'move' || d.kind === 'resize') {
    const next = d.page.elements;
    d.page.elements = d.before;
    if (next !== d.before) commit(d.page, next);
  } else if (d.kind === 'lasso') {
    finishLasso(d);
  } else if (d.kind === 'text') {
    textAt(d.el, d.pt);
  }
  drawOverlay();
}

// ---------- Gestures ----------
function gestureState() {
  const pts = [...touches.values()];
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
  return { cx, cy, d };
}
function startGesture() { gesture = touches.size ? { ...gestureState(), zoom: ed.zoom } : null; }

// ---------- Pen, highlighter, shapes ----------
function startStroke(base, pt) {
  const cfg = T[ed.tool];
  const stroke = {
    id: uid(), type: 'stroke',
    tool: ed.tool === 'highlighter' ? 'highlighter' : 'pen',
    pen: ed.tool === 'pen' ? cfg.pen : 'ball',
    color: cfg.colors[cfg.color], width: cfg.widths[cfg.width], points: [pt],
  };
  // Snapshot of the page so the live stroke can be redrawn on top each frame.
  const c = base.el._canvas, snap = document.createElement('canvas');
  snap.width = c.width; snap.height = c.height;
  if (c.width) snap.getContext('2d').drawImage(c, 0, 0);
  drawing = { ...base, kind: 'stroke', stroke, snap, shapes: ed.tool === 'shapes', straight: ed.tool === 'highlighter' && cfg.straight };
  drawLive();
}
let liveQueued = false;
function queueLive() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => { liveQueued = false; drawLive(); });
}
function drawLive() {
  const d = drawing;
  if (!d || d.kind !== 'stroke') return;
  const c = d.el._canvas;
  if (!c.width) return;
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(d.snap, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const s = c.width / PAGE_W;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  drawStroke(ctx, d.shapes ? { ...d.stroke, pen: 'ball' } : d.stroke);
}

// ---------- Eraser ----------
function startErase(base, pt, e) {
  drawing = { ...base, kind: 'erase', before: base.page.elements, work: base.page.elements, last: pt, r: T.eraser.sizes[T.eraser.size], cursor: [e.clientX, e.clientY] };
  eraseTo(pt);
  drawOverlay();
}
function splitStroke(s, a, b, r) {
  const pts = densify(s.closed ? [...s.points, s.points[0]] : s.points, 3);
  const runs = [];
  let run = [];
  for (const p of pts) {
    if (distToSeg(p, a, b) < r) { if (run.length) runs.push(run); run = []; }
    else run.push(p);
  }
  if (run.length) runs.push(run);
  return runs.filter(x => x.length > 1).map(x => ({ ...s, id: uid(), points: x, closed: false }));
}
function eraseTo(pt) {
  const d = drawing, a = d.last;
  d.last = pt;
  const cfg = T.eraser;
  let hit = false;
  const next = [];
  for (const s of d.work) {
    const r = d.r + (s.width || 0) / 2;
    if (s.type !== 'stroke' || (cfg.hlOnly && s.tool !== 'highlighter') || !strokeHit(s, a, pt, r)) { next.push(s); continue; }
    hit = true;
    if (cfg.mode === 'precise') next.push(...splitStroke(s, a, pt, r));
  }
  if (!hit) return;
  d.work = next;
  d.page.elements = next;
  queueRender(d.el);
}
let renderQueued = null;
function queueRender(el) {
  if (renderQueued) return;
  renderQueued = setTimeout(() => { renderQueued = null; renderEl(el); }, 16);
}

// ---------- Lasso & selection ----------
function startLasso(base, pt, e) {
  if (ed.sel && ed.sel.page === base.page) {
    const box = unionBox(selEls());
    if (e.target.closest('.sel-handle')) { drawing = { ...base, kind: 'resize', before: base.page.elements, box, origin: pt }; return; }
    if (inBox(pt, { x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 })) { drawing = { ...base, kind: 'move', before: base.page.elements, origin: pt }; return; }
  }
  clearSelection();
  drawing = { ...base, kind: 'lasso', path: [[e.clientX, e.clientY]], pagePts: [pt] };
}

function transformSelection(pt) {
  const d = drawing, ids = ed.sel.ids;
  let fn, k = 1;
  if (d.kind === 'move') {
    const dx = pt[0] - d.origin[0], dy = pt[1] - d.origin[1];
    fn = (x, y) => [x + dx, y + dy];
  } else {
    const b = d.box;
    k = Math.max(0.1, Math.max((pt[0] - b.x) / b.w, (pt[1] - b.y) / b.h));
    fn = (x, y) => [b.x + (x - b.x) * k, b.y + (y - b.y) * k];
  }
  d.page.elements = d.before.map(e => ids.has(e.id) ? transformEl(e, fn, k) : e);
  queueRender(d.el);
  renderSelection();
}

function selectable(e) {
  const c = T.lasso;
  return (e.type === 'stroke' && c.strokes) || (e.type === 'image' && c.images) || (e.type === 'text' && c.text);
}

function finishLasso(d) {
  const poly = d.pagePts, page = d.page;
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const tiny = Math.max(...xs) - Math.min(...xs) < 8 && Math.max(...ys) - Math.min(...ys) < 8;
  let ids;
  if (tiny) {
    // A tap selects the topmost element under the finger.
    const hit = [...page.elements].reverse().find(e => selectable(e) && inBox(poly[0], bbox(e)));
    ids = hit ? [hit.id] : [];
  } else {
    ids = page.elements.filter(e => {
      if (!selectable(e)) return false;
      if (e.type === 'stroke') return e.points.filter(p => pointInPoly(p, poly)).length >= Math.max(1, e.points.length * 0.5);
      const b = bbox(e);
      return pointInPoly([b.x + b.w / 2, b.y + b.h / 2], poly);
    }).map(e => e.id);
  }
  selectIds(page, ids);
}

const selEls = () => ed.sel.page.elements.filter(e => ed.sel.ids.has(e.id));
export const hasSelection = () => !!ed.sel;

export function selectIds(page, ids) {
  ed.sel = ids.length ? { page, ids: new Set(ids) } : null;
  renderSelection();
  if (ed.tool === 'lasso') renderOptions();
}
export function clearSelection() {
  const had = !!ed.sel;
  ed.sel = null;
  document.querySelectorAll('.selbox').forEach(n => n.remove());
  if (had && ed.tool === 'lasso') renderOptions();
}
export function renderSelection() {
  document.querySelectorAll('.selbox').forEach(n => n.remove());
  if (!ed.sel) return;
  const els = selEls();
  if (!els.length) { ed.sel = null; return; }
  const pageEl = elForPage(ed.sel.page);
  if (!pageEl) return;
  const b = unionBox(els), ph = pageH(ed.sel.page), pad = 6;
  const btn = (label, ic, fn) => h('button', { title: label, onclick: fn }, icon(ic, 18), h('span', {}, label));
  pageEl.append(h('div', {
    class: 'selbox',
    style: { left: (b.x - pad) / PAGE_W * 100 + '%', top: (b.y - pad) / ph * 100 + '%', width: (b.w + 2 * pad) / PAGE_W * 100 + '%', height: (b.h + 2 * pad) / ph * 100 + '%' },
  },
    h('div', { class: 'sel-menu' + (b.y < 70 ? ' below' : '') },
      els.some(e => e.type !== 'image') ? btn('Farbe', 'palette', e => recolorMenu(e.currentTarget)) : null,
      btn('Ausschneiden', 'cut', cutSelection),
      btn('Kopieren', 'copy', copySelection),
      btn('Duplizieren', 'copy', duplicateSelection),
      btn('Löschen', 'trash', deleteSelection)),
    h('div', { class: 'sel-handle', title: 'Größe ändern' })));
}

function recolorMenu(anchor) {
  const { page, ids } = ed.sel;
  popover(anchor, h('div', { class: 'colorpop' },
    h('div', { class: 'pop-title' }, 'Farbe der Auswahl'),
    h('div', { class: 'palette' }, PALETTE.map(c => h('button', {
      class: 'pal', style: { '--c': c },
      onclick: () => { closePopover(); commit(page, page.elements.map(e => ids.has(e.id) && e.type !== 'image' ? { ...e, color: c } : e)); },
    })))));
}

export function deleteSelection() {
  if (!ed.sel) return;
  const { page, ids } = ed.sel;
  clearSelection();
  commit(page, page.elements.filter(e => !ids.has(e.id)));
}
function copySelection() {
  if (!ed.sel) return;
  clipboard = structuredClone(selEls());
  toast('Kopiert');
}
function cutSelection() { copySelection(); deleteSelection(); }
function placeCopies(page, els, offset) {
  const copies = els.map(e => ({ ...transformEl(e, (x, y) => [x + offset, y + offset]), id: uid() }));
  commit(page, [...page.elements, ...copies]);
  if (ed.tool !== 'lasso') selectTool('lasso');
  selectIds(page, copies.map(c => c.id));
}
function duplicateSelection() { if (ed.sel) placeCopies(ed.sel.page, selEls(), 20); }
function paste() {
  if (!clipboard?.length) return toast('Zwischenablage ist leer');
  placeCopies(currentPage(), structuredClone(clipboard), 20);
}

// ---------- Text ----------
function textAt(pageEl, pt) {
  if (ed.editing) return finishText();
  const page = pageEl._page;
  const hit = [...page.elements].reverse().find(e => e.type === 'text' && inBox(pt, bbox(e)));
  if (hit) return editText(pageEl, hit, false);
  const cfg = T.text;
  editText(pageEl, {
    id: uid(), type: 'text', x: pt[0], y: Math.max(0, pt[1] - cfg.size * 0.65),
    w: Math.max(160, Math.min(560, PAGE_W - pt[0] - 30)), size: cfg.size, color: cfg.colors[cfg.color], text: '',
  }, true);
}

function editText(pageEl, t, isNew) {
  const page = pageEl._page;
  const ta = h('textarea', { class: 'text-editor', spellcheck: 'true', 'aria-label': 'Text' });
  ta.value = t.text;
  const st = {
    page, pageEl, id: t.id, orig: t, el: t, isNew, ta,
    place() {
      const k = st.pageEl.clientWidth / PAGE_W, ph = pageH(page);
      Object.assign(ta.style, {
        left: st.el.x / PAGE_W * 100 + '%', top: st.el.y / ph * 100 + '%', width: st.el.w / PAGE_W * 100 + '%',
        fontSize: st.el.size * k + 'px', lineHeight: LINE_H, color: st.el.color, fontFamily: FONT,
      });
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    },
    setColor(c) { st.el = { ...st.el, color: c }; st.place(); },
    setSize(s) { st.el = { ...st.el, size: s }; st.place(); },
  };
  ed.editing = st;
  pageEl.append(ta);
  st.place();
  ta.addEventListener('input', () => st.place());
  ta.addEventListener('blur', () => finishText());
  ta.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); ta.blur(); } });
  renderEl(pageEl); // hides the canvas copy while editing
  ta.focus();
}

export async function finishText() {
  const st = ed.editing;
  if (!st) return;
  ed.editing = null;
  const text = st.ta.value.replace(/\s+$/, '');
  st.ta.remove();
  const page = st.page, next = { ...st.el, text };
  if (st.isNew) {
    if (text.trim()) commit(page, [...page.elements, next]);
    else renderEl(st.pageEl);
  } else if (!text.trim()) {
    commit(page, page.elements.filter(e => e.id !== st.id));
  } else if (text !== st.orig.text || next.color !== st.orig.color || next.size !== st.orig.size) {
    commit(page, page.elements.map(e => e.id === st.id ? next : e));
  } else renderEl(st.pageEl);
}

// ---------- Laser pointer & overlay ----------
const laser = [];
let laserLoop = false;
function addLaser(e) {
  const r = overlay.getBoundingClientRect();
  laser.push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now(), s: drawing.stroke });
  if (!laserLoop) { laserLoop = true; requestAnimationFrame(tickLaser); }
}
function tickLaser() {
  const now = performance.now();
  while (laser.length && now - laser[0].t > 900 && !(drawing?.kind === 'laser' && laser.length < 3)) laser.shift();
  drawOverlay();
  if (laser.length) requestAnimationFrame(tickLaser); else laserLoop = false;
}

function drawOverlay() {
  if (!octx) return;
  const r = overlay.getBoundingClientRect();
  octx.clearRect(0, 0, r.width, r.height);
  // laser trail
  if (laser.length) {
    const now = performance.now(), color = T.laser.colors[T.laser.color];
    octx.save();
    octx.lineCap = 'round'; octx.lineJoin = 'round'; octx.strokeStyle = color;
    octx.shadowColor = color; octx.shadowBlur = 12;
    for (let i = 1; i < laser.length; i++) {
      const a = laser[i - 1], b = laser[i];
      if (a.s !== b.s) continue;
      octx.globalAlpha = Math.max(0, 1 - (now - b.t) / 900);
      octx.lineWidth = 5;
      octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
    }
    const last = laser[laser.length - 1];
    if (drawing?.kind === 'laser') { octx.globalAlpha = 1; octx.fillStyle = color; octx.beginPath(); octx.arc(last.x, last.y, 6, 0, Math.PI * 2); octx.fill(); }
    octx.restore();
  }
  // lasso path
  if (drawing?.kind === 'lasso' && drawing.path.length > 1) {
    octx.save();
    octx.setLineDash([6, 5]); octx.lineWidth = 1.6; octx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2F7BF5';
    octx.fillStyle = 'rgba(47,123,245,.06)';
    octx.beginPath();
    drawing.path.forEach(([x, y], i) => i ? octx.lineTo(x - r.left, y - r.top) : octx.moveTo(x - r.left, y - r.top));
    octx.closePath(); octx.fill(); octx.stroke();
    octx.restore();
  }
  // eraser cursor
  const cur = drawing?.kind === 'erase' ? drawing.cursor : (ed.tool === 'eraser' ? hoverCursor : null);
  if (cur && ed.pageEls[0]) {
    const k = ed.pageEls[0].clientWidth / PAGE_W;
    const rad = T.eraser.sizes[T.eraser.size] * k;
    octx.save();
    octx.lineWidth = 1.2; octx.strokeStyle = 'rgba(0,0,0,.55)'; octx.fillStyle = 'rgba(255,255,255,.35)';
    octx.beginPath(); octx.arc(cur[0] - r.left, cur[1] - r.top, rad, 0, Math.PI * 2); octx.fill(); octx.stroke();
    octx.restore();
  }
}

// ---------- Keyboard shortcuts ----------
const TOOL_KEYS = { p: 'pen', e: 'eraser', h: 'highlighter', s: 'shapes', l: 'lasso', t: 'text', k: 'laser', i: 'image' };
function onKey(e) {
  if (!ed.doc || $('#editor').hidden) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (document.querySelector('.backdrop')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const handled = () => e.preventDefault();
  if (mod) {
    if (k === 'z') { handled(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { handled(); redo(); }
    else if (k === 'c') { if (ed.sel) { handled(); copySelection(); } }
    else if (k === 'x') { if (ed.sel) { handled(); cutSelection(); } }
    else if (k === 'v') { handled(); paste(); }
    else if (k === 'd') { if (ed.sel) { handled(); duplicateSelection(); } }
    else if (k === 'a') { handled(); selectTool('lasso'); const p = currentPage(); selectIds(p, p.elements.filter(selectable).map(x => x.id)); }
    else if (k === 'f') { handled(); toggleSearch(true); }
    else if (k === '=' || k === '+') { handled(); setZoom(ed.zoom * 1.2); }
    else if (k === '-') { handled(); setZoom(ed.zoom / 1.2); }
    else if (k === '0') { handled(); setZoom(1); }
    return;
  }
  if (TOOL_KEYS[k]) { handled(); selectTool(TOOL_KEYS[k]); }
  else if (k === 'delete' || k === 'backspace') { if (ed.sel) { handled(); deleteSelection(); } }
  else if (k === 'escape') clearSelection();
  else if (k === 'pagedown' || k === 'arrowright') { handled(); scrollToPage(Math.min(ed.cur + 1, ed.doc.pages.length - 1)); }
  else if (k === 'pageup' || k === 'arrowleft') { handled(); scrollToPage(Math.max(ed.cur - 1, 0)); }
}
