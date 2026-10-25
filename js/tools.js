// Pointer input on pages: drawing, erasing, lasso selection, shapes, text, laser, gestures.
import { $, h, uid, r1 } from './util.js';
import { icon } from './icons.js';
import { settings, PAGE_W } from './store.js';
import { bbox, unionBox, transformEl, drawStroke, pageH, renderPage, FONT, LINE_H, pieceWidth } from './render.js';
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
  ink = $('#ink');
  ictx = ink.getContext('2d', { desynchronized: true });
  const resize = () => { sizeOverlay(); sizeInk(); };
  resize();
  window.addEventListener('resize', resize);
  new ResizeObserver(resize).observe(overlay.parentElement);
  // Ink is in screen coordinates; a pending finished stroke would drift when scrolling.
  sc.addEventListener('scroll', () => { if (pendingInk && !drawing) { pendingInk = 0; clearInk(); } });
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
  // Stop iOS from running its own touch gestures (scroll, selection, palm handling) on the
  // canvas area: those make Safari cancel the pencil's pointer mid-stroke. Scrolling and
  // zooming are done by our own pointer handling. Buttons inside pages keep working.
  const blockNative = e => { if (!e.target.closest('button, textarea, input, .sel-menu, .lasso-hint, .shape-handle')) e.preventDefault(); };
  sc.addEventListener('touchstart', blockNative, { passive: false });
  sc.addEventListener('touchmove', blockNative, { passive: false });
}

// Time of the last pen activity: touches shortly after it are the writing hand, not gestures.
let lastPen = 0;
const palmLikely = () => (drawing && !drawing.touch) || performance.now() - lastPen < 600;

function sizeOverlay() {
  const r = overlay.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay();
}

// ---------- Geometry ----------
// rect: the page's bounding box, cached for the duration of a stroke (reading layout per event is slow)
// raw = true skips rounding (used for pen input, which is smoothed before it is stored)
function toPage(e, el, r = el.getBoundingClientRect(), raw = false) {
  const p = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
  const x = (e.clientX - r.left) / r.width * PAGE_W, y = (e.clientY - r.top) / r.height * pageH(el._page);
  return raw ? [x, y, p] : [r1(x), r1(y), Math.round(p * 100) / 100];
}

