// Stroke width model, shared by input, rendering, storage and the Goodnotes format.
//
// Pen strokes are stored like Goodnotes stores them: every point is [x, y, r] with r the
// stroke's half width at that point (page units), flagged by s.rad = 1. New strokes (ink: 2)
// filter pressure at input time and store the resulting radii without another smoothing
// pass. Older pressure strokes retain their original width and nib model on conversion.
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
// pref: the writer's usual pressure (learned while writing, see tools.js), so the chosen width is
// the width at that pressure — whether someone writes as lightly as 0.15 or presses with 0.5.
export function pieceWidth(s, pressure, dx = 0, dy = 0, pref = 0.5) {
  if (s.ink === 2) {
    if (s.pen === 'ball') return s.width;
    // Width ∝ (pressure / usual pressure)^γ with γ = sensitivity (brush: stronger). Measured on the
    // same sentence written in Goodnotes: its width follows pressure about as √ (γ ≈ 0.5); the
    // earlier curve, centred on 0.5, was nearly flat for a light hand (×1.10 instead of ×1.26
    // between the lighter downstrokes and the firmer cross strokes). Tip sharpness is a taper.
    const g = Math.max(0, Math.min(1, s.press ?? 0.5)) * (s.pen === 'brush' ? 2.2 : INK.gamma);
    return s.width * Math.max(0.2, Math.min(2.2, Math.pow(Math.max(0.01, Math.min(1, pressure)) / pref, g)));
  }
  const f = WIDTH_FN[s.pen] || WIDTH_FN.fountain, mid = f(0.5);
  const k = (s.press ?? 0.5) / 0.5;
  let w = s.pen === 'ball' ? 1 : Math.max(0.15, mid + (f(pressure) - mid) * k);
  if (s.sharp && s.pen !== 'ball' && (dx || dy)) w *= 1 - s.sharp * 0.6 * (1 - Math.abs(Math.sin(Math.atan2(dy, dx) - NIB)));
  return s.width * w;
}

// Taper over distance, not sample count. A short dot retains its pressure-defined size.
// Used for both the live tail and committed new ink; old/imported strokes keep their look.
// taper: how far a pen tip narrows at the stroke ends (× sharpness); gamma: pressure exponent at
// full sensitivity (default sensitivity 0.5 → 0.7, close to Goodnotes on the recorded sentence)
export const INK = { taper: 0.3, gamma: 1.4 };
export function tipRadius(s, radius, distance, total) {
  if (s.pen === 'ball' || !s.sharp || total < s.width * 0.75) return radius;
  const sharp = Math.max(0, Math.min(1, s.sharp));
  // gentler since v61: the pressure already thins a stroke's start (Goodnotes: ends at 70–77 % width)
  const length = s.width * (0.5 + 2 * sharp), floor = 1 - INK.taper * sharp;
  const ease = x => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
  const start = floor + (1 - floor) * ease(distance / length);
  const end = floor + (1 - floor) * ease((total - distance) / length);
  return radius * Math.min(start, end);
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
// Geometric tolerance of the outline (page units; ≈0.07 device px at 400 % zoom on a 2× screen).
// Samples, discs and hull pieces that change the filled shape by less than this are left out,
// which makes a stroke's path several times smaller without a visible difference.
const TOL = 0.01;
// One quadratic piece a → b (control c), radius ra → rb. A quadratic deviates from its chord by
// |a − 2c + b| / 4, and by that / n² when split into n chords: n is the fewest chords within TOL.
// The radius is linear along the piece, so it needs no extra samples (the hulls interpolate it).
export function samplePiece(a, c, b, ra, rb, out) {
  const dev = Math.hypot(a[0] - 2 * c[0] + b[0], a[1] - 2 * c[1] + b[1]) / 4;
  const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(dev / TOL))));
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

