// Pencil input → stored centre line: smoothed along the stroke in screen pixels (shape-preserving),
// corners kept; pressure filtered separately; predictions are temporary and never stored.
import { pieceWidth, tipRadius } from './ink.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
const mix = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = v => Math.round(v * 1000) / 1000;
// Positions are kept to 0.01 page units: 0.1 (as before v55) made a visible staircase at high
// zoom (at 1000 % one unit is ~17 device pixels on an iPad).
const rp = v => Math.round(v * 100) / 100;

// ---------- Centre line filter (also used for the replaceable live tail) ----------
// Smoothing is measured along the stroke in screen pixels at the zoom it is written at, not in
// samples: a per-sample filter (as before v55) was weak on slow strokes (jittery edges) and
// strong on fast ones (small loops of e, l, o pulled in by up to 9 %, tips of v and z rounded).
// Positions: Gaussian average along the arc length, "twiced" (2·G − G∘G, Tukey): jitter shorter
// than ~3 px is removed, while the shape of letters is kept almost exactly (the shrinking of a
// plain average cancels to second order). Corners and both ends keep their position; the
// average never reaches across them.
// Corners: the direction over CORNER px before and after a point turns by more than 60°; of
// the points around one corner only the sharpest is kept (the tip of a v, z, k). Measuring over
// a distance, not over 3 samples (as before v55), keeps sensor noise of slow strokes — samples
// ~0.4 px apart — from being taken for corners and left unsmoothed.
// Radii (pressure): plain Gaussian along the arc length (σ 10 px), so the width swells and thins
// calmly: the hand's pressure flutters at 5–10 Hz, which made both edges bulge every 10–20 px.
// px: centre line (stabilisation raises it up to 4×), width, corner test, point spacing, end hooks
export const SMOOTH = { sigma: 1.4, sigmaR: 10, corner: 2, step: 0.4, hook: 3 };
function cornersOf(p, s, dc) {
  const n = p.length, cos = new Float64Array(n).fill(1);
  for (let i = 1, a = 0, b = 1; i < n - 1; i++) {
    while (a + 1 < i && s[i] - s[a + 1] >= dc) a++; // last point at least dc before i
    if (b <= i) b = i + 1;
    while (b < n - 1 && s[b] - s[i] < dc) b++; // first point at least dc after i
    if (s[i] - s[a] < dc || s[b] - s[i] < dc) continue; // too close to an end to tell
    const ax = p[i][0] - p[a][0], ay = p[i][1] - p[a][1], bx = p[b][0] - p[i][0], by = p[b][1] - p[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la && lb) cos[i] = (ax * bx + ay * by) / (la * lb);
  }
  // keep a candidate only where it is the sharpest within dc on both sides (ties: the first)
  const corner = new Uint8Array(n);
  for (let i = 1; i < n - 1; i++) {
    if (cos[i] >= 0.5) continue;
    let best = true;
    for (let j = i - 1; best && j > 0 && s[i] - s[j] <= dc; j--) if (cos[j] <= cos[i]) best = false;
    for (let j = i + 1; best && j < n - 1 && s[j] - s[i] <= dc; j++) if (cos[j] < cos[i]) best = false;
    if (best) corner[i] = 1;
  }
  return corner;
}
// Gaussian average of v by arc length s (window ±3σ). Fixed entries keep their value and end
// the window (they are included, nothing beyond them).
function blur(v, s, sigma, fixed) {
  const n = v.length, out = new Float64Array(n), lim = 3 * sigma, k = -1 / (2 * sigma * sigma);
  for (let i = 0; i < n; i++) {
    if (fixed && fixed[i]) { out[i] = v[i]; continue; }
    let sum = v[i], wsum = 1;
    for (let j = i - 1; j >= 0 && s[i] - s[j] <= lim; j--) { const w = Math.exp(k * (s[i] - s[j]) ** 2); sum += w * v[j]; wsum += w; if (fixed && fixed[j]) break; }
    for (let j = i + 1; j < n && s[j] - s[i] <= lim; j++) { const w = Math.exp(k * (s[j] - s[i]) ** 2); sum += w * v[j]; wsum += w; if (fixed && fixed[j]) break; }
    out[i] = sum / wsum;
  }
  return out;
}
// points [x, y, r] with cumulative arc lengths s; sigma, sigmaR, dc (corner distance) in page units
function smoothLine(points, s, sigma, sigmaR, dc) {
  const n = points.length;
  if (n < 3) return points.map(q => [rp(q[0]), rp(q[1]), q[2]]);
  const fixed = cornersOf(points, s, dc); fixed[0] = fixed[n - 1] = 1;
  const twice = v => { const g = blur(v, s, sigma, fixed), gg = blur(g, s, sigma, fixed); return g.map((x, i) => 2 * x - gg[i]); };
  const x = twice(points.map(q => q[0])), y = twice(points.map(q => q[1]));
  const r = blur(points.map(q => q[2]), s, sigmaR, null);
  return points.map((_, i) => [rp(x[i]), rp(y[i]), r[i]]);
}