// Input smoothing. Pointer positions arrive in whole screen pixels; when zoomed out one
// pixel is a large step on the page, so a raw stroke is a staircase that stays visible
// when zooming in later. Points are filtered (exponential smoothing) and points closer
// than ~0.6 screen px are dropped, so the stored stroke is a smooth curve.
// Stabilisation (0..1) lowers the filter factor: 0 → 0.45 (light), 1 → 0.08 (very steady, more lag).
function addPoint(d, raw) {
  const a = 0.45 - 0.37 * d.smooth;
  const f = d.filt ? d.filt.map((v, i) => v + (raw[i] - v) * a) : raw;
  d.filt = f;
  d.lastRaw = raw;
  const p = d.stroke.points, last = p[p.length - 1];
  const minDist = 0.6 * PAGE_W / d.rect.width;
  if (Math.hypot(f[0] - last[0], f[1] - last[1]) < minDist) return;
  p.push([r1(f[0]), r1(f[1]), Math.round(f[2] * 100) / 100]);
}
// On lift-off: catch up to the real end point, then a light [1,2,1] pass over the interior.
function finishPoints(d) {
  const p = d.stroke.points;
  if (d.lastRaw && Math.hypot(d.lastRaw[0] - p[p.length - 1][0], d.lastRaw[1] - p[p.length - 1][1]) > 0.6 * PAGE_W / d.rect.width) {
    p.push([r1(d.lastRaw[0]), r1(d.lastRaw[1]), Math.round(d.lastRaw[2] * 100) / 100]);
  }
  if (p.length < 4) return p;
  let pts = p;
  for (let pass = 0; pass < 2 + Math.round(d.smooth * 4); pass++) {
    pts = pts.map((q, i) => i === 0 || i === pts.length - 1 ? q : [
      r1((pts[i - 1][0] + 2 * q[0] + pts[i + 1][0]) / 4),
      r1((pts[i - 1][1] + 2 * q[1] + pts[i + 1][1]) / 4),
      Math.round((pts[i - 1][2] + 2 * q[2] + pts[i + 1][2]) / 4 * 100) / 100,
    ]);
  }
  return pts;
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
  if (e.target.closest('.sel-menu, .text-editor, .lasso-hint')) return;
  removeLassoHint();
  // Shape corner handles can be dragged with pen, finger or mouse.
  const handle = e.target.closest('.shape-handle');
  if (handle && !drawing) return startVertexDrag(e, handle);
  hideShapeHandles();
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A hand resting while (or right after) writing must not tap, scroll or zoom.
    tap = touches.size === 1 && !palmLikely() ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() } : null;
    if (settings.fingerDraw && touches.size === 1 && !drawing) return start(e);
    if (drawing?.touch) cancelDrawing();
    startGesture();
    return;
  }
  if (e.pointerType === 'pen') lastPen = performance.now();
  // A new pencil contact while the previous stroke never got its "up": keep that stroke.
  if (drawing && !drawing.touch && e.pointerType === 'pen' && drawing.id !== e.pointerId) finish(true);
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
  const rect = el.getBoundingClientRect();
  const base = { el, page: el._page, id: e.pointerId, touch: e.pointerType === 'touch', rect, stage: ink.parentElement.getBoundingClientRect() };
  const pt = toPage(e, el, rect);
  ed.busy = true;
  switch (ed.tool) {
    case 'pen': case 'highlighter': case 'shapes': return startStroke(base, pt);
    case 'eraser': return startErase(base, pt, e);
    case 'lasso': return startLasso(base, pt, e);
    case 'text': drawing = { ...base, kind: 'text', pt }; return; // acts on pointerup (keyboard focus needs a tap)
    case 'laser': drawing = { ...base, kind: 'laser', stroke: uid() }; return addLaser(e);
    case 'screenshot': drawing = { ...base, kind: 'shot', from: [e.clientX, e.clientY], to: [e.clientX, e.clientY] }; return;
  }
}

function onMove(e) {
  if (drawing && e.pointerId === drawing.id) {
    e.preventDefault();
    if (e.pointerType === 'pen') lastPen = performance.now();
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    const d = drawing;
    if (d.kind === 'stroke') {
      if (d.straight) d.stroke.points = [d.stroke.points[0], toPage(e, d.el, d.rect)];
      else if (!d.snapped) for (const ev of evs) addPoint(d, toPage(ev, d.el, d.rect, true));
      if (!d.snapped) { queueLive(); watchHold(d, e); }
      else if (d.snapped.pts.length === 2 && !d.snapped.closed) {
        // Snapped line: keep holding and move to place the end point.
        const p = toPage(e, d.el, d.rect);
        d.snapped.pts[1] = snapAngle(d.snapped.pts[0], p);
        clearInk(); inkTransform(d);
        drawStroke(ictx, toShape(d.stroke, d.snapped));
      }
    } else if (d.kind === 'erase') {
      for (const ev of evs) eraseTo(toPage(ev, d.el, d.rect));
      d.cursor = [e.clientX, e.clientY]; drawOverlay();
    } else if (d.kind === 'lasso') {
      for (const ev of evs) { d.path.push([ev.clientX, ev.clientY]); d.pagePts.push(toPage(ev, d.el)); }
      drawOverlay();
    } else if (d.kind === 'move' || d.kind === 'resize') {
      transformSelection(toPage(e, d.el));
    } else if (d.kind === 'laser') {
      for (const ev of evs) addLaser(ev);
    } else if (d.kind === 'shot') {
      d.to = [e.clientX, e.clientY]; drawOverlay();
    } else if (d.kind === 'vertex') {
      moveVertex(d, toPage(e, d.el, d.rect));
    }
    return;
  }
  if (e.pointerType === 'touch' && touches.has(e.pointerId) && gesture) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (palmLikely()) { startGesture(); return; } // resting hand: don't move the page under the pen
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
  if (e.pointerType === 'pen') lastPen = performance.now();
  // Safari cancels the pencil's pointer when it thinks the palm started a gesture; the ink
  // drawn up to that point is real, so a cancelled pen stroke is kept, not thrown away.
  if (drawing && e.pointerId === drawing.id) finish(ok || (drawing.kind === 'stroke' && !drawing.touch));
  if (touches.delete(e.pointerId)) startGesture();
  if (ok && e.pointerType === 'touch') detectDoubleTap(e);
}

