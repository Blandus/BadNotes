import { PAGE_W, PAPERS } from './store.js';
import { r2 } from './util.js';
import { fillStroke } from './ink.js';
import { layout, drawRich, LINE_H } from './richtext.js';
import { drawPdfPage } from './pdfdoc.js';

export const pageH = p => p.h || 1414;
// Infinite pages (page.inf) have their own width and an origin: their area is x0..x0+w × y0..y0+h
// in element coordinates and grows in every direction with the content (fitInfinite).
export const pageW = p => (p.inf && p.w) || PAGE_W;
export const pageX0 = p => (p.inf && p.x0) || 0;
export const pageY0 = p => (p.inf && p.y0) || 0;
const INF_MARGIN = 500;
// Grows an infinite page so its content keeps INF_MARGIN free space on every side.
// Returns { dx, dy } (how far the origin moved left / up) or null when nothing changed.
export function fitInfinite(page) {
  if (!page.inf || !page.elements.length) return null;
  const b = unionBox(page.elements);
  let x0 = pageX0(page), y0 = pageY0(page), x1 = x0 + pageW(page), y1 = y0 + pageH(page);
  const step = v => Math.ceil(v / 250) * 250; // grow in steps, not on every stroke
  const nx0 = b.x - INF_MARGIN < x0 ? x0 - step(x0 - b.x + INF_MARGIN) : x0;
  const ny0 = b.y - INF_MARGIN < y0 ? y0 - step(y0 - b.y + INF_MARGIN) : y0;
  const nx1 = b.x + b.w + INF_MARGIN > x1 ? x1 + step(b.x + b.w + INF_MARGIN - x1) : x1;
  const ny1 = b.y + b.h + INF_MARGIN > y1 ? y1 + step(b.y + b.h + INF_MARGIN - y1) : y1;
  if (nx0 === x0 && ny0 === y0 && nx1 === x1 && ny1 === y1) return null;
  Object.assign(page, { x0: nx0, y0: ny0, w: nx1 - nx0, h: ny1 - ny0 });
  return { dx: x0 - nx0, dy: y0 - ny0 };
}
export const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
const measure = document.createElement('canvas').getContext('2d');

// Decoded images (page backgrounds, pictures), least recently used first. Bounded: one imported
// PDF page (1600×2263) takes ~14 MB decoded, so keeping all of them made long documents hold
// hundreds of MB until the app was reloaded ("Out of Memory"). Over the budget, the images
// unused for the longest time are dropped (the browser frees them; they are decoded again when
// needed). A few always stay, so the visible pages never have to wait twice.
const IMG_BUDGET = 96e6, IMG_KEEP = 4;
const imgCache = new Map(); // src → { p: Promise<Image|null>, bytes, gone }
let imgBytes = 0;
function trimImages() {
  for (const [src, e] of imgCache) {
    if (imgBytes <= IMG_BUDGET || imgCache.size <= IMG_KEEP) break;
    imgCache.delete(src); e.gone = true; imgBytes -= e.bytes;
  }
}
export function loadImage(src) {
  let e = imgCache.get(src);
  if (e) { imgCache.delete(src); imgCache.set(src, e); return e.p; } // now the most recently used
  e = { bytes: 0, gone: false };
  e.p = new Promise(res => {
    const i = new Image();
    i.onload = () => { if (!e.gone) { e.bytes = i.naturalWidth * i.naturalHeight * 4; imgBytes += e.bytes; trimImages(); } res(i); };
    i.onerror = () => { if (imgCache.get(src) === e) imgCache.delete(src); res(null); };
    i.src = src;
  });
  imgCache.set(src, e);
  return e.p;
}
export const imageCacheBytes = () => imgBytes;