// Mouse and finger report no pressure (always 0.5). Their pressure is simulated from the
// speed on screen, like ink: a slow line gets a little heavier, a fast flick thinner.
// px/ms → pressure; 1 px/ms (an ordinary handwriting speed) gives the nominal 0.5.
const simulatedPressure = speed => clamp(0.62 - 0.12 * speed, 0.3, 0.68);

export class PenInput {
  constructor(stroke, point, time, scale, stabilization = 0, simulate = false) {
    this.simulate = simulate;
    this.speed = 0.5; // smoothed screen speed (px/ms) for simulated pressure
    if (simulate) point = [point[0], point[1], simulatedPressure(this.speed)];
    this.stroke = stroke;
    this.scale = Math.max(0.001, scale);
    this.stabilization = clamp(stabilization || 0, 0, 1);
    this.time = Number.isFinite(time) ? time : 0;
    this.lastTime = this.time; this.moved = 0; this.elapsed = 0; // speed measurement (simulated pressure)
    this.dt = 1 / 120;
    this.raw = point.slice();
    // The Pencil's first contact sample often carries a pressure spike; starting the pressure
    // filter there made a knob at the start of many strokes. Start at most at medium pressure
    // and let the filter follow the real pressure from there.
    this.filtered = [point[0], point[1], Math.min(point[2], 0.5)];
    this.dotRadius = pieceWidth(stroke, this.filtered[2]) / 2;
    this.points = [[rp(point[0]), rp(point[1]), this.dotRadius]];
    this.lens = [0]; // arc length of this.points
  }

  push(point, time) {
    if (!point.every(Number.isFinite)) return;
    const dt = Number.isFinite(time) && time > this.time ? clamp((time - this.time) / 1000, 0.0001, 0.1) : this.dt;
    this.dt = dt;
    if (Number.isFinite(time)) this.time = Math.max(this.time, time);
    if (this.simulate) {
      // Speed over at least 4 ms (events can share a time stamp), gently filtered (≈6 Hz) so
      // single jittery mouse events don't make beads.
      this.moved += dist(point, this.raw) * this.scale;
      if (Number.isFinite(time) && time > this.lastTime) { this.elapsed += time - this.lastTime; this.lastTime = time; }
      if (this.elapsed >= 4) {
        this.speed = mix(this.speed, Math.min(this.moved / this.elapsed, 6), alpha(6, this.elapsed / 1000));
        this.moved = this.elapsed = 0;
      }
      point = [point[0], point[1], simulatedPressure(this.speed)];
    }
    // Positions are taken as they come (no lag behind the pen); the centre line filter removes
    // the jitter. Pressure gets a light causal filter here and the calm one along the stroke.
    const next = [point[0], point[1], mix(this.filtered[2], clamp(point[2], 0, 1), alpha(25, dt))];
    this.filtered = next;
    this.raw = point.slice();
    const h = this.hist || (this.hist = []);
    h.push([point[0], point[1], this.time]);
    if (h.length > 12) h.shift();
    const radius = pieceWidth(this.stroke, next[2]) / 2;
    this.dotRadius = Math.max(this.dotRadius, radius);
    // Samples closer than SMOOTH.step to the last point are averaged, not dropped: a slow stroke
    // gives several samples per point, and their mean is steadier than any single one.
    const b = this.bucket || (this.bucket = [0, 0, 0]);
    b[0] += next[0]; b[1] += next[1]; b[2]++;
    const last = this.points[this.points.length - 1];
    const mean = [b[0] / b[2], b[1] / b[2]];
    if (dist(last, mean) < SMOOTH.step / this.scale) return;
    const q = [rp(mean[0]), rp(mean[1]), radius];
    this.bucket = null;
    this.lens.push(this.lens[this.lens.length - 1] + dist(last, q));
    this.points.push(q);
  }