// Finger double-tap toggles pen ↔ eraser. (The Apple Pencil's own double-tap is only
// delivered to native apps, not to Safari/web apps, so this is the closest substitute.)
let tap = null, lastTap = null;
function detectDoubleTap(e) {
  const t = tap; tap = null;
  if (!t || t.id !== e.pointerId || settings.fingerDraw || touches.size) return;
  const now = performance.now();
  if (now - t.t > 250 || Math.hypot(e.clientX - t.x, e.clientY - t.y) > 12) { lastTap = null; return; }
  showShapeHandlesAt(e.clientX, e.clientY);
  if (lastTap && now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 60) {
    lastTap = null;
    togglePenEraser();
  } else lastTap = { x: e.clientX, y: e.clientY, t: now };
}
let toolBeforeEraser = 'pen';
export function togglePenEraser() {
  if (ed.tool === 'eraser') selectTool(toolBeforeEraser);
  else { toolBeforeEraser = ed.tool; selectTool('eraser'); }
  toast(ed.tool === 'eraser' ? 'Radierer' : { pen: 'Stift', highlighter: 'Textmarker', shapes: 'Formen' }[ed.tool] || 'Werkzeug gewechselt', 900);
}

// Snaps the end point b to a perfect 0°/45°/90°/… angle around a when within 6° of it.
const SNAP_DEG = 6;
function snapAngle(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (len < 1) return [b[0], b[1]];
  const ang = Math.atan2(dy, dx), step = Math.PI / 4;
  const target = Math.round(ang / step) * step;
  if (Math.abs(ang - target) > SNAP_DEG * Math.PI / 180) return [b[0], b[1]];
  return [r1(a[0] + Math.cos(target) * len), r1(a[1] + Math.sin(target) * len)];
}

// ---------- Shape corner handles ----------
// A finger tap on a shape shows its corner points; dragging one moves it.
// Polygons and lines: one handle per vertex. Ellipses: four corners of their bounding box.
let handles = null; // { el, page, id }
const isEllipse = s => s.closed && s.points.length > 12;
function shapeCorners(s) {
  if (!isEllipse(s)) return s.points.map(p => [p[0], p[1]]);
  const xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}
