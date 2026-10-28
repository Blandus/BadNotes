// Handwriting on flashcards: a small writing pad and the display of what was written.
// Strokes are the same as on notebook pages (ink: 2, a radius per point, see ink.js) and go
// through the same pen pipeline (PenInput in handwriting.js: smoothing, pressure, hooks, curve
// fit), so writing looks exactly as in a notebook. Stored per card side:
//   { w: 1000, h: 500, strokes: [stroke] }    (the pad is 2:1, units like a page that is 1000 wide)
// The pen is the notebook pen (type, colours, widths, sharpness, stabilisation; T.pen in editor.js):
// changing colour or width here changes it there too.
import { h, uid } from './util.js';
import { icon } from './icons.js';
import { settings } from './store.js';
import { drawStroke } from './render.js';
import { strokeSamples, addSamplesToPath, tipRadius } from './ink.js';
import { PenInput } from './handwriting.js';
import { T, PALETTE, saveTools } from './editor.js';
import { popover, closePopover } from './ui.js';

export const PAD_W = 1000, PAD_H = 500;
export const hasInk = ink => !!ink?.strokes?.length;

let sawPen = false; // once the Apple Pencil was used, a finger never draws (palm, scrolling)
const fingerDraws = () => !!settings.fingerDraw || !sawPen;

// Bounding box of all strokes (with their radius)
function inkBox(ink) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of ink.strokes) for (const [x, y, r = 2] of s.points) {
    if (x - r < x0) x0 = x - r; if (y - r < y0) y0 = y - r;
    if (x + r > x1) x1 = x + r; if (y + r > y1) y1 = y + r;
  }
  return [x0, y0, x1, y1];
}

// What was written, cut to its own size: at most `maxW` css px wide (at most 1.5× the size it
// was written at) and `maxH` high. White paper as in notebooks, also in dark mode.
export function inkView(ink, { maxW = 640, maxH = 320, cls = '' } = {}) {
  const c = h('canvas', { class: 'ink-view ' + cls, role: 'img', 'aria-label': 'Handschrift' });
  if (!hasInk(ink)) return c;
  const [x0, y0, x1, y1] = inkBox(ink), pad = 18;
  const bw = x1 - x0 + 2 * pad, bh = y1 - y0 + 2 * pad;
  const k = Math.min(maxW / bw, maxH / bh, (maxW / (ink.w || PAD_W)) * 1.5);
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  c.style.width = Math.round(bw * k) + 'px'; c.style.height = Math.round(bh * k) + 'px';
  c.width = Math.ceil(bw * k * dpr); c.height = Math.ceil(bh * k * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(k * dpr, 0, 0, k * dpr, (pad - x0) * k * dpr, (pad - y0) * k * dpr);
  for (const s of ink.strokes) drawStroke(ctx, s);
  return c;
}

function hitStroke(s, [x, y], r) {
  const p = s.points;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[i + 1] || a;
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
    if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) <= r + (a[2] || 1)) return true;
  }
  return false;
}

