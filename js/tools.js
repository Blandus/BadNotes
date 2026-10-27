// Pointer input on pages: drawing, erasing, lasso selection, shapes, text, laser, gestures.
import { $, h, uid, r1, r2 } from './util.js';
import { icon } from './icons.js';
import { settings } from './store.js';
import { bbox, unionBox, transformEl, drawStroke, pageH, pageW, pageX0, pageY0, renderPage, LINE_H, pieceWidth, toRadius, fontFamily } from './render.js';
import {
  ed, T, sc, commit, renderEl, elForPage, setZoom, undo, redo, selectTool, renderOptions,
  scrollToPage, currentPage, toggleSearch, PALETTE,
} from './editor.js';
import { toast, popover, closePopover } from './ui.js';
import { samplePiece, addSamplesToPath, strokeSamples, tipRadius } from './ink.js';
import { PenInput, penPredictions } from './handwriting.js';
import { recording, recBegin, recMove, recUp, recEnd } from './pencilrec.js';
import { readRunsDom, renderRunsDom, selectionOffsets, setSelectionOffsets, styleAtPos, applyRange, normalize, runsOf } from './richtext.js';

let overlay, octx;
let drawing = null;
const touches = new Map();
let gesture = null;
let clipboard = null;

export function initTools() {
  overlay = $('#overlay');
  // The overlay carries the newest part of a live stroke (the tail and predicted tip), so it is
  // low-latency too where supported (Chromium; Safari ignores the hint).
  octx = overlay.getContext('2d', { desynchronized: true });
  ink = $('#ink');
  ictx = ink.getContext('2d', { desynchronized: true });
  inkDesync = !!ictx.getContextAttributes?.().desynchronized;
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
  // Any new input stops the glide, including toolbar touches and pencil contact.
  document.addEventListener('pointerdown', stopMomentum, true);
  document.addEventListener('wheel', stopMomentum, { passive: true });
  document.addEventListener('keydown', stopMomentum);
  document.addEventListener('visibilitychange', stopMomentum);
  window.addEventListener('resize', stopMomentum);
}

// Time of the last pen activity: touches shortly after it are the writing hand, not gestures.
let lastPen = 0;
const palmLikely = () => (drawing && !drawing.touch) || performance.now() - lastPen < 600;

// pixels per page unit while drawing; percentages of a page box for overlays (infinite pages have their own size and origin)
const ppu = d => d.rect.width / pageW(d.page);
const pctX = (page, x) => (x - pageX0(page)) / pageW(page) * 100 + '%';
const pctY = (page, y) => (y - pageY0(page)) / pageH(page) * 100 + '%';