function hideShapeHandles() {
  if (!handles) return;
  handles.el.querySelectorAll('.shape-handle').forEach(n => n.remove());
  handles = null;
}
function renderShapeHandles() {
  if (!handles) return;
  const { el, page, id } = handles;
  el.querySelectorAll('.shape-handle').forEach(n => n.remove());
  const s = page.elements.find(e => e.id === id);
  if (!s) { handles = null; return; }
  const ph = pageH(page);
  shapeCorners(s).forEach(([x, y], i) => el.append(h('div', {
    class: 'shape-handle', 'data-i': i, style: { left: x / PAGE_W * 100 + '%', top: y / ph * 100 + '%' },
  })));
}
function showShapeHandlesAt(cx, cy) {
  const el = document.elementFromPoint(cx, cy)?.closest('.page');
  if (!el) return;
  const pt = toPage({ clientX: cx, clientY: cy }, el);
  const s = [...el._page.elements].reverse().find(e => e.type === 'stroke' && e.shape && strokeHit(e, pt, pt, e.width / 2 + 14));
  if (!s) return;
  handles = { el, page: el._page, id: s.id };
  renderShapeHandles();
}
function startVertexDrag(e, handle) {
  e.preventDefault();
  try { sc.setPointerCapture(e.pointerId); } catch {}
  const { el, page, id } = handles;
  drawing = {
    kind: 'vertex', el, page, id: e.pointerId, shapeId: id, idx: +handle.dataset.i,
    rect: el.getBoundingClientRect(), before: page.elements, touch: false,
  };
  ed.busy = true;
}
function moveVertex(d, pt) {
  const s = d.before.find(e => e.id === d.shapeId);
  let points;
  if (isEllipse(s)) {
    // Opposite corner stays fixed; the ellipse is refitted into the new box.
    const c = shapeCorners(s), fixed = c[(d.idx + 2) % 4];
    const x0 = Math.min(fixed[0], pt[0]), x1 = Math.max(fixed[0], pt[0]), y0 = Math.min(fixed[1], pt[1]), y1 = Math.max(fixed[1], pt[1]);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(2, (x1 - x0) / 2), ry = Math.max(2, (y1 - y0) / 2);
    points = s.points.map((_, i) => { const a = i / s.points.length * Math.PI * 2; return [r1(cx + rx * Math.cos(a)), r1(cy + ry * Math.sin(a)), 0.5]; });
  } else {
    // Lines snap to 0°/45°/90° relative to their other end point.
    const q = s.points.length === 2 && !s.closed ? snapAngle(s.points[1 - d.idx], pt) : pt;
    points = s.points.map((p, i) => i === d.idx ? [q[0], q[1], p[2]] : p);
  }
  d.page.elements = d.before.map(e => e.id === d.shapeId ? { ...e, points } : e);
  queueRender(d.el);
  renderShapeHandles();
}

// ---------- Pen gestures ----------
const toShape = (s, r) => ({ ...s, shape: true, closed: r.closed, points: r.pts.map(([x, y]) => [r1(x), r1(y), 0.5]) });

// "Zeichnen und Halten": holding the pen still for 0.5 s at the end of a stroke snaps it to a shape.
function watchHold(d, e) {
  const tool = d.stroke.tool;
  if (!T.pen.drawHold || d.straight || d.shapes || !(tool === 'pen' || tool === 'highlighter')) return;
  if (d.holdAt && Math.hypot(e.clientX - d.holdAt[0], e.clientY - d.holdAt[1]) < 4) return; // still holding
  d.holdAt = [e.clientX, e.clientY];
  clearTimeout(d.holdT);
  d.holdT = setTimeout(() => {
    if (drawing !== d || d.stroke.points.length < 6) return;
    const r = recognize(d.stroke.points);
    if (!r) return;
    d.snapped = r;
    clearInk(); pendingInk = 0;
    inkTransform(d);
    drawStroke(ictx, toShape(d.stroke, r));
  }, 500);
}

// A scribble: many back-and-forth sweeps along its main axis, each spanning much of its extent.
// Cursive handwriting reverses too, but in small loops, so it fails the sweep-length test.
function isScribble(pts) {
  if (pts.length < 12) return false;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys);
  const ax = w >= hh ? 0 : 1, extent = Math.max(w, hh);
  if (extent < 15) return false;
  const turns = [pts[0][ax]];
  let dir = 0;
  for (let i = 1; i < pts.length; i++) {
    const dv = pts[i][ax] - pts[i - 1][ax];
    if (Math.abs(dv) < 0.5) continue;
    const s = Math.sign(dv);
    if (dir && s !== dir) turns.push(pts[i - 1][ax]);
    dir = s;
  }
  turns.push(pts[pts.length - 1][ax]);
  if (turns.length < 6) return false; // at least 5 reversals
  const sweeps = turns.slice(1).map((v, i) => Math.abs(v - turns[i])).sort((a, b) => a - b);
  return sweeps[Math.floor(sweeps.length / 2)] >= extent * 0.45;
}

