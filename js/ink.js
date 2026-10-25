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
  ball: p => 0.85 + 0.3 * p,
  brush: p => 0.15 + 1.9 * p,
};

// Width of one stroke piece from pressure. s.press (0..1, default .5) scales how much
// pressure matters; s.sharp (0..1) makes fountain/brush strokes direction-dependent like an
// angled nib (thin when moving along the 45° nib, full width across it).
const NIB = Math.PI / 4;
export function pieceWidth(s, pressure, dx = 0, dy = 0) {
  const f = WIDTH_FN[s.pen] || WIDTH_FN.fountain, mid = f(0.5);
  const k = (s.press ?? 0.5) / 0.5;
  let w = Math.max(0.15, mid + (f(pressure) - mid) * k);
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
  return { ...s, points, rad: 1 };
}