// The writing pad. ink: the stored side (or null). onChange() after every change.
// Returns { el, value() → ink or null }.
export function inkPad(ink, onChange = () => {}) {
  let strokes = ink?.strokes ? ink.strokes.slice() : [];
  const history = [];
  let mode = 'pen';
  const penColor = () => T.pen.colors[T.pen.color] || T.pen.colors[0] || '#0F2747';
  const base = h('canvas', { class: 'ink-base' }), live = h('canvas', { class: 'ink-live' });
  const hint = h('div', { class: 'ink-hint' }, 'Hier schreiben');
  const area = h('div', { class: 'ink-area' }, base, live, hint);
  const bctx = base.getContext('2d'), lctx = live.getContext('2d');
  let k = 1; // device px per pad unit

  const size = () => {
    const w = area.clientWidth;
    if (!w) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    k = (w * dpr) / PAD_W;
    for (const c of [base, live]) { c.width = Math.round(w * dpr); c.height = Math.round(w * dpr * PAD_H / PAD_W); }
    redraw();
  };
  const redraw = () => {
    bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, base.width, base.height);
    bctx.setTransform(k, 0, 0, k, 0, 0);
    for (const s of strokes) drawStroke(bctx, s);
    hint.hidden = strokes.length > 0 || !!cur;
  };
  new ResizeObserver(size).observe(area);

  const change = next => { history.push(strokes); strokes = next; redraw(); onChange(); tools(); };
  const toPad = (e, r) => [(e.clientX - r.left) / r.width * PAD_W, (e.clientY - r.top) / r.height * PAD_H, e.pointerType === 'pen' && Number.isFinite(e.pressure) ? e.pressure : 0.5];

  let cur = null; // { id, input, stroke, rect, erase, before, lastIn }
  area.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') sawPen = true;
    if (cur || (e.pointerType === 'touch' && !fingerDraws()) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    try { area.setPointerCapture(e.pointerId); } catch {}
    const rect = area.getBoundingClientRect(), pt = toPad(e, rect);
    if (mode === 'erase') { cur = { id: e.pointerId, rect, erase: true, before: strokes, work: strokes }; erase(pt); return; }
    const stroke = {
      id: uid(), type: 'stroke', tool: 'pen', pen: T.pen.pen || 'fountain', color: penColor(),
      width: T.pen.widths[T.pen.width] || 3, sharp: T.pen.sharp, press: T.pen.press, ink: 2, rad: 1, points: [],
    };
    const input = new PenInput(stroke, pt, e.timeStamp, rect.width / PAD_W, T.pen.stab, e.pointerType !== 'pen', settings.penPressure || 0.25);
    cur = { id: e.pointerId, rect, stroke, input };
    hint.hidden = true;
    paintLive();
  });
  area.addEventListener('pointermove', e => {
    if (!cur || e.pointerId !== cur.id) return;
    e.preventDefault();
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    // Safari on iPad repeats Pencil samples (see tools.js): only newer samples count
    evs = evs.filter(ev => {
      const l = cur.lastIn, t = ev.timeStamp;
      if (l && (t < l[0] || (t === l[0] && ev.clientX === l[1] && ev.clientY === l[2]))) return false;
      cur.lastIn = [t, ev.clientX, ev.clientY];
      return true;
    });
    if (cur.erase) { for (const ev of evs) erase(toPad(ev, cur.rect)); return; }
    for (const ev of evs) cur.input.push(toPad(ev, cur.rect), ev.timeStamp || e.timeStamp);
    if (!cur.queued) { cur.queued = true; requestAnimationFrame(() => { if (cur) { cur.queued = false; paintLive(); } }); }
  });
  const up = (e, ok) => {
    if (!cur || e.pointerId !== cur.id) return;
    const d = cur; cur = null;
    lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height);
    if (d.erase) { strokes = d.before; if (ok && d.work !== d.before) change(d.work); else redraw(); return; }
    if (!ok) return redraw();
    d.input.end(toPad(e, d.rect), e.timeStamp);
    change([...strokes, { ...d.stroke, points: d.input.finish() }]);
  };
  area.addEventListener('pointerup', e => up(e, true));
  area.addEventListener('pointercancel', e => up(e, false));
  // a long press on the pad must not open the text selection / copy callout
  area.addEventListener('contextmenu', e => e.preventDefault());

  function paintLive() {
    const s = cur.stroke, v = cur.input.view(), p = v.points;
    lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height);
    lctx.setTransform(k, 0, 0, k, 0, 0);
    const path = new Path2D();
    addSamplesToPath(path, strokeSamples(p, i => tipRadius(s, p[i][2], v.lengths[i], v.total)));
    lctx.fillStyle = s.color; lctx.fill(path, 'nonzero');
  }
  function erase(pt) {
    const r = 10;
    const keep = cur.work.filter(s => !hitStroke(s, pt, r));
    if (keep.length !== cur.work.length) { cur.work = keep; strokes = keep; redraw(); }
  }

  // Pen colours and widths are the notebook pen's (T.pen, saved per device): tap = choose, tap
  // the active one again = change it (colour window / width in mm with direct number entry).
  const bar = h('div', { class: 'ink-tools' });
  function tools() {
    const swatches = T.pen.colors.map((c, i) => h('button', {
      class: 'ink-swatch' + (mode === 'pen' && T.pen.color === i ? ' on' : ''), style: { '--c': c },
      title: mode === 'pen' && T.pen.color === i ? 'Farbe ändern' : 'Farbe wählen', 'aria-label': 'Stiftfarbe',
      onclick: e => {
        if (mode === 'pen' && T.pen.color === i) return colorPop(e.currentTarget, i);
        T.pen.color = i; mode = 'pen'; penChanged();
      },
    }));
    const add = T.pen.colors.length < 10 ? h('button', {
      class: 'ink-tool small', title: 'Farbe hinzufügen', 'aria-label': 'Farbe hinzufügen',
      onclick: () => { T.pen.colors.push(penColor()); T.pen.color = T.pen.colors.length - 1; mode = 'pen'; penChanged(); colorPop(bar.querySelector('.ink-swatch.on'), T.pen.color); },
    }, icon('plus', 16)) : null;
    const widths = T.pen.widths.map((w, i) => h('button', {
      class: 'ink-width' + (mode === 'pen' && T.pen.width === i ? ' on' : ''),
      title: fmtMM(w) + ' mm' + (T.pen.width === i ? ' – anpassen' : ''), 'aria-label': 'Stiftstärke ' + fmtMM(w) + ' mm',
      onclick: e => {
        if (mode === 'pen' && T.pen.width === i) return widthPop(e.currentTarget, i);
        T.pen.width = i; mode = 'pen'; penChanged();
      },
    }, h('i', { style: { '--d': Math.max(3, Math.min(20, w * 2.2)) + 'px' } })));
    bar.replaceChildren(
      h('div', { class: 'ink-group' }, ...swatches, add),
      h('div', { class: 'ink-group' }, ...widths),
      h('button', { class: 'ink-tool' + (mode === 'erase' ? ' on' : ''), title: 'Radierer', 'aria-label': 'Radierer', onclick: () => { mode = mode === 'erase' ? 'pen' : 'erase'; tools(); } }, icon('eraser', 20)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'ink-tool', title: 'Rückgängig', 'aria-label': 'Rückgängig', disabled: !history.length, onclick: () => { if (history.length) { strokes = history.pop(); redraw(); onChange(); tools(); } } }, icon('undo', 20)),
      h('button', { class: 'ink-tool', title: 'Alles löschen', 'aria-label': 'Alles löschen', disabled: !strokes.length, onclick: () => change([]) }, icon('trash', 19)));
  }
  // the other pad in the same sheet (front / back) shows the same pen
  const onPen = () => { if (el.isConnected) tools(); else document.removeEventListener('inkpen', onPen); };
  document.addEventListener('inkpen', onPen);
  tools();
  const el = h('div', { class: 'ink-pad' }, area, bar);
  return { el, value: () => (strokes.length ? { w: PAD_W, h: PAD_H, strokes } : null) };
}