function sizeOverlay() {
  const r = overlay.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(r.width * dpr); overlay.height = Math.round(r.height * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay();
}

// ---------- Geometry ----------
// rect: the page's bounding box, cached for the duration of a stroke (reading layout per event is slow)
// raw = true skips rounding (used for pen input, which is smoothed before it is stored)
// pen: whether e comes from a pen. Coalesced events take it from their parent event: Safari's
// may lack some fields (pointerId/target, reported by Flutter for iOS 18.2), and a missing
// pointerType would lose the pressure of every in-between sample.
function toPage(e, el, r = el.getBoundingClientRect(), raw = false, pen = e.pointerType === 'pen') {
  const p = pen ? (Number.isFinite(e.pressure) ? e.pressure : 0.5) : 0.5;
  const pg = el._page;
  const x = pageX0(pg) + (e.clientX - r.left) / r.width * pageW(pg), y = pageY0(pg) + (e.clientY - r.top) / r.height * pageH(pg);
  return raw ? [x, y, p] : [r1(x), r1(y), Math.round(p * 100) / 100];
}

// Legacy smoothing for highlighter/shapes. New pen strokes use PenInput above.
// Older input streams can contain whole screen pixels; when zoomed out one
// pixel is a large step on the page, so a raw stroke is a staircase that stays visible
// when zooming in later. Points are filtered (exponential smoothing) and points closer
// than MIN_STEP screen px are dropped, so the stored stroke is a smooth curve.
// Stabilisation (0..1) lowers the filter factor: 0 → 0.65 (light), 1 → 0.1 (very steady, more lag).
const MIN_STEP = 0.4; // screen px
function addPoint(d, raw, time) {
  if (d.input) { d.input.push(raw, time); return; }
  const a = 0.65 - 0.55 * d.smooth; // light: the finishing pass smooths, corners must survive
  const f = d.filt ? d.filt.map((v, i) => v + (raw[i] - v) * a) : raw;
  d.filt = f;
  d.lastRaw = raw;
  const p = d.stroke.points, last = p[p.length - 1];
  const minDist = MIN_STEP * (1 / ppu(d));
  if (Math.hypot(f[0] - last[0], f[1] - last[1]) < minDist) return;
  p.push([r1(f[0]), r1(f[1]), Math.round(f[2] * 100) / 100]);
}
// On lift-off: catch up to the real end point, then smooth the centre line. Rounds (o, s, e)
// get several [1,2,1] passes; real corners (E, z, the tip of a v — the direction turns by more
// than ~60° within a few points) are kept sharp.
function finishPoints(d) {
  if (d.input) return d.input.finish();
  const p = d.stroke.points;
  if (d.lastRaw && Math.hypot(d.lastRaw[0] - p[p.length - 1][0], d.lastRaw[1] - p[p.length - 1][1]) > MIN_STEP * (1 / ppu(d))) {
    p.push([r1(d.lastRaw[0]), r1(d.lastRaw[1]), Math.round(d.lastRaw[2] * 100) / 100]);
  }
  if (p.length < 4) return p;
  const corner = new Uint8Array(p.length);
  const K = 3; // compare directions over a few points (input is dense)
  for (let i = K; i < p.length - K; i++) {
    const ax = p[i][0] - p[i - K][0], ay = p[i][1] - p[i - K][1], bx = p[i + K][0] - p[i][0], by = p[i + K][1] - p[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la && lb && (ax * bx + ay * by) / (la * lb) < 0.5) for (let j = i - 1; j <= i + 1; j++) corner[j] = 1; // > 60°
  }
  let pts = p;
  for (let pass = 0; pass < 3 + Math.round(d.smooth * 4); pass++) {
    pts = pts.map((q, i) => i === 0 || i === pts.length - 1 || corner[i] ? q : [
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
      out.push([r2(a[0] + (b[0] - a[0]) * t), r2(a[1] + (b[1] - a[1]) * t), a[2] + (b[2] - a[2]) * t]);
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
  stopMomentum();
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
    try { sc.setPointerCapture(e.pointerId); } catch {}
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
  const base = { el, page: el._page, id: e.pointerId, touch: e.pointerType === 'touch', pen: e.pointerType === 'pen', rect, stage: ink.parentElement.getBoundingClientRect(), time: e.timeStamp };
  const pt = toPage(e, el, rect, ed.tool === 'pen');
  ed.busy = true;
  switch (ed.tool) {
    case 'pen': case 'highlighter': case 'shapes':
      startStroke(base, pt);
      if (drawing.input && recording()) recBegin(drawing, e, { zoom: ed.zoom, ppu: ppu(base), pageW: pageW(base.page), pageH: pageH(base.page), x0: pageX0(base.page), y0: pageY0(base.page), stab: T.pen.stab });
      return;
    case 'eraser': return startErase(base, pt, e);
    case 'lasso': return startLasso(base, pt, e);
    case 'text': drawing = { ...base, kind: 'text', pt }; return; // acts on pointerup (keyboard focus needs a tap)
    case 'laser': drawing = { ...base, kind: 'laser', stroke: uid() }; return addLaser(e);
    case 'screenshot': drawing = { ...base, kind: 'shot', from: [e.clientX, e.clientY], to: [e.clientX, e.clientY] }; return;
  }
}

function onMove(e) {
  if (drawing && e.pointerId === drawing.id) {
    const at = performance.now();
    e.preventDefault();
    if (e.pointerType === 'pen') lastPen = performance.now();
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    const d = drawing;
    if (d.kind === 'stroke') {
      if (d.straight) d.stroke.points = [d.stroke.points[0], toPage(e, d.el, d.rect)];
      else if (!d.snapped) {
        const pen = e.pointerType === 'pen';
        for (const ev of evs) addPoint(d, toPage(ev, d.el, d.rect, true, pen), ev.timeStamp || e.timeStamp);
        // where the Pencil is about to be: drawn as a provisional tip, never stored. Without
        // browser predictions, the input extrapolates one frame ahead itself.
        const predictions = !d.redraw && e.getPredictedEvents ? e.getPredictedEvents().map(ev => [...toPage(ev, d.el, d.rect, true, pen), ev.timeStamp]) : [];
        d.pred = d.input ? penPredictions(predictions, e.timeStamp, toPage(e, d.el, d.rect, true), ppu(d)) : predictions;
        if (d.input && !d.pred.length) d.pred = d.input.extrapolate(frameMs);
      }
      if (!d.snapped) { liveNow(); watchHold(d, e); }
      if (d.input) recMove(e, at); // Pencil diagnostics (no-op unless recording)
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
      if (T.lasso.mode === 'rect') {
        // rectangle from the start point to the pointer (same selection rules as the free lasso)
        const [x0, y0] = d.path[0], a = d.pagePts[0], b = toPage(e, d.el);
        d.path = [[x0, y0], [e.clientX, y0], [e.clientX, e.clientY], [x0, e.clientY]];
        d.pagePts = [a, [b[0], a[1]], b, [a[0], b[1]]];
      } else for (const ev of evs) { d.path.push([ev.clientX, ev.clientY]); d.pagePts.push(toPage(ev, d.el)); }
      drawOverlay();
    } else if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'textwidth') {
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
    if (touches.size === 1 && !gesture.pinched) sampleScroll(gesture);
  } else if (e.pointerType !== 'touch' && ed.tool === 'eraser' && e.target.closest?.('.page')) {
    hoverCursor = [e.clientX, e.clientY]; drawOverlay();
  }
}
let hoverCursor = null;

function onUp(e, ok) {
  const released = ok && touches.has(e.pointerId) && touches.size === 1 && !drawing ? gesture : null;
  if (e.pointerType === 'pen') lastPen = performance.now();
  // Safari cancels the pencil's pointer when it thinks the palm started a gesture; the ink
  // drawn up to that point is real, so a cancelled pen stroke is kept, not thrown away.
  if (drawing && e.pointerId === drawing.id) {
    if (drawing.input) recUp(e);
    if (ok && drawing.input && !drawing.snapped) drawing.input.end(toPage(e, drawing.el, drawing.rect, true), e.timeStamp);
    finish(ok || (drawing.kind === 'stroke' && !drawing.touch));
  }
  if (touches.delete(e.pointerId)) startGesture();
  if (released) startMomentum(released);
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
    class: 'shape-handle', 'data-i': i, style: { left: pctX(page, x), top: pctY(page, y) },
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
    drawOverlay();
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
    class: 'lasso-hint', style: { left: pctX(d.page, b.x + b.w / 2), top: pctY(d.page, b.y) },
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
  if (d.kind === 'erase' || d.kind === 'move' || d.kind === 'resize' || d.kind === 'textwidth' || d.kind === 'vertex') { d.page.elements = d.before; renderEl(d.el); renderSelection(); renderShapeHandles(); }
  else if (d.kind === 'stroke') { if (!pendingInk) clearInk(); if (d.input) recEnd(null); }
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
    else s = toRadius(s); // stored like Goodnotes: half width per point
    if (d.input && !snap) paintFinishedPen(d, s);
    if (d.input) recEnd(snap ? null : s);
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
  } else if (d.kind === 'move' || d.kind === 'resize' || d.kind === 'textwidth') {
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
  const ph = pageH(d.page), pw = pageW(d.page), x0 = pageX0(d.page), y0 = pageY0(d.page);
  const a = toPage({ clientX: d.from[0], clientY: d.from[1] }, d.el, d.rect);
  const b = toPage({ clientX: d.to[0], clientY: d.to[1] }, d.el, d.rect);
  let x = Math.max(x0, Math.min(a[0], b[0])), y = Math.max(y0, Math.min(a[1], b[1]));
  let w = Math.min(x0 + pw, Math.max(a[0], b[0])) - x, hh = Math.min(y0 + ph, Math.max(a[1], b[1])) - y;
  if (w < 10 || hh < 10) { x = x0; y = y0; w = pw; hh = ph; } // tap → whole page
  // only the chosen area is rendered (an infinite page can be too large for one canvas)
  const s = Math.min(2.5, Math.sqrt(4e7 / (w * hh)));
  const out = document.createElement('canvas');
  out.width = Math.round(w * s); out.height = Math.round(hh * s);
  await renderPage(out.getContext('2d'), d.page, s, null, -(x - x0) * s, -(y - y0) * s);
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
function startGesture() {
  // Once a second finger joins, suppress inertia until the whole pinch gesture ends.
  const pinched = touches.size > 1 || !!gesture?.pinched;
  gesture = touches.size ? { ...gestureState(), zoom: ed.zoom, pinched, samples: [] } : null;
  if (gesture) sampleScroll(gesture);
}

// ---------- Momentum scrolling ----------
// Native touch scrolling is disabled to keep palm rejection and pencil strokes reliable.
// Continue moving only the editor pane after a flick; the document stays fixed on iPadOS.
let scrollFrame = null;
const SCROLL_DECAY_MS = 325;
function stopMomentum() {
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
}
function sampleScroll(g, now = performance.now()) {
  g.samples.push({ t: now, x: sc.scrollLeft, y: sc.scrollTop });
  while (g.samples.length > 1 && g.samples[0].t < now - 100) g.samples.shift();
}
function startMomentum(g) {
  stopMomentum();
  if (g.pinched || palmLikely() || !ed.doc || $('#editor').hidden) return;
  sampleScroll(g);
  const first = g.samples[0], last = g.samples[g.samples.length - 1];
  const dt = last.t - first.t;
  if (dt < 8 || Math.hypot(last.x - first.x, last.y - first.y) < 8) return;
  const cap = v => Math.max(-4.5, Math.min(4.5, v));
  let vx = cap((last.x - first.x) / dt), vy = cap((last.y - first.y) / dt);
  let x = sc.scrollLeft, y = sc.scrollTop, previous = performance.now();
  const doc = ed.doc;
  function step(now) {
    scrollFrame = null;
    if (document.hidden || $('#editor').hidden || ed.doc !== doc || touches.size || palmLikely()) return;
    // Integrate by elapsed time, equally on 60 Hz and 120 Hz displays.
    const elapsed = now - previous;
    if (elapsed > 100) return; // don't jump after a suspended or heavily stalled frame
    previous = now;
    const decay = Math.exp(-elapsed / SCROLL_DECAY_MS);
    x += vx * SCROLL_DECAY_MS * (1 - decay);
    y += vy * SCROLL_DECAY_MS * (1 - decay);
    const maxX = Math.max(0, sc.scrollWidth - sc.clientWidth);
    const maxY = Math.max(0, sc.scrollHeight - sc.clientHeight);
    if (x <= 0 || x >= maxX) vx = 0;
    if (y <= 0 || y >= maxY) vy = 0;
    x = Math.max(0, Math.min(maxX, x));
    y = Math.max(0, Math.min(maxY, y));
    sc.scrollLeft = x; sc.scrollTop = y;
    vx *= decay; vy *= decay;
    if (Math.hypot(vx, vy) > 0.02) scrollFrame = requestAnimationFrame(step);
  }
  if (Math.hypot(vx, vy) > 0.08) scrollFrame = requestAnimationFrame(step);
}

// ---------- Pen, highlighter, shapes ----------
// Live strokes go onto the screen-sized #ink canvas at full device resolution.
// Pen strokes are drawn incrementally (only the new pieces each frame), so the cost
// per frame no longer depends on the page size or the stroke length. The finished
// stroke is committed to the page canvas and the ink layer is cleared once that has rendered.
let ink, ictx, inkDesync = false;
let pendingInk = 0; // committed strokes still visible on the ink layer

function sizeInk() {
  const r = ink.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  ink.width = Math.round(r.width * dpr); ink.height = Math.round(r.height * dpr);
  ink._dpr = dpr;
}
function inkTransform(d) {
  // page units → ink canvas pixels
  const s = ppu(d) * ink._dpr;
  ictx.setTransform(s, 0, 0, s, (d.rect.left - d.stage.left) * ink._dpr - pageX0(d.page) * s, (d.rect.top - d.stage.top) * ink._dpr - pageY0(d.page) * s);
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
    ...(ed.tool === 'pen' ? { sharp: cfg.sharp, press: cfg.press, ink: 2, rad: 1 } : {}),
  };
  drawing = {
    ...base, kind: 'stroke', stroke, drawn: 1, prevMid: null,
    smooth: ed.tool === 'pen' ? T.pen.stab : 0,
    shapes: ed.tool === 'shapes', straight: ed.tool === 'highlighter' && cfg.straight,
    // Whole-stroke redraw is needed where pieces can't simply be appended.
    redraw: ed.tool !== 'pen',
  };
  if (ed.tool === 'pen') {
    // mouse / finger: pressure simulated from speed (a real pen reports its own)
    drawing.input = new PenInput(stroke, pt, base.time, ppu(base), cfg.stab, !base.pen);
    stroke.points = drawing.input.points;
  }
  if (!pendingInk) clearInk();
  drawLive();
}
let liveQueued = false;
function queueLive() {
  if (liveQueued) return;
  liveQueued = true;
  requestAnimationFrame(() => { liveQueued = false; drawLive(); });
}
// Draws right in the input event — the earliest moment the new points are known — at most once
// per frame; more events within the same frame are drawn by the frame callback.
let liveFrame = false, frameMs = 1000 / 60, lastFrame = 0;
function liveNow() {
  if (liveFrame) return queueLive();
  liveFrame = true;
  requestAnimationFrame(t => {
    liveFrame = false;
    // the display's frame time (60 or 120 Hz) — how far ahead the extrapolated tip reaches
    if (lastFrame && t - lastFrame > 4 && t - lastFrame < 40) frameMs += (t - lastFrame - frameMs) * 0.2;
    lastFrame = t;
  });
  drawLive();
}
function drawLive() {
  const d = drawing;
  if (!d || d.kind !== 'stroke') return;
  inkTransform(d);
  const s = d.stroke, p = s.points;
  if (d.input && !d.snapped) { drawPenInk(d); return; }
  if (d.redraw) {
    // Highlighter/shapes: redraw just this stroke on a cleared ink layer (cheap, the layer holds nothing else).
    clearInk(); pendingInk = 0;
    inkTransform(d);
    drawStroke(ictx, d.shapes ? { ...s, pen: 'ball' } : s);
    return;
  }
  ictx.fillStyle = s.color;
  // Same midpoint-quadratic pieces and filled outline as drawStroke(), appended as points
  // arrive; the width follows the pressure smoothly (it is smoothed again when finished).
  const smp = [];
  if (!d.prevMid) {
    d.prevR = pieceWidth(s, p[0][2]) / 2;
    d.prevMid = p[0];
    smp.push([p[0][0], p[0][1], d.prevR]);
  } else smp.push([d.prevMid[0], d.prevMid[1], d.prevR]);
  for (let i = d.drawn; i < p.length - 1; i++) {
    const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
    const target = pieceWidth(s, p[i][2], m[0] - d.prevMid[0], m[1] - d.prevMid[1]) / 2;
    const r = d.prevR + (target - d.prevR) * 0.35;
    samplePiece(d.prevMid, p[i], m, d.prevR, r, smp);
    d.prevMid = m; d.prevR = r;
  }
  if (smp.length > 1 || d.drawn === 1) {
    const path = new Path2D();
    addSamplesToPath(path, smp, 0);
    ictx.fill(path, 'nonzero');
  }
  d.drawn = Math.max(d.drawn, p.length - 1);
  drawPrediction(d);
}

// A stable prefix is painted once. Only the last few pixels and predictions are redrawn;
// the prefix uses exactly the same midpoint curves/radii as the saved stroke.
function drawPenInk(d) {
  const s = d.stroke, view = d.input.view(), p = view.points, lengths = view.lengths;
  const realCount = view.fixedCount, realTotal = view.total;
  // The predicted tip is part of the replaceable tail, including its end taper.
  for (const q of d.pred || []) {
    const last = p[p.length - 1];
    view.total += Math.hypot(q[0] - last[0], q[1] - last[1]);
    p.push([q[0], q[1], last[2]]); lengths.push(view.total);
  }
  const radius = i => tipRadius(s, p[i][2], lengths[i], view.total);
  const hold = Math.max(16 * (1 / ppu(d)), s.width * 4);
  const smp = [];
  if (!d.prevMid) {
    d.prevMid = p[0]; d.prevR = radius(0);
  }
  // A short stroke can transition from a dot to a tapered line before any prefix is fixed.
  if (d.drawn === 1) d.prevR = radius(0);
  smp.push([d.prevMid[0], d.prevMid[1], d.prevR]);
  while (d.drawn < realCount - 1 && lengths[d.drawn + 1] < realTotal - hold) {
    const i = d.drawn, m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
    const r = radius(i);
    samplePiece(d.prevMid, p[i], m, d.prevR, r, smp);
    d.prevMid = m; d.prevR = r; d.drawn++;
  }
  if (smp.length > 1) {
    const path = new Path2D(); addSamplesToPath(path, smp);
    ictx.fillStyle = s.color; ictx.fill(path, 'nonzero');
  }
  const dpr = ink._dpr, scale = ppu(d) * dpr;
  const ox = (d.rect.left - d.stage.left) * dpr - pageX0(d.page) * scale, oy = (d.rect.top - d.stage.top) * dpr - pageY0(d.page) * scale;
  const tail = [[d.prevMid[0], d.prevMid[1], d.prevR]];
  for (let i = d.drawn; i < p.length; i++) tail.push([p[i][0], p[i][1], radius(i)]);
  // Only the area of the previous tail is cleared, not the whole screen-sized overlay: clearing
  // (and handing the browser) ~5 million pixels every frame costs time on the iPad. The curve
  // stays inside the hull of its points, widened by the largest radius.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, rmax = 0;
  for (const [x, y, r] of tail) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; if (r > rmax) rmax = r; }
  const box = [Math.floor((x0 - rmax) * scale + ox) - 2, Math.floor((y0 - rmax) * scale + oy) - 2, Math.ceil((x1 + rmax) * scale + ox) + 2, Math.ceil((y1 + rmax) * scale + oy) + 2];
  octx.setTransform(1, 0, 0, 1, 0, 0);
  if (d.tailBox) octx.clearRect(d.tailBox[0], d.tailBox[1], d.tailBox[2] - d.tailBox[0], d.tailBox[3] - d.tailBox[1]);
  else octx.clearRect(0, 0, overlay.width, overlay.height);
  d.tailBox = box;
  octx.setTransform(scale, 0, 0, scale, ox, oy);
  const path = new Path2D(); addSamplesToPath(path, strokeSamples(tail, i => tail[i][2]));
  octx.fillStyle = s.color; octx.fill(path, 'nonzero');
  // back to the overlay's own transform (sizeOverlay), so drawOverlay clears all of it
  const odpr = window.devicePixelRatio || 1;
  octx.setTransform(odpr, 0, 0, odpr, 0, 0);
}

// Keep the complete finished tail visible during the asynchronous page render. Without
// this handoff the tail would vanish for a frame when the overlay loses its predictions.
function paintFinishedPen(d, s) {
  const p = s.points;
  inkTransform(d);
  const tail = d.drawn === 1 ? [p[0]] : [[d.prevMid[0], d.prevMid[1], d.prevR]];
  for (let i = d.drawn; i < p.length; i++) tail.push(p[i]);
  const path = new Path2D(); addSamplesToPath(path, strokeSamples(tail, i => tail[i][2]));
  ictx.fillStyle = s.color; ictx.fill(path, 'nonzero');
}

// Predicted Pencil points (getPredictedEvents): a short provisional tip on the overlay layer,
// replaced on every frame, so the line keeps up with the pen. Cleared when the stroke ends.
function drawPrediction(d) {
  const odpr = window.devicePixelRatio || 1;
  octx.save();
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const pts = d.pred;
  if (pts?.length && d.prevMid) {
    const s = ppu(d) * odpr;
    octx.setTransform(s, 0, 0, s, (d.rect.left - d.stage.left) * odpr - pageX0(d.page) * s, (d.rect.top - d.stage.top) * odpr - pageY0(d.page) * s);
    const smp = [[d.prevMid[0], d.prevMid[1], d.prevR]];
    for (const q of [d.stroke.points[d.stroke.points.length - 1], ...pts]) smp.push([q[0], q[1], d.prevR]);
    const path = new Path2D();
    addSamplesToPath(path, smp, 0);
    octx.fillStyle = d.stroke.color;
    octx.fill(path, 'nonzero');
  }
  octx.restore();
}

// Called once the committed stroke is on the page canvas. A desynchronized ink canvas
// (Chromium) reaches the screen on its own schedule, before the page canvas' next frame:
// clearing it right away would let the stroke vanish for a frame, so it waits two frames.
// Safari ignores the hint and presents both canvases together, so it clears at once.
function inkCommitted() {
  if (inkDesync) requestAnimationFrame(() => requestAnimationFrame(clearCommitted));
  else clearCommitted();
}
function clearCommitted() {
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
    const wh = e.target.closest('.sel-wh');
    if (wh) { drawing = { ...base, kind: 'textwidth', side: wh.dataset.side, before: base.page.elements, origin: pt }; return; }
    if (inBox(pt, { x: box.x - 8, y: box.y - 8, w: box.w + 16, h: box.h + 16 })) { drawing = { ...base, kind: 'move', before: base.page.elements, origin: pt }; return; }
  }
  clearSelection();
  drawing = { ...base, kind: 'lasso', path: [[e.clientX, e.clientY]], pagePts: [pt] };
}

function transformSelection(pt) {
  const d = drawing, ids = ed.sel.ids;
  let fn, k = 1;
  if (d.kind === 'textwidth') {
    // frame width of a text box: the text re-wraps, its size stays the same
    const dx = pt[0] - d.origin[0], MIN = 40;
    d.page.elements = d.before.map(e => {
      if (!ids.has(e.id)) return e;
      if (d.side === 'r') return { ...e, w: Math.round(Math.max(MIN, e.w + dx) * 10) / 10 };
      const w = Math.max(MIN, e.w - dx);
      return { ...e, x: Math.round((e.x + e.w - w) * 10) / 10, w: Math.round(w * 10) / 10 };
    });
    queueRender(d.el);
    return renderSelection();
  }
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
  // a single text box shows its frame (its wrap width) with width handles instead of the scale handle
  const single = els.length === 1 && els[0].type === 'text' ? els[0] : null;
  const b = single ? { x: single.x, y: single.y, w: single.w, h: bbox(single).h } : unionBox(els), ph = pageH(ed.sel.page), pad = 6;
  const btn = (label, ic, fn) => h('button', { title: label, onclick: fn }, icon(ic, 18), h('span', {}, label));
  pageEl.append(h('div', {
    class: 'selbox',
    style: { left: pctX(ed.sel.page, b.x - pad), top: pctY(ed.sel.page, b.y - pad), width: (b.w + 2 * pad) / pageW(ed.sel.page) * 100 + '%', height: (b.h + 2 * pad) / ph * 100 + '%' },
  },
    h('div', { class: 'sel-menu' + (b.y < 70 ? ' below' : '') },
      els.some(e => e.type !== 'image') ? btn('Farbe', 'palette', e => recolorMenu(e.currentTarget)) : null,
      btn('Ausschneiden', 'cut', cutSelection),
      btn('Kopieren', 'copy', copySelection),
      btn('Duplizieren', 'copy', duplicateSelection),
      btn('Löschen', 'trash', deleteSelection)),
    single
      ? [h('div', { class: 'sel-wh l', 'data-side': 'l', title: 'Breite ändern (Text bricht neu um)' }), h('div', { class: 'sel-wh r', 'data-side': 'r', title: 'Breite ändern (Text bricht neu um)' })]
      : h('div', { class: 'sel-handle', title: 'Größe ändern' })));
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
    id: uid(), type: 'text', x: pt[0], y: Math.max(pageY0(page), pt[1] - cfg.size * 0.65),
    w: Math.max(160, Math.min(560, pageX0(page) + pageW(page) - pt[0] - 30)), size: cfg.size, color: cfg.colors[cfg.color], text: '',
    ...(cfg.bold ? { bold: true } : {}), ...(cfg.italic ? { italic: true } : {}), ...(cfg.font && cfg.font !== 'sans' ? { font: cfg.font } : {}),
  }, true);
}