// Drops samples that lie (centre and radius) within TOL of the straight hull between their
// kept neighbours: the hull of two discs contains every disc on its chord with an interpolated
// radius, so the filled shape changes by at most 2·TOL. Pencil input is dense (a point every
// ~0.4 px), so most samples on gentle curves go.
export function simplifySamples(smp) {
  const n = smp.length;
  if (n < 3) return smp;
  const out = [smp[0]];
  let a = 0;
  for (let j = 2; j < n; j++) {
    const [ax, ay, ra] = smp[a], [bx, by, rb] = smp[j];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let ok = j - a <= 48;
    for (let k = a + 1; ok && k < j; k++) {
      const [x, y, r] = smp[k];
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      ok = Math.hypot(x - ax - t * dx, y - ay - t * dy) <= TOL && Math.abs(r - ra - t * (rb - ra)) <= TOL;
    }
    if (!ok) { out.push(smp[j - 1]); a = j - 1; }
  }
  out.push(smp[n - 1]);
  return out;
}

// Adds samples to a path as discs + tangent hulls, all clockwise (one nonzero fill, no seams).
// A disc is only needed where the two hulls meeting at a sample leave a gap on the outer side
// (a bend, or a change in how fast the radius changes) deeper than TOL, and at both ends.
export function addSamplesToPath(path, samples) {
  const smp = simplifySamples(samples), n = smp.length;
  const disc = ([x, y, r]) => { path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2); };
  if (n === 1) return disc(smp[0]);
  let prev = null; // tangent angles at the end of the previous hull: [th + ph, th − ph], or null
  for (let i = 1; i <= n; i++) {
    let cur = null;
    if (i < n) {
      const [ax, ay, ra] = smp[i - 1], [bx, by, rb] = smp[i];
      const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy);
      if (d > Math.abs(ra - rb) + 1e-6) { // otherwise one disc contains the other
        const th = Math.atan2(dy, dx), ph = Math.acos(Math.max(-1, Math.min(1, (ra - rb) / d)));
        const c1 = Math.cos(th + ph), s1 = Math.sin(th + ph), c2 = Math.cos(th - ph), s2 = Math.sin(th - ph);
        // corners in clockwise order (positive area in y-down coordinates) for any direction
        path.moveTo(ax + ra * c2, ay + ra * s2);
        path.lineTo(bx + rb * c2, by + rb * s2);
        path.lineTo(bx + rb * c1, by + rb * s1);
        path.lineTo(ax + ra * c1, ay + ra * s1);
        path.closePath();
        cur = [th + ph, th - ph];
      }
    }
    // Joint at sample i − 1. Each hull ends in a chord between its two tangent points on this
    // disc. Where the next hull's tangent points sit elsewhere (a bend, or the radius changing
    // at another rate), the chords leave a wedge or a thin crack. Its size is at most r·|Δangle|
    // of the tangent points, so the disc is skipped only when that is below TOL. Ends always get one.
    const q = smp[i - 1];
    if (i === 1 || !prev || !cur || q[2] * Math.max(Math.abs(angleDiff(prev[0], cur[0])), Math.abs(angleDiff(prev[1], cur[1]))) > TOL) disc(q);
    prev = cur;
  }
}
const angleDiff = (a, b) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };

// Radius per point for drawing: stored radii (smoothed) or, for pressure strokes, the width model.
export function strokeRadiusFn(s) {
  if (s.rad) {
    if (s.ink === 2) return i => s.points[i][2]; // already filtered once at input
    const rs = smoothRadii(s.points.map(q => q[2])); return i => rs[i];
  }
  return (i, dx, dy) => pieceWidth(s, s.points[i][2] ?? 0.5, dx, dy) / 2;
}

// Finished v2 strokes are immutable. Reuse their page-coordinate outline for the page,
// sharp detail layer and later redraws instead of rebuilding thousands of arcs each time.
const outlines = new WeakMap();
export function fillStroke(ctx, s) {
  const cached = s.ink === 2 && s.rad ? outlines.get(s) : null;
  let path = cached?.points === s.points ? cached.path : null;
  if (!path) {
    path = new Path2D();
    addSamplesToPath(path, strokeSamples(s.points, strokeRadiusFn(s)));
    if (s.ink === 2 && s.rad) outlines.set(s, { points: s.points, path });
  }
  ctx.fill(path, 'nonzero');
}