// Strokes touched by the scribble whose centre lies inside the scribble's area.
function scribbleTargets(page, s) {
  const b = bbox(s), pad = 10, hits = new Set();
  const segs = s.points.slice(1).map((p, i) => [s.points[i], p]);
  for (const e of page.elements) {
    if (e.type !== 'stroke') continue;
    if (!T.pen.scribbleAll && (e.shape || e.tool === 'highlighter')) continue;
    const eb = bbox(e), c = [eb.x + eb.w / 2, eb.y + eb.h / 2];
    if (c[0] < b.x - pad || c[0] > b.x + b.w + pad || c[1] < b.y - pad || c[1] > b.y + b.h + pad) continue;
    if (segs.some(([a, z]) => strokeHit(e, a, z, e.width / 2 + 3))) hits.add(e.id);
  }
  return hits;
}

// After a closed loop around existing content, show "Auswählen" for a few seconds.
let lassoHint = null;
function removeLassoHint() { if (lassoHint) { clearTimeout(lassoHint.t); lassoHint.el.remove(); lassoHint = null; } }
function offerCircleLasso(d, s) {
  const p = s.points;
  let len = 0;
  for (let i = 1; i < p.length; i++) len += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  if (len < 150 || Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) > Math.max(25, len * 0.12)) return;
  const ids = d.page.elements.filter(e => {
    if (e.id === s.id || !selectable(e)) return false;
    if (e.type === 'stroke') return e.points.filter(q => pointInPoly(q, p)).length >= Math.max(1, e.points.length * 0.7);
    const eb = bbox(e);
    return pointInPoly([eb.x + eb.w / 2, eb.y + eb.h / 2], p);
  }).map(e => e.id);
  if (!ids.length) return;
  removeLassoHint();
  const b = bbox(s), ph = pageH(d.page);
  const el = h('button', {
    class: 'lasso-hint', style: { left: (b.x + b.w / 2) / PAGE_W * 100 + '%', top: b.y / ph * 100 + '%' },
    onclick: () => {
      removeLassoHint();
      // The loop was only a selection gesture: remove it, then select what it enclosed.
      commit(d.page, d.page.elements.filter(e => e.id !== s.id));
      selectTool('lasso');
      selectIds(d.page, ids);
    },
  }, icon('lasso', 16), 'Auswählen');
  d.el.append(el);
  lassoHint = { el, t: setTimeout(removeLassoHint, 4000) };
}

function cancelDrawing() {
  const d = drawing; drawing = null; ed.busy = false;
  if (!d) return;
  clearTimeout(d.holdT);
  if (d.kind === 'erase' || d.kind === 'move' || d.kind === 'resize' || d.kind === 'vertex') { d.page.elements = d.before; renderEl(d.el); renderSelection(); renderShapeHandles(); }
  else if (d.kind === 'stroke') { if (!pendingInk) clearInk(); }
  else renderEl(d.el);
  drawOverlay();
}