// ---------- Paper templates ----------
export function drawTemplate(ctx, t, h, dark = false) {
  if (!t || t === 'blank') return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? 'rgba(255,255,255,.16)' : '#C9D4E4';
  ctx.fillStyle = dark ? 'rgba(255,255,255,.3)' : '#A7B2C3';
  const lines = (g, top, bottom = h - 30) => {
    ctx.beginPath();
    for (let y = top; y < bottom; y += g) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
    ctx.stroke();
  };
  const margin = x => { ctx.save(); ctx.strokeStyle = dark ? 'rgba(235,120,120,.4)' : '#EBB1B1'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); ctx.restore(); };
  const vlines = (xs, top, bottom = h - 30) => { ctx.beginPath(); for (const x of xs) { ctx.moveTo(x, top); ctx.lineTo(x, bottom); } ctx.stroke(); };
  if (t === 'lined') { lines(40, 120); margin(100); }
  else if (t === 'narrow') { lines(30, 100); margin(90); }
  else if (t === 'grid') goodnotesGrid(ctx, 0, 0, PAGE_W, h, PAGE_W / pagePt(h), dark);
  else if (t === 'dots') {
    for (let x = 25; x < PAGE_W; x += 25) for (let y = 25; y < h; y += 25) ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8);
  } else if (t === 'cornell') {
    const bottom = h - Math.round(h * 0.2);
    lines(40, 160, bottom);
    ctx.strokeStyle = '#8FA8CC'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 120); ctx.lineTo(PAGE_W, 120);
    ctx.moveTo(280, 120); ctx.lineTo(280, bottom);
    ctx.moveTo(0, bottom); ctx.lineTo(PAGE_W, bottom);
    ctx.stroke();
  } else if (t === 'notepad') {
    // Header band for a title/date, then ruled lines
    ctx.save(); ctx.fillStyle = dark ? 'rgba(255,255,255,.06)' : 'rgba(47,91,150,.07)'; ctx.fillRect(0, 0, PAGE_W, 150); ctx.restore();
    lines(40, 190); margin(100);
  } else if (t === 'twocol' || t === 'threecol') {
    const n = t === 'twocol' ? 2 : 3, gap = 30, colW = (PAGE_W - 120 - gap * (n - 1)) / n;
    lines(40, 120);
    ctx.save(); ctx.strokeStyle = dark ? 'rgba(255,255,255,.3)' : '#9FB1CC'; ctx.lineWidth = 1.5;
    vlines(Array.from({ length: n - 1 }, (_, i) => 60 + (i + 1) * colW + i * gap + gap / 2), 100);
    ctx.restore();
  }
  ctx.restore();
}

// Squared paper exactly like Goodnotes' "Kariert" (measured from its PDF template, A4
// 595.28 × 841.89 pt): a line every 16 pt, 0.5 pt wide, the first at 15.5 pt from the top and
// left edge (drawn as filled bars like there); #D0D2D3 on white, #58595B on dark (#333333) paper.
// u = page units per point; the grid starts at the page origin and runs over x0..x1 × y0..y1.
function goodnotesGrid(ctx, x0, y0, x1, y1, u, dark) {
  const gap = 16 * u, lw = 0.5 * u, first = 15.5 * u;
  ctx.save();
  ctx.fillStyle = dark ? '#58595B' : '#D0D2D3';
  const from = v => first + Math.ceil((v - first) / gap) * gap;
  for (let x = from(x0); x + lw <= x1; x += gap) ctx.fillRect(x, y0, lw, y1 - y0);
  for (let y = from(y0); y + lw <= y1; y += gap) ctx.fillRect(x0, y, x1 - x0, lw);
  ctx.restore();
}
// Paper width in points for a page of PAGE_W × h units: A4 or Letter, portrait or landscape.
function pagePt(h) {
  const r = h / PAGE_W, near = (a, b, c) => Math.abs(a - b) < Math.abs(a - c);
  return r >= 1 ? (near(r, 11 / 8.5, 841.89 / 595.28) ? 612 : 595.28) : (near(1 / r, 11 / 8.5, 841.89 / 595.28) ? 792 : 841.89);
}