function penChanged() { saveTools(); document.dispatchEvent(new Event('inkpen')); }

// Widths in page units, shown in millimetres like the notebook pen (1000 units = 210 mm)
const MM = 1000 / 210;
const fmtMM = w => String(Number((w / MM).toFixed(2))).replace('.', ',');

function widthPop(anchor, i) {
  const min = 0.1, max = 4; // mm
  const set = n => { T.pen.widths[i] = Math.round(n * MM * 100) / 100; penChanged(); };
  const value = h('input', {
    type: 'text', inputmode: 'decimal', class: 'width-value mono', value: fmtMM(T.pen.widths[i]), 'aria-label': 'Stärke in Millimetern',
    onfocus: e => e.target.select(),
    oninput: e => {
      const raw = e.target.value.trim().replace(',', '.'), n = Number(raw);
      const ok = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && n >= min && n <= max;
      e.target.setCustomValidity(ok ? '' : `Wert zwischen 0,1 und 4 mm eingeben.`);
      if (ok) { set(Math.round(n * 100) / 100); range.value = n; }
    },
    onblur: e => { e.target.value = fmtMM(T.pen.widths[i]); e.target.setCustomValidity(''); },
    // Enter must not submit the card sheet underneath
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.target.blur(); } },
  });
  const range = h('input', {
    type: 'range', min, max, step: 0.05, value: T.pen.widths[i] / MM, 'aria-label': 'Stärke in Millimetern',
    oninput: e => { set(+e.target.value); value.value = fmtMM(T.pen.widths[i]); },
  });
  popover(anchor, h('div', { class: 'widthpop' }, h('div', { class: 'pop-title' }, 'Stärke (mm)'), range, value));
}

function colorPop(anchor, i) {
  if (!anchor) return;
  const own = () => (settings.customColors ||= []);
  const set = (c, close) => { T.pen.colors[i] = c; T.pen.color = i; penChanged(); if (close) closePopover(); else draw(); };
  const body = h('div', { class: 'colorpop' });
  const draw = () => {
    const cur = (T.pen.colors[i] || '#000000').toLowerCase();
    const sw = c => h('button', { class: 'pal' + (c.toLowerCase() === cur ? ' active' : ''), style: { '--c': c }, title: c.toUpperCase(), onclick: () => set(c, true) });
    const hex = h('input', { class: 'field mono', value: cur.toUpperCase(), maxlength: 7, 'aria-label': 'Hex-Farbwert',
      onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); e.target.blur(); } } });
    hex.onchange = () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) set(hex.value); };
    const picker = h('input', { type: 'color', class: 'colorwell', value: cur, onchange: e => set(e.target.value), oninput: e => { hex.value = e.target.value.toUpperCase(); } });
    body.replaceChildren(...[ // (replaceChildren would turn null into the text "null")
      h('div', { class: 'palette' }, PALETTE.map(sw)),
      own().length ? h('div', { class: 'pop-title' }, 'Eigene Farben') : null,
      own().length ? h('div', { class: 'palette own' }, own().map(sw)) : null,
      h('div', { class: 'custom-color' }, picker, hex),
      T.pen.colors.length > 1 ? h('button', {
        class: 'menu-item danger pal-remove', onclick: () => {
          T.pen.colors.splice(i, 1); T.pen.color = Math.min(T.pen.color, T.pen.colors.length - 1);
          penChanged(); closePopover();
        },
      }, h('span', { class: 'menu-label' }, 'Aus Direktauswahl entfernen'), h('span', { class: 'menu-icon' }, icon('trash', 18))) : null].filter(Boolean));
  };
  draw();
  popover(anchor, body);
}
