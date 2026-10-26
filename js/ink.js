// Stroke width model, shared by input, rendering, storage and the Goodnotes format.
//
// Pen strokes are stored like Goodnotes stores them: every point is [x, y, r] with r the
// stroke's half width at that point (page units), flagged by s.rad = 1. The width is worked
// out once, when the stroke is finished, from the pen type, pressure, pressure sensitivity
// and nib angle; afterwards drawing, scaling and export just use r.
// Strokes without s.rad (older data, live strokes while drawing) still carry pressure.

// Width multiplier as a function of pen pressure, per pen type.
export const WIDTH_FN = {
  fountain: p => 0.45 + 1.0 * p,
  ball: () => 1, // ballpoint: constant width, no pressure
  brush: p => 0.15 + 1.9 * p,
};

// Width of one stroke piece from pressure. s.press (0..1, default .5) scales how much
// pressure matters; s.sharp (0..1) makes fountain/brush strokes direction-dependent like an
// angled nib (thin when moving along the 45° nib, full width across it).
const NIB = Math.PI / 4;
export function pieceWidth(s, pressure, dx = 0, dy = 0) {
  const f = WIDTH_FN[s.pen] || WIDTH_FN.fountain, mid = f(0.5);
  const k = (s.press ?? 0.5) / 0.5;
  let w = s.pen === 'ball' ? 1 : Math.max(0.15, mid + (f(pressure) - mid) * k);
  if (s.sharp && s.pen !== 'ball' && (dx || dy)) w *= 1 - s.sharp * 0.6 * (1 - Math.abs(Math.sin(Math.atan2(dy, dx) - NIB)));
  return s.width * w;
}

// Width of the piece ending at point i (drawn as a quadratic from the previous midpoint).
export function widthAt(s, i, dx, dy) {
  return s.rad ? 2 * s.points[i][2] : pieceWidth(s, s.points[i][2], dx, dy);
}

const r2 = v => Math.round(v * 100) / 100;

// Pressure → radius, using the same piece directions as drawing, so a stroke looks the same
// before and after. Highlighter and shape strokes keep their constant width and are unchanged.
export function toRadius(s) {
  if (s.rad || s.type !== 'stroke' || s.tool === 'highlighter' || s.shape) return s;
  const p = s.points;
  const mid = i => [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
  const points = p.map((q, i) => {
    let dx = 0, dy = 0;
    if (i > 0 && p.length > 1) {
      const prev = i === 1 ? p[0] : mid(i - 1), to = i < p.length - 1 ? mid(i) : q;
      dx = to[0] - prev[0]; dy = to[1] - prev[1];
    }
    return [q[0], q[1], r2(pieceWidth(s, q[2] ?? 0.5, dx, dy) / 2)];
  });
  const rs = smoothRadii(points.map(q => q[2]));
  return { ...s, points: points.map((q, i) => [q[0], q[1], r2(rs[i])]), rad: 1 };
}

// ---------- Width smoothing ----------
// The Pencil's pressure jumps from sample to sample; widths are smoothed along the stroke
// ([1,2,1] passes) so the line gets thicker and thinner gently, without beads.
export function smoothRadii(rs, passes = 3) {
  let a = rs.slice();
  for (let k = 0; k < passes; k++) a = a.map((r, i) => (i === 0 || i === a.length - 1 ? r : (a[i - 1] + 2 * r + a[i + 1]) / 4));
  return a;
}

// ---------- Outline geometry ----------
// A pen stroke is drawn as ONE filled shape: the centre line (quadratic pieces through the
// midpoints of the points, as stored) is sampled densely, every sample is a disc of the local
// radius, and neighbouring discs are joined by their tangent hull. All parts wind the same
// way, so the union fills without seams, overlaps or beads; the ends are round.
// One quadratic piece a → b (control c), radius ra → rb, sampled about every half radius.
export function samplePiece(a, c, b, ra, rb, out) {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(b[0] - c[0], b[1] - c[1]);
  const step = Math.max(0.35, Math.min(ra, rb) * 0.5);
  const n = Math.max(1, Math.min(64, Math.ceil(len / step)));
  for (let k = 1; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1], ra + (rb - ra) * t]);
  }
  return out;
}

// radiusAt(i, dx, dy) → radius of point i.
export function strokeSamples(p, radiusAt) {
  const out = [];
  if (!p.length) return out;
  const r0 = radiusAt(0, 0, 0);
  if (p.length === 1) return [[p[0][0], p[0][1], r0]];
  const piece = (a, c, b, ra, rb) => samplePiece(a, c, b, ra, rb, out);
  out.push([p[0][0], p[0][1], r0]);
  let prev = [p[0][0], p[0][1]], prevR = r0;
  for (let i = 1; i < p.length - 1; i++) {
    const m = [(p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2];
    const r = radiusAt(i, m[0] - prev[0], m[1] - prev[1]);
    piece(prev, p[i], m, prevR, r);
    prev = m; prevR = r;
  }
  const last = p[p.length - 1];
  const rl = radiusAt(p.length - 1, last[0] - prev[0], last[1] - prev[1]);
  piece(prev, [(prev[0] + last[0]) / 2, (prev[1] + last[1]) / 2], last, prevR, rl);
  return out;
}

// Adds samples (from index `from`) to a path as discs + tangent hulls, all clockwise.
export function addSamplesToPath(path, smp, from = 0) {
  const disc = ([x, y, r]) => { path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2); };
  if (from === 0 && smp.length) disc(smp[0]);
  for (let i = Math.max(1, from); i < smp.length; i++) {
    const [ax, ay, ra] = smp[i - 1], [bx, by, rb] = smp[i];
    disc(smp[i]);
    const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
    if (d <= Math.abs(ra - rb) + 1e-6) continue; // one disc contains the other
    const th = Math.atan2(dy, dx), ph = Math.acos(Math.max(-1, Math.min(1, (ra - rb) / d)));
    const q = [
      [ax + ra * Math.cos(th + ph), ay + ra * Math.sin(th + ph)], [bx + rb * Math.cos(th + ph), by + rb * Math.sin(th + ph)],
      [bx + rb * Math.cos(th - ph), by + rb * Math.sin(th - ph)], [ax + ra * Math.cos(th - ph), ay + ra * Math.sin(th - ph)],
    ];
    // same winding as the discs (positive area in y-down coordinates)
    let area = 0;
    for (let k = 0; k < 4; k++) { const [x1, y1] = q[k], [x2, y2] = q[(k + 1) % 4]; area += x1 * y2 - x2 * y1; }
    if (area < 0) q.reverse();
    path.moveTo(q[0][0], q[0][1]);
    for (let k = 1; k < 4; k++) path.lineTo(q[k][0], q[k][1]);
    path.closePath();
  }
}

// Radius per point for drawing: stored radii (smoothed) or, for pressure strokes, the width model.
export function strokeRadiusFn(s) {
  if (s.rad) { const rs = smoothRadii(s.points.map(q => q[2])); return i => rs[i]; }
  return (i, dx, dy) => pieceWidth(s, s.points[i][2] ?? 0.5, dx, dy) / 2;
}

export function fillStroke(ctx, s) {
  const path = new Path2D();
  addSamplesToPath(path, strokeSamples(s.points, strokeRadiusFn(s)));
  ctx.fill(path, 'nonzero');
}