function finish(ok) {
  const d = drawing;
  if (!ok) return cancelDrawing();
  drawing = null; ed.busy = false;
  if (d.kind === 'stroke') {
    clearTimeout(d.holdT);
    let s = d.straight ? d.stroke : { ...d.stroke, points: finishPoints(d) };
    const snap = d.snapped || (d.shapes && recognize(s.points));
    if (snap) s = toShape(s, snap);
    if (snap) clearInk(); // the snapped shape differs from the rough live stroke
    // Pen gestures: scribble over something to erase it
    if (!snap && s.tool === 'pen' && !d.shapes && T.pen.scribble && isScribble(s.points)) {
      const victims = scribbleTargets(d.page, s);
      if (victims.size) {
        pendingInk++;
        commit(d.page, d.page.elements.filter(e => !victims.has(e.id))).then(inkCommitted);
        drawOverlay();
        return;
      }
    }
    pendingInk++;
    commit(d.page, [...d.page.elements, s]).then(inkCommitted);
    // Pen gestures: circling something offers to select it
    if (!snap && s.tool === 'pen' && !d.shapes && T.pen.circleLasso) offerCircleLasso(d, s);
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
  } else if (d.kind === 'shot') {
    screenshot(d);
  } else if (d.kind === 'vertex') {
    const next = d.page.elements;
    d.page.elements = d.before;
    if (next !== d.before) commit(d.page, next);
    renderShapeHandles();
  }
  drawOverlay();
}

