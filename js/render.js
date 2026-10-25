import { PAGE_W, PAPERS } from './store.js';
import { r1 } from './util.js';

export const pageH = p => p.h || 1414;
export const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
const measure = document.createElement('canvas').getContext('2d');

const imgCache = new Map();
export function loadImage(src) {
  if (!imgCache.has(src)) imgCache.set(src, new Promise(res => {
    const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src;
  }));
  return imgCache.get(src);
}

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
  else if (t === 'grid') {
    ctx.beginPath();
    for (let x = 25; x < PAGE_W; x += 25) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = 25; y < h; y += 25) { ctx.moveTo(0, y); ctx.lineTo(PAGE_W, y); }
    ctx.stroke();
  } else if (t === 'dots') {
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

export const paperColor = page => PAPERS[page.paper]?.color || '#FFFFFF';

// ---------- Strokes ----------
// Width multiplier as a function of pen pressure, per pen type.
export const WIDTH_FN = {
  fountain: p => 0.45 + 1.0 * p,
  ball: p => 0.85 + 0.3 * p,
  brush: p => 0.15 + 1.9 * p,
};

// Width of one stroke piece. s.press (0..1, default .5) scales how much pressure matters;
// s.sharp (0..1) makes fountain/brush strokes direction-dependent like an angled nib
// (thin when moving along the 45° nib, full width across it). Old strokes have neither
// field and render exactly as before.
const NIB = Math.PI / 4;
export function pieceWidth(s, pressure, dx = 0, dy = 0) {
  const f = WIDTH_FN[s.pen] || WIDTH_FN.fountain, mid = f(0.5);
  const k = (s.press ?? 0.5) / 0.5;
  let w = Math.max(0.15, mid + (f(pressure) - mid) * k);
  if (s.sharp && s.pen !== 'ball' && (dx || dy)) w *= 1 - s.sharp * 0.6 * (1 - Math.abs(Math.sin(Math.atan2(dy, dx) - NIB)));
  return s.width * w;
}

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
    if (p.length === 1) {
      ctx.beginPath(); ctx.arc(p[0][0], p[0][1], pieceWidth(s, p[0][2]) / 2, 0, Math.PI * 2); ctx.fill();
    } else {
      // Quadratic curves through segment midpoints, each piece with its own width.
      let prev = p[0];
      for (let i = 1; i < p.length - 1; i++) {
        const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
        ctx.lineWidth = pieceWidth(s, p[i][2], m[0] - prev[0], m[1] - prev[1]);
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.quadraticCurveTo(p[i][0], p[i][1], m[0], m[1]); ctx.stroke();
        prev = m;
      }
      const last = p[p.length - 1];
      ctx.lineWidth = pieceWidth(s, last[2], last[0] - prev[0], last[1] - prev[1]);
      ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(last[0], last[1]); ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------- Text ----------
export const LINE_H = 1.3;
export function textLines(t) {
  measure.font = `${t.size}px ${FONT}`;
  const out = [];
  for (const para of (t.text || '').split('\n')) {
    let line = '';
    for (const w of para.split(/(\s+)/)) {
      const test = line + w;
      if (measure.measureText(test).width > t.w && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    out.push(line);
  }
  return out;
}
export const textHeight = t => Math.max(1, textLines(t).length) * t.size * LINE_H;

function drawText(ctx, t) {
  ctx.save();
  ctx.font = `${t.size}px ${FONT}`;
  ctx.fillStyle = t.color; ctx.textBaseline = 'top';
  textLines(t).forEach((l, i) => ctx.fillText(l, t.x, t.y + i * t.size * LINE_H + t.size * 0.15));
  ctx.restore();
}

// ---------- Pages ----------
export async function renderPage(ctx, page, scale, hideId) {
  const srcs = [page.bg, ...page.elements.filter(e => e.type === 'image').map(e => e.src)].filter(Boolean);
  const imgs = new Map(await Promise.all(srcs.map(async s => [s, await loadImage(s)])));
  const h = pageH(page);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = paperColor(page); ctx.fillRect(0, 0, PAGE_W, h);
  if (page.bg && imgs.get(page.bg)) ctx.drawImage(imgs.get(page.bg), 0, 0, PAGE_W, h);
  drawTemplate(ctx, page.template, h, page.paper === 'dark');
  for (const e of page.elements) {
    if (e.id === hideId) continue;
    if (e.type === 'stroke') drawStroke(ctx, e);
    else if (e.type === 'text') drawText(ctx, e);
    else if (e.type === 'image' && imgs.get(e.src)) ctx.drawImage(imgs.get(e.src), e.x, e.y, e.w, e.h);
  }
}

export async function renderThumb(canvas, page, width) {
  canvas.width = width; canvas.height = Math.round(width * pageH(page) / PAGE_W);
  await renderPage(canvas.getContext('2d'), page, width / PAGE_W);
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
    const lines = textLines(e);
    measure.font = `${e.size}px ${FONT}`;
    const w = Math.max(e.size, ...lines.map(l => measure.measureText(l).width));
    return { x: e.x, y: e.y, w, h: Math.max(1, lines.length) * e.size * LINE_H };
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
    return { ...e, width: e.width * k, points: e.points.map(p => { const [x, y] = fn(p[0], p[1]); return [r1(x), r1(y), p[2]]; }) };
  }
  const [x, y] = fn(e.x, e.y);
  if (e.type === 'text') return { ...e, x, y, w: e.w * k, size: e.size * k };
  return { ...e, x, y, w: e.w * k, h: e.h * k };
}