  // A provisional tip one frame (ms) ahead, for browsers that give no predicted events: the
  // pen's velocity over the last ~10 ms, damped and at most 12 px long. Shown on the replaceable
  // tail only and replaced by the real points in the next frame; never stored.
  extrapolate(ms) {
    const h = this.hist;
    if (!h || h.length < 2) return [];
    const now = h[h.length - 1];
    let old = h[h.length - 2];
    for (let i = h.length - 2; i >= 0; i--) { old = h[i]; if (now[2] - old[2] >= 10) break; }
    const dt = now[2] - old[2];
    if (dt < 4) return [];
    const k = 0.8 * ms / dt, max = 12 / this.scale;
    let dx = (now[0] - old[0]) * k, dy = (now[1] - old[1]) * k;
    const len = Math.hypot(dx, dy);
    if (len * this.scale < 0.5) return [];
    if (len > max) { dx *= max / len; dy *= max / len; }
    return [[now[0] + dx, now[1] + dy, this.filtered[2], now[2] + ms]];
  }

  // A released Pencil normally reports zero pressure. Use its final position without
  // replacing the last contact pressure with a fabricated medium-pressure value.
  end(point, time) {
    if (!point || !point.slice(0, 2).every(Number.isFinite)) return;
    this.push([point[0], point[1], point[2] > 0 ? point[2] : this.raw[2]], time);
  }

  // The smoothed centre line so far. A smoothed point depends only on input points within
  // REACH along the stroke (6σ for the twiced centre line or 3σ for the width, plus 2× the
  // corner distance) and at most one point beyond. Points that far from the end never change
  // again: they are cached, and each frame only re-smooths the last stretch, starting far
  // enough back that the result is exactly that of smoothing the whole stroke. The cost per
  // frame stays constant however long the stroke gets (long lines on infinite pages).
  // Hooks: the Pencil often slides a little when it touches down or lifts off, which left a
  // small comma or knob at a stroke's ends (Goodnotes shows none). A sharp turn (> 72°) within
  // the first / last HOOK px is cut off. The start is decided once 2 × HOOK px are written —
  // long before anything is painted permanently — the end when the stroke is finished.
  dehook(atEnd) {
    const acc = this.points, lens = this.lens, n = acc.length, D = SMOOTH.hook / this.scale, total = lens[n - 1];
    if (total < 4 * D) return;
    const pos = k => atEnd ? acc[n - 1 - k] : acc[k], len = k => atEnd ? total - lens[n - 1 - k] : lens[k];
    let cut = 0, sharpest = 0.3; // cos: turns sharper than ~72°
    for (let i = 1, j = 2; i < n - 1 && len(i) <= D; i++) {
      if (j <= i) j = i + 1;
      while (j < n - 1 && len(j) - len(i) < D) j++;
      const a = pos(i), o = pos(0), b = pos(j);
      const ax = a[0] - o[0], ay = a[1] - o[1], bx = b[0] - a[0], by = b[1] - a[1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la * this.scale < 0.3 || !lb) continue;
      const c = (ax * bx + ay * by) / (la * lb);
      if (c < sharpest) { sharpest = c; cut = i; }
    }
    if (!cut) return;
    if (atEnd) {
      acc.length = n - cut; lens.length = n - cut;
      this.raw = [acc[n - cut - 1][0], acc[n - cut - 1][1], this.raw[2]];
    } else {
      // in place: the stroke being drawn shares this array
      const off = lens[cut];
      acc.splice(0, cut); lens.splice(0, cut);
      for (let k = 0; k < lens.length; k++) lens[k] -= off;
    }
  }