// Infinite pages: lines, grid or dots continue across the whole area (no margins or headers).
function drawInfiniteTemplate(ctx, page) {
  const t = page.template, dark = page.paper === 'dark';
  if (!t || t === 'blank') return;
  const x0 = pageX0(page), y0 = pageY0(page), x1 = x0 + pageW(page), y1 = y0 + pageH(page);
  if (t === 'grid') return goodnotesGrid(ctx, x0, y0, x1, y1, PAGE_W / 595.28, dark);
  const g = t === 'dots' ? 25 : t === 'narrow' ? 30 : 40;
  const from = v => Math.ceil(v / g) * g;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? 'rgba(255,255,255,.16)' : '#C9D4E4';
  ctx.fillStyle = dark ? 'rgba(255,255,255,.3)' : '#A7B2C3';
  if (t === 'dots') { for (let x = from(x0); x < x1; x += g) for (let y = from(y0); y < y1; y += g) ctx.fillRect(x - 1.4, y - 1.4, 2.8, 2.8); }
  else {
    ctx.beginPath();
    for (let y = from(y0); y < y1; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    if (t === 'grid') for (let x = from(x0); x < x1; x += g) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    ctx.stroke();
  }
  ctx.restore();
}

export const paperColor = page => PAPERS[page.paper]?.color || '#FFFFFF';

// ---------- Strokes ----------
// Width model (radius per point, pressure for live/old strokes): see ink.js
export { WIDTH_FN, pieceWidth, widthAt, toRadius } from './ink.js';

export function drawStroke(ctx, s) {
  const p = s.points;
  if (!p.length) return;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = s.color; ctx.fillStyle = s.color;
  if (s.tool === 'highlighter' || s.shape) {
    if (s.tool === 'highlighter') { ctx.globalAlpha = 0.4; ctx.globalCompositeOperation = 'multiply'; ctx.lineCap = 'butt'; }
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    if (p.length === 1) ctx.lineTo(p[0][0] + 0.1, p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    if (s.closed) ctx.closePath();
    ctx.stroke();
  } else {
    // pen: one filled outline (see ink.js) — no seams or beads between pieces
    fillStroke(ctx, s);
  }
  ctx.restore();
}

// ---------- Text ----------
// Text boxes: rich text (runs with their own size / weight / style / font / colour), see richtext.js
export { LINE_H, FONTS, fontFamily, cssFont as fontOf } from './richtext.js';
export function textLines(t) {
  return layout(t, measure).lines.map(l => l.segs.map(s => s.text).join('').trimEnd());
}
export const textHeight = t => Math.max(t.size * LINE_H, layout(t, measure).h);
const drawText = (ctx, t) => drawRich(ctx, t, measure);

// ---------- Pages ----------
// ox/oy shift the output (in canvas pixels) so a cut-out of the page can be rendered.
export async function renderPage(ctx, page, scale, hideId, ox = 0, oy = 0) {
  if (page.inf) { ox -= pageX0(page) * scale; oy -= pageY0(page) * scale; }
  const srcs = [page.bg, ...page.elements.filter(e => e.type === 'image').map(e => e.src)].filter(Boolean);
  const imgs = new Map(await Promise.all(srcs.map(async s => [s, await loadImage(s)])));
  const h = pageH(page);
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = paperColor(page); ctx.fillRect(pageX0(page), pageY0(page), pageW(page), h);
  if (page.bg && imgs.get(page.bg)) ctx.drawImage(imgs.get(page.bg), 0, 0, PAGE_W, h);
  if (page.pdf && !(await drawPdfPage(ctx, page, scale, ox, oy))) {
    // the original PDF is not on this device and can't be loaded right now
    ctx.setTransform(scale, 0, 0, scale, ox, oy);
    ctx.fillStyle = '#EEF1F5'; ctx.fillRect(0, 0, PAGE_W, h);
    ctx.fillStyle = '#7A8597'; ctx.font = `28px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillText('PDF-Seite wird aus Google Drive geladen …', PAGE_W / 2, h / 2 - 18);
    ctx.font = `22px ${FONT}`;
    ctx.fillText('(braucht Internet und Google-Anmeldung)', PAGE_W / 2, h / 2 + 20);
    ctx.textAlign = 'start';
  }
  ctx.setTransform(scale, 0, 0, scale, ox, oy);
  if (page.inf) drawInfiniteTemplate(ctx, page);
  else drawTemplate(ctx, page.template, h, page.paper === 'dark');
  for (const e of page.elements) {
    if (e.id === hideId) continue;
    if (e.type === 'stroke') drawStroke(ctx, e);
    else if (e.type === 'text') drawText(ctx, e);
    else if (e.type === 'image' && imgs.get(e.src)) ctx.drawImage(imgs.get(e.src), e.x, e.y, e.w, e.h);
  }
}

export async function renderThumb(canvas, page, width) {
  if (page.inf) return renderInfiniteThumb(canvas, page, width);
  canvas.width = width; canvas.height = Math.round(width * pageH(page) / pageW(page));
  await renderPage(canvas.getContext('2d'), page, width / pageW(page));
}

// Infinite page preview: its content (or the start of the area), fitted into an A4 portrait card.
async function renderInfiniteThumb(canvas, page, width) {
  canvas.width = width; canvas.height = Math.round(width * 1.414);
  const b = page.elements.length ? unionBox(page.elements) : { x: pageX0(page), y: pageY0(page), w: PAGE_W, h: 1414 };
  const m = 40, w = b.w + 2 * m, h = b.h + 2 * m;
  const s = Math.min(canvas.width / w, canvas.height / h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = paperColor(page); ctx.fillRect(0, 0, canvas.width, canvas.height);
  const ox = (canvas.width - w * s) / 2 - (b.x - m - pageX0(page)) * s, oy = (canvas.height - h * s) / 2 - (b.y - m - pageY0(page)) * s;
  await renderPage(ctx, page, s, null, ox, oy);
}

// Notebook cover: solid colour, darker spine, label plate.
export function renderCover(canvas, color, width, h = Math.round(width * 1.3)) {
  canvas.width = width; canvas.height = h;
  const ctx = canvas.getContext('2d'), w = width;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.roundRect(0, 0, w, h, [w * 0.025, w * 0.07, w * 0.07, w * 0.025]); ctx.fill();
  const g = ctx.createLinearGradient(0, 0, w * 0.14, 0);
  g.addColorStop(0, 'rgba(0,0,0,.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w * 0.14, h);
  ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(w * 0.085, 0, Math.max(1, w * 0.008), h);
  ctx.fillStyle = 'rgba(255,255,255,.88)';
  ctx.beginPath(); ctx.roundRect(w * 0.26, h * 0.16, w * 0.56, h * 0.11, w * 0.02); ctx.fill();
}

// ---------- Geometry ----------
export function bbox(e) {
  if (e.type === 'stroke') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of e.points) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    const pad = e.width / 2;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }
  if (e.type === 'text') {
    const l = layout(e, measure);
    return { x: e.x, y: e.y, w: Math.max(e.size, l.w), h: Math.max(e.size * LINE_H, l.h) };
  }
  return { x: e.x, y: e.y, w: e.w, h: e.h };
}

export function unionBox(els) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    const b = bbox(e);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Returns a transformed copy. fn maps page coordinates; k scales sizes.
export function transformEl(e, fn, k = 1) {
  if (e.type === 'stroke') {
    // radius strokes scale their per-point radius with the size; pressure stays pressure
    const r = e.rad ? v => Math.round(v * k * 100) / 100 : v => v;
    return { ...e, width: e.width * k, points: e.points.map(p => { const [x, y] = fn(p[0], p[1]); return [r2(x), r2(y), r(p[2])]; }) };
  }
  const [x, y] = fn(e.x, e.y);
  if (e.type === 'text') return { ...e, x, y, w: e.w * k, size: e.size * k, ...(e.runs ? { runs: e.runs.map(r => (r.size ? { ...r, size: r.size * k } : r)) } : {}) };
  return { ...e, x, y, w: e.w * k, h: e.h * k };
}