// ---------- Screenshot ----------
// Drag a rectangle on a page (or tap for the whole page); the area is rendered from the
// page data at high resolution, then offered for copying, sharing (iPad: "Bild sichern") or download.
async function screenshot(d) {
  const ph = pageH(d.page);
  const a = toPage({ clientX: d.from[0], clientY: d.from[1] }, d.el, d.rect);
  const b = toPage({ clientX: d.to[0], clientY: d.to[1] }, d.el, d.rect);
  let x = Math.max(0, Math.min(a[0], b[0])), y = Math.max(0, Math.min(a[1], b[1]));
  let w = Math.min(PAGE_W, Math.max(a[0], b[0])) - x, hh = Math.min(ph, Math.max(a[1], b[1])) - y;
  if (w < 10 || hh < 10) { x = 0; y = 0; w = PAGE_W; hh = ph; } // tap → whole page
  const s = 2.5;
  const full = document.createElement('canvas');
  full.width = Math.round(PAGE_W * s); full.height = Math.round(ph * s);
  await renderPage(full.getContext('2d'), d.page, s);
  const out = document.createElement('canvas');
  out.width = Math.round(w * s); out.height = Math.round(hh * s);
  out.getContext('2d').drawImage(full, x * s, y * s, w * s, hh * s, 0, 0, out.width, out.height);
  const blob = await new Promise(res => out.toBlob(res, 'image/png'));
  const name = `${(ed.doc.name || 'Notiz').replace(/[\\/:*?"<>|]/g, '_')} – Screenshot.png`;
  const file = new File([blob], name, { type: 'image/png' });

  const item = (label, ic, fn) => h('button', { class: 'menu-item', onclick: async () => { closePopover(); try { await fn(); } catch (err) { if (err.name !== 'AbortError') toast('Nicht möglich: ' + err.message, 3000); } } },
    h('span', { class: 'menu-label' }, label), h('span', { class: 'menu-icon' }, icon(ic, 18)));
  const preview = h('img', { class: 'shot-preview', src: URL.createObjectURL(blob), alt: 'Screenshot' });
  popover({ x: d.to[0], y: d.to[1] }, h('div', { class: 'menu shot-menu' },
    preview,
    window.ClipboardItem ? item('Kopieren', 'copy', async () => { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Screenshot kopiert'); }) : null,
    navigator.canShare?.({ files: [file] }) ? item('Teilen / Bild sichern', 'share', () => navigator.share({ files: [file] })) : null,
    item('Herunterladen', 'pdf', () => { const l = h('a', { href: preview.src, download: name }); l.click(); })));
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
// Live strokes go onto the screen-sized #ink canvas at full device resolution.
// Pen strokes are drawn incrementally (only the new pieces each frame), so the cost
// per frame no longer depends on the page size or the stroke length. The finished
// stroke is committed to the page canvas and the ink layer is cleared once that has rendered.
let ink, ictx;
let pendingInk = 0; // committed strokes still visible on the ink layer

function sizeInk() {
  const r = ink.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  ink.width = Math.round(r.width * dpr); ink.height = Math.round(r.height * dpr);
  ink._dpr = dpr;
}
function inkTransform(d) {
  // page units → ink canvas pixels
  const s = d.rect.width / PAGE_W * ink._dpr;
  ictx.setTransform(s, 0, 0, s, (d.rect.left - d.stage.left) * ink._dpr, (d.rect.top - d.stage.top) * ink._dpr);
}
function clearInk() {
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.clearRect(0, 0, ink.width, ink.height);
}

function startStroke(base, pt) {
  const cfg = T[ed.tool];
  const stroke = {
    id: uid(), type: 'stroke',
    tool: ed.tool === 'highlighter' ? 'highlighter' : 'pen',
    pen: ed.tool === 'pen' ? cfg.pen : 'ball',
    color: cfg.colors[cfg.color], width: cfg.widths[cfg.width], points: [pt],
    ...(ed.tool === 'pen' ? { sharp: cfg.sharp, press: cfg.press } : {}),
  };
  drawing = {
    ...base, kind: 'stroke', stroke, drawn: 1, prevMid: null,
    smooth: ed.tool === 'pen' ? T.pen.stab : 0,
    shapes: ed.tool === 'shapes', straight: ed.tool === 'highlighter' && cfg.straight,
    // Whole-stroke redraw is needed where pieces can't simply be appended.
    redraw: ed.tool !== 'pen',
  };
  if (!pendingInk) clearInk();
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
  inkTransform(d);
  const s = d.stroke, p = s.points;
  if (d.redraw) {
    // Highlighter/shapes: redraw just this stroke on a cleared ink layer (cheap, the layer holds nothing else).
    clearInk(); pendingInk = 0;
    inkTransform(d);
    drawStroke(ictx, d.shapes ? { ...s, pen: 'ball' } : s);
    return;
  }
  ictx.lineCap = 'round'; ictx.lineJoin = 'round'; ictx.strokeStyle = s.color; ictx.fillStyle = s.color;
  if (!d.prevMid) {
    ictx.beginPath(); ictx.arc(p[0][0], p[0][1], pieceWidth(s, p[0][2]) / 2, 0, Math.PI * 2); ictx.fill();
    d.prevMid = p[0];
  }
  // Same midpoint-quadratic pieces as drawStroke(), appended as points arrive.
  for (let i = d.drawn; i < p.length - 1; i++) {
    const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
    ictx.lineWidth = pieceWidth(s, p[i][2], m[0] - d.prevMid[0], m[1] - d.prevMid[1]);
    ictx.beginPath(); ictx.moveTo(d.prevMid[0], d.prevMid[1]); ictx.quadraticCurveTo(p[i][0], p[i][1], m[0], m[1]); ictx.stroke();
    d.prevMid = m;
  }
  d.drawn = Math.max(d.drawn, p.length - 1);
}

// Called once the committed stroke is on the page canvas.
function inkCommitted() {
  pendingInk = Math.max(0, pendingInk - 1);
  if (pendingInk) return;
  clearInk();
  const d = drawing;
  if (d?.kind === 'stroke') { d.drawn = 1; d.prevMid = null; drawLive(); }
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
  // screenshot frame: dim everything outside the selected rectangle
  if (drawing?.kind === 'shot') {
    const [x0, y0] = drawing.from, [x1, y1] = drawing.to;
    const x = Math.min(x0, x1) - r.left, y = Math.min(y0, y1) - r.top, w = Math.abs(x1 - x0), hh = Math.abs(y1 - y0);
    if (w > 4 && hh > 4) {
      octx.save();
      octx.fillStyle = 'rgba(0,0,0,.28)';
      octx.beginPath(); octx.rect(0, 0, r.width, r.height); octx.rect(x, y, w, hh); octx.fill('evenodd');
      octx.setLineDash([6, 4]); octx.lineWidth = 1.5; octx.strokeStyle = '#fff'; octx.strokeRect(x, y, w, hh);
      octx.restore();
    }
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
