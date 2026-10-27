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
// Corners: the direction over SMOOTH.corner px before and after a point turns by more than
// SMOOTH.cornerDeg (3 px, 75° since v61: 2 px / 60° still took slow, shaky bits for corners); of
// the points around one corner only the sharpest is kept (the tip of a v, z, k). Measuring over
// a distance, not over 3 samples (as before v55), keeps sensor noise of slow strokes — samples
// ~0.4 px apart — from being taken for corners and left unsmoothed.
// Radii (pressure): plain Gaussian along the arc length (σ 6 px): the hand's pressure flutter at
// 5–10 Hz (both edges bulging every 10–20 px) is evened out, while a stroke still gets thinner
// and fuller with the pressure, as the same sentence written in Goodnotes shows.
// px: centre line (stabilisation raises it up to 4×), width, corner test, point spacing, end hooks,
// curve-fit tolerance of the stored stroke (0 keeps every point); fitR: its radius tolerance (share);
// fitEdge / fitGap: a key point that far from piece ends / keys at most that far apart (px);
// start: how far a stroke's first pressure is raised towards the usual one (the Pencil reports
// ~0.08 for its first few samples, which made starts thinner than in Goodnotes)
export const SMOOTH = { sigma: 1.4, sigmaR: 6, corner: 3, cornerDeg: 75, step: 0.4, hook: 5, fit: 0.25, fitR: 0.15, fitEdge: 1.5, fitGap: 8, start: 0.5 };
function cornersOf(p, s, dc) {
  const cosMax = Math.cos(SMOOTH.cornerDeg * Math.PI / 180);
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
    if (cos[i] >= cosMax) continue;
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

// ---------- Curve fit of a finished stroke ----------
// Goodnotes stores a written stroke as a few smooth curve pieces (the same sentence: 9 points per
// stroke, ~1.9 page units apart), Folio stored every accepted sample (63 per stroke, 0.5 apart),
// so the slightest unsteadiness stayed in the line. The finished centre line is reduced to key
// points (Douglas–Peucker: centre within tol, radius within 4 %), and the control points are
// solved so that Folio's curve (quadratic pieces between control-point midpoints, ink.js) runs
// through every key point — fewer points, the same shape within tol.
// Two more rules (v62): keys at most `gap` apart along the line, and one key `edge` after the start
// and before the end of every piece. Without them a nearly straight l or t kept only its two ends
// and became a ruler-straight line, and the straight run-out of Folio's curve at stroke ends and
// corners (up to the middle of the last two control points) grew long and visible.
function keyPoints(p, tol, edge = 0, gap = Infinity) {
  const n = p.length, keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const s = [0]; for (let i = 1; i < n; i++) s.push(s[i - 1] + dist(p[i - 1], p[i]));
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay, ar] = p[a], [bx, by, br] = p[b], dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let worst = 1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      const t = l2 ? Math.max(0, Math.min(1, ((p[i][0] - ax) * dx + (p[i][1] - ay) * dy) / l2)) : 0;
      const e = Math.max(Math.hypot(p[i][0] - ax - t * dx, p[i][1] - ay - t * dy) / tol, Math.abs(p[i][2] - ar - t * (br - ar)) / Math.max(0.03, SMOOTH.fitR * p[i][2]));
      if (e > worst) { worst = e; wi = i; }
    }
    if (wi >= 0) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  if (s[n - 1] > 3 * edge) {
    let i = 1; while (i < n - 1 && s[i] < edge) i++; keep[i] = 1;
    let j = n - 2; while (j > 0 && s[n - 1] - s[j] < edge) j--; keep[j] = 1;
  }
  for (let a = 0; a < n - 1;) {
    let b = a + 1; while (!keep[b]) b++;
    if (s[b] - s[a] > gap && b - a > 1) { let m = a + 1; while (m < b - 1 && s[m] - s[a] < (s[b] - s[a]) / 2) m++; keep[m] = 1; continue; }
    a = b;
  }
  return p.filter((_, i) => keep[i]);
}
// Control points C (C0 = first, Cm = last key point) such that the middle of every curved piece
// equals the next key point: piece i → (C_{i-1} + 6 C_i + C_{i+1}) / 8, the first one
// 0.25 C0 + 0.625 C1 + 0.125 C2 at the start of a stroke; a tridiagonal system, solved per
// coordinate (Thomas algorithm). Radii are taken from the keys.
// A stroke is fitted piece by piece between its corners, and every corner becomes a doubled
// control point: Folio's curve then runs straight into it and out of it — the tip of a v or z
// stays sharp (one smooth fit across it rounded tips off by ~3 page units). After a corner the
// first curved piece starts at the middle of C0–C1, so its row is (C0 + 6 C1 + C2) / 8 as well.
function fitPiece(points, tol, afterCorner, edge, gap) {
  const K = keyPoints(points, tol, edge, gap), m = K.length - 1;
  if (m < 2) return K;
  const n = m - 1, b0 = afterCorner ? 0.75 : 0.625, a0 = afterCorner ? 0.125 : 0.25;
  const solve = c => {
    const a = new Float64Array(n), b = new Float64Array(n), cc = new Float64Array(n), d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = i === 0 ? 0 : 0.125; b[i] = i === 0 ? b0 : 0.75; cc[i] = i === n - 1 ? 0 : 0.125;
      d[i] = K[i + 1][c] - (i === 0 ? a0 * K[0][c] : 0) - (i === n - 1 ? 0.125 * K[m][c] : 0);
    }
    for (let i = 1; i < n; i++) { const w = a[i] / b[i - 1]; b[i] -= w * cc[i - 1]; d[i] -= w * d[i - 1]; }
    const x = new Float64Array(n); x[n - 1] = d[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) x[i] = (d[i] - cc[i] * x[i + 1]) / b[i];
    return x;
  };
  const X = solve(0), Y = solve(1);
  return [K[0], ...K.slice(1, m).map((k, i) => [rp(X[i]), rp(Y[i]), k[2]]), K[m]];
}
// corner: flags per point (cornersOf)
export function fitCurve(points, tol, corner, edge = 0, gap = Infinity) {
  if (points.length < 4) return points;
  let out = [], s = 0;
  for (let i = 1; i < points.length; i++) {
    if (i < points.length - 1 && !corner?.[i]) continue;
    const part = fitPiece(points.slice(s, i + 1), tol, s > 0, edge, gap);
    out = out.length ? out.concat(part) : part; // the corner point is in both: doubled
    s = i;
  }
  return out;
}