  view() {
    if (!this.hookDone && this.lens[this.lens.length - 1] >= 2 * SMOOTH.hook / this.scale) { this.hookDone = true; this.dehook(false); }
    const acc = this.points, lens = this.lens, n = acc.length;
    const sigma = SMOOTH.sigma * (1 + 3 * this.stabilization) / this.scale, sigmaR = SMOOTH.sigmaR / this.scale;
    const dc = SMOOTH.corner / this.scale;
    const REACH = Math.max(6 * sigma, 3 * sigmaR) + 2 * dc;
    const sm = this.sm || (this.sm = { points: [], lengths: [], start: 0 });
    const f = sm.points.length;
    // first input point of the stretch: nothing it (or the cut-off corner test right after it)
    // touches can reach the points from f on
    const ok = s => s + 3 <= f && lens[f] - lens[s + 3] > REACH + dc;
    while (ok(sm.start + 1)) sm.start++;
    const start = sm.start;
    const part = acc.slice(start), s = lens.slice(start);
    if (dist(acc[n - 1], this.raw) > SMOOTH.step / this.scale) {
      const q = [rp(this.raw[0]), rp(this.raw[1]), pieceWidth(this.stroke, this.filtered[2]) / 2];
      s.push(s[s.length - 1] + dist(acc[n - 1], q)); part.push(q);
    }
    const out = smoothLine(part, s, sigma, sigmaR, dc);
    // newly settled points move into the cache
    const m = n - 3;
    for (let i = f; i <= m && lens[m] - lens[i] > REACH; i++) {
      const q = out[i - start], prev = sm.points[i - 1];
      sm.lengths.push(prev ? sm.lengths[i - 1] + dist(prev, q) : 0);
      sm.points.push(q);
    }
    const points = sm.points.concat(out.slice(sm.points.length - start));
    const lengths = sm.lengths.slice();
    for (let i = lengths.length; i < points.length; i++) lengths.push(i ? lengths[i - 1] + dist(points[i - 1], points[i]) : 0);
    // Only settled points may be painted permanently; the rest stays on the replaceable overlay,
    // so the permanent prefix is identical before and after the next input / the lift.
    return { points, lengths, total: lengths[lengths.length - 1], fixedCount: Math.max(1, sm.points.length) };
  }

  finish() {
    this.view(); // decides the start hook of a short stroke, too
    this.dehook(true);
    const view = this.view();
    if (view.total * this.scale < 0.35) {
      return [[this.points[0][0], this.points[0][1], round(this.dotRadius)]];
    }
    return view.points.map((p, i) => [p[0], p[1], round(tipRadius(this.stroke, p[2], view.lengths[i], view.total))]);
  }
}

// Predictions affect the temporary tail only, never the saved geometry.
export function penPredictions(events, time, last, scale) {
  const out = [];
  for (const e of events || []) {
    if (!e.every(Number.isFinite) || e[3] < time || e[3] - time > 16) continue;
    if (dist(e, last) * scale > 12) break;
    out.push(e);
  }
  return out;
}
