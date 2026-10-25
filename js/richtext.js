// Rich text in text boxes.
// A text element has box defaults (size, color, bold, italic, font) and plain `text`; optional
// `runs` [{ text, size?, color?, bold?, italic?, font? }] override the defaults for parts of it
// (their texts joined are always equal to `text`, so search and export keep working).
// This module lays the runs out into lines (word wrap at the box width), and converts between
// runs and the contenteditable DOM used while editing.

export const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif';
export const FONTS = {
  sans: ['Standard', SYSTEM_FONT],
  serif: ['Serif', 'Georgia, "Times New Roman", serif'],
  mono: ['Mono', 'ui-monospace, Menlo, Consolas, "Courier New", monospace'],
  hand: ['Handschrift', '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive'],
  round: ['Rund', '"Arial Rounded MT Bold", "Trebuchet MS", sans-serif'],
};
export const STYLE_KEYS = ['size', 'color', 'bold', 'italic', 'font'];
export const LINE_H = 1.3;
export const fontFamily = s => (FONTS[s.font] || FONTS.sans)[1];
export const cssFont = s => `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : ''}${s.size}px ${fontFamily(s)}`;

export const runsOf = t => (t.runs?.length ? t.runs : [{ text: t.text || '' }]);
export const styleOf = (t, r = {}) => Object.fromEntries(STYLE_KEYS.map(k => [k, r[k] ?? t[k]]));
const eq = (k, a, b) => (k === 'bold' || k === 'italic' ? !!a === !!b : a === b);
const sameStyle = (a, b) => STYLE_KEYS.every(k => a[k] === b[k]);

// Drop overrides equal to the box defaults, merge neighbours, drop runs entirely if uniform.
export function normalize(t, runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const n = { text: r.text };
    for (const k of STYLE_KEYS) if (r[k] !== undefined && !eq(k, r[k], t[k])) n[k] = r[k];
    const last = out[out.length - 1];
    if (last && sameStyle(last, n)) last.text += n.text; else out.push(n);
  }
  const text = out.map(r => r.text).join('');
  const el = { ...t, text };
  if (out.some(r => STYLE_KEYS.some(k => r[k] !== undefined))) el.runs = out; else delete el.runs;
  return el;
}

// Apply a style patch to characters a..b of the box.
export function applyRange(t, a, b, patch) {
  const out = [];
  let pos = 0;
  for (const r of runsOf(t)) {
    const s = pos, e = pos + r.text.length;
    pos = e;
    const cut = (from, to, extra) => { if (to > from) out.push({ ...r, ...extra, text: r.text.slice(from - s, to - s) }); };
    cut(s, Math.min(e, Math.max(s, a)));
    cut(Math.max(s, a), Math.min(e, b), patch);
    cut(Math.max(s, Math.min(e, b)), e);
  }
  return normalize(t, out);
}

// Style at a character position (the character before it when collapsed, as typing continues it).
export function styleAtPos(t, pos) {
  let p = 0;
  const runs = runsOf(t);
  for (const r of runs) { if (pos <= p + r.text.length && (pos > p || p === 0)) return styleOf(t, r); p += r.text.length; }
  return styleOf(t, runs[runs.length - 1]);
}

// ---------- Layout ----------
// → { lines: [{ segs: [{ text, style, x, w }], w, h, size }], w, h }
export function layout(t, measure) {
  const lines = [];
  let line = null;
  const newLine = wrapped => { line = { segs: [], w: 0, size: 0, wrapped }; lines.push(line); };
  newLine(false);
  for (const r of runsOf(t)) {
    const style = styleOf(t, r);
    measure.font = cssFont(style);
    for (const tok of r.text.split(/(\n|[^\S\n]+)/)) {
      if (!tok) continue;
      if (tok === '\n') { line.size ||= style.size; newLine(false); continue; }
      const space = /^\s+$/.test(tok);
      const w = measure.measureText(tok).width;
      if (!space && line.w + w > t.w && line.segs.some(s => s.text.trim())) newLine(true);
      if (space && line.wrapped && !line.segs.length) continue; // no leading spaces after a wrap
      const last = line.segs[line.segs.length - 1];
      if (last && last.style === style) { last.text += tok; last.w += w; }
      else line.segs.push({ text: tok, style, x: line.w, w });
      line.w += w;
      line.size = Math.max(line.size, style.size);
    }
  }
  let y = 0;
  for (const l of lines) { l.size ||= t.size; l.h = l.size * LINE_H; l.y = y; y += l.h; }
  return { lines, w: Math.max(0, ...lines.map(l => l.w)), h: y };
}

export function drawRich(ctx, t, measure) {
  const { lines } = layout(t, measure);
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  for (const l of lines) {
    const base = t.y + l.y + l.size * 0.97; // matches the earlier single-style placement
    for (const s of l.segs) {
      ctx.font = cssFont(s.style); ctx.fillStyle = s.style.color;
      ctx.fillText(s.text, t.x + s.x, base);
    }
  }
  ctx.restore();
}

// ---------- Editing DOM ----------
// One span per run; overrides are stored on the span (data-*), sizes are shown scaled by k.
export function renderRunsDom(div, t, k) {
  div.replaceChildren(...runsOf(t).map(r => {
    const s = styleOf(t, r), span = document.createElement('span');
    span.dataset.run = '';
    for (const key of STYLE_KEYS) if (r[key] !== undefined) span.dataset[key] = String(r[key]);
    Object.assign(span.style, { fontSize: s.size * k + 'px', color: s.color, fontFamily: fontFamily(s), fontWeight: s.bold ? '700' : '400', fontStyle: s.italic ? 'italic' : 'normal' });
    span.textContent = r.text;
    return span;
  }));
  if (!div.textContent) div.append(document.createElement('br'));
}

const parseVal = (k, v) => (k === 'size' ? +v : k === 'bold' || k === 'italic' ? v === 'true' : v);
export function readRunsDom(div, t) {
  const runs = [];
  const walk = (node, over) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) runs.push({ ...over, text: c.data });
      else if (c.nodeName === 'BR') { if (c !== div.lastChild) runs.push({ ...over, text: '\n' }); }
      else if (c.nodeType === 1) {
        const o = { ...over };
        if (c.dataset?.run !== undefined) for (const k of STYLE_KEYS) if (c.dataset[k] !== undefined) o[k] = parseVal(k, c.dataset[k]);
        if (c !== div.firstChild && /^(DIV|P)$/.test(c.nodeName)) runs.push({ ...over, text: '\n' });
        walk(c, o);
      }
    }
  };
  walk(div, {});
  return normalize(t, runs);
}

// Character offsets of the selection inside div (or null if it isn't inside)
export function selectionOffsets(div) {
  const sel = getSelection();
  if (!sel.rangeCount || !div.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  const off = (node, o) => { const x = document.createRange(); x.selectNodeContents(div); x.setEnd(node, o); return x.toString().length; };
  return [off(r.startContainer, r.startOffset), off(r.endContainer, r.endOffset)];
}
export function setSelectionOffsets(div, a, b) {
  const point = pos => {
    const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let n, left = pos, last = null;
    while ((n = w.nextNode())) { last = n; if (left <= n.data.length) return [n, left]; left -= n.data.length; }
    return last ? [last, last.data.length] : [div, 0];
  };
  const r = document.createRange();
  r.setStart(...point(a)); r.setEnd(...point(b));
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
