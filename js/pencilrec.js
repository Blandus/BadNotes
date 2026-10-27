// Pencil diagnostics: records the raw pen input of pen strokes (every event with its coalesced
// and predicted samples, pressure, tilt, time stamps), how long Folio took to handle each event,
// the display's frame times and the stroke Folio stored — so real Apple Pencil data can be
// replayed and compared (e.g. with the same text exported from Goodnotes) on another computer.
// Switched on in Einstellungen → Stift; nothing is recorded otherwise. Data stays on the device
// until "Sichern" shares or downloads it as a JSON file.
import { h } from './util.js';
import { APP_VERSION } from './store.js';
import { toast } from './ui.js';

const rec = { on: false, strokes: [], started: 0 };
let cur = null, badge = null;

export const recording = () => rec.on;

const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = v => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);
const sample = e => [r2(e.timeStamp), r2(e.clientX), r2(e.clientY), r4(e.pressure), e.pointerType || '', r2(e.tiltX), r2(e.tiltY), r4(e.altitudeAngle), r4(e.azimuthAngle)];

// Frame times for ms milliseconds while nothing is drawn: shows whether the system itself limits
// the frame rate (e.g. 30 fps in Low Power Mode) or only drawing is slow.
const idleFrames = (ms = 1000) => new Promise(res => {
  const t = [];
  const loop = now => { t.push(now); if (now - t[0] < ms) requestAnimationFrame(loop); else res(t.slice(1).map((v, i) => r2(v - t[i]))); };
  requestAnimationFrame(loop);
});
const fps = gaps => { const s = gaps.filter(v => v > 0).sort((a, b) => a - b); return s.length ? Math.round(1000 / s[s.length >> 1]) : null; };

export function setRecording(on) {
  rec.on = on;
  if (on) {
    rec.strokes = []; rec.started = Date.now(); rec.idle = null; rec.idleAfter = null; rec.lastFps = null;
    setTimeout(() => idleFrames().then(g => { rec.idle = g; update(); }), 300);
    badge ||= h('div', { class: 'rec-badge' },
      h('span', { class: 'rec-dot' }), h('span', { class: 'rec-count' }),
      h('button', { onclick: save }, 'Sichern'),
      h('button', { onclick: () => setRecording(false) }, 'Beenden'));
    document.body.append(badge);
    update();
  } else {
    cur = null;
    badge?.remove();
  }
}
const update = () => {
  if (!badge) return;
  const n = rec.strokes.length, idle = rec.idle ? fps(rec.idle) : null;
  badge.querySelector('.rec-count').textContent = `Pencil-Aufzeichnung · ${n} ${n === 1 ? 'Strich' : 'Striche'}`
    + (idle ? ` · Ruhe ${idle} fps` : '') + (rec.lastFps ? ` · Schreiben ${rec.lastFps} fps` : '');
};

// d: the drawing state of a new pen stroke (tools.js), e: its pointerdown
export function recBegin(d, e, info) {
  if (!rec.on) return;
  cur = {
    t: Date.now(), down: sample(e), zoom: info.zoom, ppu: info.ppu,
    rect: { left: d.rect.left, top: d.rect.top, width: d.rect.width, height: d.rect.height },
    page: { w: info.pageW, h: info.pageH, x0: info.x0, y0: info.y0, template: d.page.template, paper: d.page.paper },
    pen: { pen: d.stroke.pen, width: d.stroke.width, color: d.stroke.color, sharp: d.stroke.sharp, press: d.stroke.press, stab: info.stab },
    moves: [], frames: [],
  };
  // the display's frame times while the pen is down (60 or 120 Hz?)
  const c = cur;
  const loop = t => { if (cur !== c) return; c.frames.push(r2(t)); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
// at: performance.now() when Folio started handling the event; the handler's duration follows
export function recMove(e, at) {
  if (!cur) return;
  const c = e.getCoalescedEvents ? e.getCoalescedEvents() : [], p = e.getPredictedEvents ? e.getPredictedEvents() : [];
  cur.moves.push({ at: r2(at), ms: r2(performance.now() - at), e: sample(e), c: c.map(sample), p: p.map(sample) });
}
export function recUp(e) { if (cur) cur.up = sample(e); }
// s: the stroke as stored (null when the stroke was cancelled or became something else)
export function recEnd(s) {
  if (!cur) return;
  cur.stored = s ? { points: s.points, ink: s.ink, rad: s.rad, shape: !!s.shape } : null;
  rec.strokes.push(cur);
  const f = cur.frames.slice(1).map((v, i) => v - cur.frames[i]);
  if (f.length >= 3) rec.lastFps = fps(f);
  cur = null;
  update();
  // idle frame rate once the hand rests (measured again after a pause in writing)
  clearTimeout(rec.idleT);
  rec.idleT = setTimeout(() => { if (!cur && rec.on) idleFrames(600).then(g => { if (!cur) { rec.idleAfter = g; rec.idle = g; update(); } }); }, 1500);
}

async function save() {
  if (!rec.strokes.length) return toast('Noch keine Striche aufgezeichnet');
  // (no await before sharing: the share sheet needs the tap's user activation)
  const data = {
    idleFrameMs: { start: rec.idle, afterStrokes: rec.idleAfter || null },
    folio: APP_VERSION, recorded: new Date(rec.started).toISOString(), userAgent: navigator.userAgent,
    dpr: window.devicePixelRatio, screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight],
    standalone: matchMedia('(display-mode: standalone)').matches,
    api: { coalesced: 'getCoalescedEvents' in PointerEvent.prototype, predicted: 'getPredictedEvents' in PointerEvent.prototype },
    strokes: rec.strokes,
  };
  const name = `Folio Pencil-Aufzeichnung ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (err) { if (err.name === 'AbortError') return; }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