// Mouse and finger report no pressure (always 0.5). Their pressure is simulated from the
// speed on screen, like ink: a slow line gets a little heavier, a fast flick thinner.
// px/ms → pressure; 1 px/ms (an ordinary handwriting speed) gives the nominal 0.5.
const simulatedPressure = speed => clamp(0.62 - 0.12 * speed, 0.3, 0.68);

export class PenInput {
  // pref: the writer's usual pen pressure (pieceWidth); simulated pressure is centred on 0.5
  constructor(stroke, point, time, scale, stabilization = 0, simulate = false, pref = 0.5) {
    this.simulate = simulate;
    this.pref = simulate ? 0.5 : clamp(pref, 0.05, 0.9);
    this.pressures = []; // real pen pressures of this stroke (to learn the usual pressure)
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
    // filter there made a knob at the start of many strokes. Start at most at the usual pressure
    // and let the filter follow the real pressure from there.
    this.filtered = [point[0], point[1], Math.min(point[2] + (this.pref - point[2]) * SMOOTH.start, this.pref)];
    this.dotRadius = this.radiusAt(this.filtered[2]);
    this.points = [[rp(point[0]), rp(point[1]), this.dotRadius]];
    this.lens = [0]; // arc length of this.points
  }

  radiusAt(p) { return pieceWidth(this.stroke, p, 0, 0, this.pref) / 2; }
  // median pressure of the stroke (null for mouse/finger or very short strokes)
  usualPressure() {
    const p = this.pressures; if (p.length < 8) return null;
    const s = [...p].sort((a, b) => a - b); return s[s.length >> 1];
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
    if (h.length > 24) h.shift();
    const radius = this.radiusAt(next[2]);
    if (!this.simulate && point[2] > 0) this.pressures.push(point[2]);
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

  // Where the pen will be h ms after its last sample — the provisional tip shown on the replaceable
  // tail, replaced by the real points in the next frame and never stored. Measured on recorded
  // Pencil writing: the line reaches the screen about a frame after the event, and Safari's own
  // predicted events reach only ~8 ms ahead, so the drawn tip trailed the pen by 4.2 px (median,
  // 7.5 px without prediction). A quadratic least-squares fit of the last 24 ms, extrapolated with
  // 80 % of the time and never further than 1.2× the distance the pen moved in the same time
  // just before (no jumps at turns), trails by 2.4 px. Returns [] with too few samples.
  predict(h) {
    const hs = this.hist;
    if (!hs || hs.length < 4 || !(h > 0)) return [];
    const now = hs[hs.length - 1];
    let j = hs.length - 1; while (j > 0 && now[2] - hs[j - 1][2] <= 24) j--;
    const pts = hs.slice(j);
    if (pts.length < 4) return [];
    const fit = c => { // v(t) = a + b t + c t², t relative to now
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (const p of pts) { const t = p[2] - now[2], v = p[c]; s0++; s1 += t; s2 += t * t; s3 += t ** 3; s4 += t ** 4; b0 += v; b1 += v * t; b2 += v * t * t; }
      const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const M = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], B = [b0, b1, b2], D = det(M);
      if (Math.abs(D) < 1e-9) return null;
      return [0, 1, 2].map(k => det(M.map((r, i) => r.map((v, jj) => (jj === k ? B[i] : v)))) / D);
    };
    const fx = fit(0), fy = fit(1);
    if (!fx || !fy) return [];
    const t = 0.8 * h;
    let dx = fx[0] + fx[1] * t + fx[2] * t * t - now[0], dy = fy[0] + fy[1] * t + fy[2] * t * t - now[1];
    // the pen's own pace: distance covered in the last h ms
    let k = hs.length - 1; while (k > 0 && now[2] - hs[k][2] < h) k--;
    const max = 1.2 * dist(now, hs[k]), len = Math.hypot(dx, dy);
    if (len > max) { dx *= max / (len || 1); dy *= max / (len || 1); }
    if (Math.hypot(dx, dy) * this.scale < 0.3) return [];
    return [[now[0] + dx, now[1] + dy, this.filtered[2], now[2] + h]];
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
  // small comma or knob at a stroke's ends (Goodnotes shows none). A sharp turn (> 60°) within
  // the first / last HOOK px is cut off. The start is decided once 2 × HOOK px are written —
  // long before anything is painted permanently — the end when the stroke is finished.
  dehook(atEnd) {
    const acc = this.points, lens = this.lens, n = acc.length, D = SMOOTH.hook / this.scale, total = lens[n - 1];
    if (total < 4 * D) return;
    const pos = k => atEnd ? acc[n - 1 - k] : acc[k], len = k => atEnd ? total - lens[n - 1 - k] : lens[k];
    let cut = 0, sharpest = 0.5; // cos: turns sharper than 60°
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
      const q = [rp(this.raw[0]), rp(this.raw[1]), this.radiusAt(this.filtered[2])];
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
    const pts = view.points.map((p, i) => [p[0], p[1], round(tipRadius(this.stroke, p[2], view.lengths[i], view.total))]);
    if (!SMOOTH.fit) return pts;
    return fitCurve(pts, SMOOTH.fit / this.scale, cornersOf(pts, view.lengths, SMOOTH.corner / this.scale), SMOOTH.fitEdge / this.scale, SMOOTH.fitGap / this.scale);
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
