// Preserve the proven centreline smoothing: quantized input must stay round when enlarged.
// Pressure filtering and temporary prediction remain independent of the position filter.
import { pieceWidth, tipRadius } from './ink.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
const mix = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = v => Math.round(v * 1000) / 1000;
const r1 = v => Math.round(v * 10) / 10;
const MIN_STEP = 0.4; // CSS px, as in the original input path
const K = 3;

// The original finishing filter, also used for the replaceable live tail. Detect corners
// over several accepted points, not consecutive subpixel steps in a quantized input grid.
function smoothPositions(points, stabilization) {
  if (points.length < 4) return points;
  const corner = new Uint8Array(points.length);
  for (let i = K; i < points.length - K; i++) {
    const ax = points[i][0] - points[i - K][0], ay = points[i][1] - points[i - K][1];
    const bx = points[i + K][0] - points[i][0], by = points[i + K][1] - points[i][1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la && lb && (ax * bx + ay * by) / (la * lb) < 0.5) {
      for (let j = i - 1; j <= i + 1; j++) corner[j] = 1;
    }
  }
  let p = points;
  for (let pass = 0; pass < 3 + Math.round(stabilization * 4); pass++) {
    p = p.map((q, i) => i === 0 || i === p.length - 1 || corner[i] ? q : [
      r1((p[i - 1][0] + 2 * q[0] + p[i + 1][0]) / 4),
      r1((p[i - 1][1] + 2 * q[1] + p[i + 1][1]) / 4), q[2],
    ]);
  }
  return p;
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
    this.filtered = point.slice();
    this.positionReady = false;
    this.dotRadius = pieceWidth(stroke, point[2]) / 2;
    this.points = [[r1(point[0]), r1(point[1]), this.dotRadius]];
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
    const a = 0.65 - 0.55 * this.stabilization;
    const p = clamp(point[2], 0, 1);
    const next = [
      this.positionReady ? mix(this.filtered[0], point[0], a) : point[0],
      this.positionReady ? mix(this.filtered[1], point[1], a) : point[1],
      mix(this.filtered[2], p, alpha(25, dt)),
    ];
    this.positionReady = true;
    this.filtered = next;
    this.raw = point.slice();
    const radius = pieceWidth(this.stroke, next[2]) / 2;
    this.dotRadius = Math.max(this.dotRadius, radius);
    if (dist(this.points[this.points.length - 1], next) < MIN_STEP / this.scale) return;
    this.points.push([r1(next[0]), r1(next[1]), radius]);
  }

  // A released Pencil normally reports zero pressure. Use its final position without
  // replacing the last contact pressure with a fabricated medium-pressure value.
  end(point, time) {
    if (!point || !point.slice(0, 2).every(Number.isFinite)) return;
    this.push([point[0], point[1], point[2] > 0 ? point[2] : this.raw[2]], time);
  }

  // The smoothed centre line so far. A smoothed point depends only on input points within
  // REACH of it (pass count + corner window), so points that far from the end never change
  // again: they are cached, and each frame only re-smooths the last stretch. That keeps the
  // cost per frame constant however long the stroke gets (long lines on infinite pages).
  // Starting the stretch REACH before the first uncached point gives exactly the same values
  // as smoothing the whole stroke.
  view() {
    const acc = this.points, passes = 3 + Math.round(this.stabilization * 4), REACH = passes + K + 3;
    const sm = this.sm || (this.sm = { points: [], lengths: [] });
    const start = Math.max(0, sm.points.length - REACH);
    const part = acc.slice(start);
    if (dist(acc[acc.length - 1], this.raw) > MIN_STEP / this.scale) {
      part.push([r1(this.raw[0]), r1(this.raw[1]), pieceWidth(this.stroke, this.filtered[2]) / 2]);
    }
    const out = smoothPositions(part, this.stabilization);
    // newly settled points move into the cache
    for (let i = sm.points.length; i + REACH < acc.length; i++) {
      const q = out[i - start], prev = sm.points[i - 1];
      sm.lengths.push(prev ? sm.lengths[i - 1] + dist(prev, q) : 0);
      sm.points.push(q);
    }
    const points = sm.points.concat(out.slice(sm.points.length - start));
    const lengths = sm.lengths.slice();
    for (let i = lengths.length; i < points.length; i++) lengths.push(i ? lengths[i - 1] + dist(points[i - 1], points[i]) : 0);
    // Filtering needs future neighbours. Keep all affected samples on the replaceable
    // overlay so the permanent prefix is identical before and after the next input/lift.
    const lookahead = passes + K + 2;
    const fixedCount = Math.max(1, Math.min(acc.length, points.length) - lookahead);
    return { points, lengths, total: lengths[lengths.length - 1], fixedCount };
  }

  finish() {
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