// Text box editing: a contenteditable box with one span per run (see richtext.js). Size, bold,
// italic, font and colour apply to the selected characters, or to the whole box when nothing
// is selected.
function editText(pageEl, t, isNew) {
  const page = pageEl._page;
  const box = h('div', { class: 'text-editor', contenteditable: 'true', spellcheck: 'true', 'aria-label': 'Text', role: 'textbox', 'aria-multiline': 'true' });
  const scale = () => st.pageEl.clientWidth / pageW(page);
  const st = {
    page, pageEl, id: t.id, orig: t, el: t, isNew, box, sel: null,
    place() {
      const ph = pageH(page);
      Object.assign(box.style, {
        left: pctX(page, st.el.x), top: pctY(page, st.el.y), width: st.el.w / pageW(page) * 100 + '%',
        fontSize: st.el.size * scale() + 'px', lineHeight: LINE_H, color: st.el.color, fontFamily: fontFamily(st.el),
        fontWeight: st.el.bold ? '700' : '400', fontStyle: st.el.italic ? 'italic' : 'normal',
      });
      // zoom changed: run sizes follow
      for (const s of box.querySelectorAll('[data-run]')) s.style.fontSize = (+s.dataset.size || st.el.size) * scale() + 'px';
    },
    sync() { st.el = readRunsDom(box, st.el); },
    redraw(a, b) { renderRunsDom(box, st.el, scale()); st.place(); if (a != null) setSelectionOffsets(box, a, b); },
    // style of the selection start (shown in the bar)
    current() { st.sync(); const o = st.sel || [st.el.text.length, st.el.text.length]; return styleAtPos(st.el, o[0] === o[1] ? o[0] : o[0] + 1); },
    setStyle(patch) {
      st.sync();
      const o = st.sel;
      if (o && o[1] > o[0]) st.el = applyRange(st.el, o[0], o[1], patch);
      else st.el = normalize({ ...st.el, ...patch }, runsOf(st.el).map(r => { const n = { ...r }; for (const k of Object.keys(patch)) delete n[k]; return n; }));
      st.redraw(...(o || []));
      box.focus();
    },
    setColor(c) { st.setStyle({ color: c }); },
    setSize(s) { st.setStyle({ size: s }); },
  };
  ed.editing = st;
  // frame around the open box: grip to move it, side handles to change the width (text rewraps, size stays)
  const frame = h('div', { class: 'text-frame' },
    h('div', { class: 'tf-grip', 'data-act': 'move', title: 'Textfeld verschieben', 'aria-label': 'Textfeld verschieben' }),
    h('div', { class: 'tf-side l', 'data-act': 'l', title: 'Breite ändern', 'aria-label': 'Breite ändern' }),
    h('div', { class: 'tf-side r', 'data-act': 'r', title: 'Breite ändern', 'aria-label': 'Breite ändern' }));
  st.frame = frame;
  const placeBox = st.place;
  st.place = () => {
    placeBox();
    Object.assign(frame.style, { left: box.style.left, top: box.style.top, width: box.style.width, height: box.offsetHeight + 'px' });
  };
  const ro = new ResizeObserver(() => { if (ed.editing === st) frame.style.height = box.offsetHeight + 'px'; });
  ro.observe(box);
  st.unobserve = () => ro.disconnect();
  // mousedown default would move the focus out of the box and end editing
  frame.addEventListener('mousedown', e => e.preventDefault());
  frame.addEventListener('click', e => e.stopPropagation());
  frame.addEventListener('pointerdown', e => {
    const handle = e.target, act = handle.dataset?.act;
    if (!act) return;
    e.preventDefault(); e.stopPropagation();
    try { handle.setPointerCapture(e.pointerId); } catch {}
    st.sync();
    const caret = selectionOffsets(box) || st.sel;
    const start = { cx: e.clientX, cy: e.clientY, x: st.el.x, y: st.el.y, w: st.el.w }, k = scale();
    const r1 = v => Math.round(v * 10) / 10;
    frame.classList.add('active');
    const move = ev => {
      ev.stopPropagation(); // the page's own pointer routing must not see this drag
      const dx = (ev.clientX - start.cx) / k, dy = (ev.clientY - start.cy) / k;
      if (act === 'move') {
        st.el.x = r1(Math.min(pageX0(page) + pageW(page) - 20, Math.max(pageX0(page) + 20 - start.w, start.x + dx)));
        st.el.y = r1(Math.max(pageY0(page), Math.min(pageY0(page) + pageH(page) - 20, start.y + dy)));
      } else if (act === 'r') st.el.w = r1(Math.max(40, start.w + dx));
      else { const w = Math.max(40, start.w - dx); st.el.x = r1(start.x + start.w - w); st.el.w = r1(w); }
      st.place();
    };
    const up = ev => {
      ev.stopPropagation();
      frame.classList.remove('active');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      box.focus();
      if (caret) setSelectionOffsets(box, caret[0], caret[1]); // the caret stays where it was
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  pageEl.append(box, frame);
  st.redraw();
  box.addEventListener('input', () => { if (!box.firstChild) box.append(h('br')); });
  box.addEventListener('blur', () => finishText());
  box.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); box.blur(); }
    // line breaks as text (no <div>s), so the box stays one run list
    if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
    if ((e.ctrlKey || e.metaKey) && /^[bi]$/i.test(e.key)) {
      e.preventDefault();
      const cur = st.current(), k = e.key.toLowerCase() === 'b' ? 'bold' : 'italic';
      st.setStyle({ [k]: !cur[k] }); renderOptions();
    }
  });
  box.addEventListener('paste', e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); });
  renderEl(pageEl); // hides the canvas copy while editing
  box.focus();
  setSelectionOffsets(box, st.el.text.length, st.el.text.length);
  renderOptions(); // the bar shows the style at the cursor
}
// Remember the selection inside the box (toolbar taps must not lose it) and refresh the bar.
document.addEventListener('selectionchange', () => {
  const st = ed.editing;
  if (!st) return;
  const o = selectionOffsets(st.box);
  if (!o) return;
  const changed = !st.sel || st.sel[0] !== o[0] || st.sel[1] !== o[1];
  st.sel = o;
  if (changed) renderOptions();
});

export async function finishText() {
  const st = ed.editing;
  if (!st) return;
  st.sync();
  ed.editing = null;
  st.box.remove(); st.frame?.remove(); st.unobserve?.();
  renderOptions();
  const page = st.page;
  // trailing whitespace is not kept
  const trimmed = st.el.text.replace(/\s+$/, '');
  let left = trimmed.length;
  const next = trimmed === st.el.text ? st.el
    : normalize(st.el, runsOf(st.el).map(r => { const take = Math.max(0, Math.min(r.text.length, left)); left -= take; return { ...r, text: r.text.slice(0, take) }; }));
  const text = next.text;
  if (st.isNew) {
    if (text.trim()) commit(page, [...page.elements, next]);
    else renderEl(st.pageEl);
  } else if (!text.trim()) {
    commit(page, page.elements.filter(e => e.id !== st.id));
  } else if (JSON.stringify(next) !== JSON.stringify(st.orig)) {
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
    const k = ed.pageEls[0].clientWidth / pageW(ed.pageEls[0]._page);
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
