// Export to the Goodnotes document format (.goodnotes) — EXPERIMENTAL.
// Mirrors the structure read in goodnotes.js (see there for the format description):
// - one PDF attachment holding every page's background (paper, template, imported PDF/image
//   background, flattened), referenced by one page-background record per page
// - one sheet per page with a sort key, and a notes file per sheet with its elements:
//   header + element record per stroke (Apple-LZ4-wrapped "tpl" geometry), image and text box
// Records 103, 105 (attachment search entries) and 106 (element list per sheet, for images)
// follow Goodnotes' own files.
import { PAGE_W } from './store.js';
import { pageH, renderPage, toRadius, textHeight } from './render.js';
import { toast, sheet } from './ui.js';
import { h } from './util.js';

const PT = 1091.237 / PAGE_W; // Goodnotes' A4 page is 1091.237 × 1543.667 points
const SCHEMA = 24;

// ---------- small binary helpers ----------
const enc = new TextEncoder();
class Bytes {
  constructor() { this.parts = []; this.n = 0; }
  push(u8) { this.parts.push(u8); this.n += u8.length; return this; }
  done() { const out = new Uint8Array(this.n); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}
function varint(v) {
  let x = BigInt(v); const out = [];
  do { let b = Number(x & 127n); x >>= 7n; if (x) b |= 128; out.push(b); } while (x);
  return new Uint8Array(out);
}
const f32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };
const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; };

// Protobuf message builder: chain .u(field, n) .s(field, str) .m(field, bytes) .f(field, float) .d(field, double)
class Pb {
  constructor() { this.b = new Bytes(); }
  key(f, wt) { this.b.push(varint(f * 8 + wt)); return this; }
  u(f, v) { if (v == null) return this; return this.key(f, 0), this.b.push(varint(v)), this; }
  f(f, v) { return this.key(f, 5), this.b.push(f32(v)), this; }
  d(f, v) { return this.key(f, 1), this.b.push(f64(v)), this; }
  m(f, bytes) { const x = bytes instanceof Pb ? bytes.done() : bytes; this.key(f, 2); this.b.push(varint(x.length)); this.b.push(x); return this; }
  s(f, str) { return this.m(f, enc.encode(str)); }
  done() { return this.b.done(); }
}
const pb = () => new Pb();
// length-prefixed record stream
function stream(msgs) { const b = new Bytes(); for (const m of msgs) { const x = m instanceof Pb ? m.done() : m; b.push(varint(x.length)); b.push(x); } return b.done(); }

// Apple LZ4 frame with a single literal-only block (valid LZ4, no compression needed)
function bv41(raw) {
  const b = new Bytes();
  const lit = raw.length, len = [];
  if (lit >= 15) { let r = lit - 15; while (r >= 255) { len.push(255); r -= 255; } len.push(r); }
  const block = new Bytes().push(new Uint8Array([Math.min(lit, 15) << 4])).push(new Uint8Array(len)).push(raw).done();
  const head = new Uint8Array(12); const dv = new DataView(head.buffer);
  head.set(enc.encode('bv41')); dv.setUint32(4, raw.length, true); dv.setUint32(8, block.length, true);
  return b.push(head).push(block).push(enc.encode('bv4$')).done();
}

// tpl: "tpl\0" + u32 total size + format string \0 + data
function tpl(items) {
  const fmt = items.map(([t]) => (t === 'v' ? 'v' : `A(${t[1]})`)).join('');
  const data = new Bytes();
  for (const [t, v] of items) {
    if (t === 'v') { const x = new Uint8Array(2); new DataView(x.buffer).setUint16(0, v, true); data.push(x); continue; }
    const n = new Uint8Array(4); new DataView(n.buffer).setUint32(0, v.length, true); data.push(n);
    const el = t[1] === 'v' ? 2 : 4, x = new Uint8Array(v.length * el), dv = new DataView(x.buffer);
    v.forEach((val, i) => (el === 2 ? dv.setUint16(i * 2, val, true) : dv.setFloat32(i * 4, val, true)));
    data.push(x);
  }
  const body = data.done(), f = enc.encode(fmt);
  const total = 8 + f.length + 1 + body.length, out = new Uint8Array(total), dv = new DataView(out.buffer);
  out.set(enc.encode('tpl')); dv.setUint32(4, total, true); out.set(f, 8); out.set(body, 9 + f.length);
  return out;
}

// ZIP (stored, with CRC-32)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zip(files) {
  const out = new Bytes(), central = new Bytes(); let offset = 0;
  for (const [name, data] of files) {
    const nm = enc.encode(name), crc = crc32(data);
    const lh = new Uint8Array(30), l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
    l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, nm.length, true);
    out.push(lh).push(nm).push(data);
    const ch = new Uint8Array(46), c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true);
    c.setUint32(42, offset, true);
    central.push(ch).push(nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = central.done(), end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cd.length, true); e.setUint32(16, offset, true);
  return out.push(cd).push(end).done();
}

// ---------- ids, clocks, bookkeeping ----------
const uuid = () => crypto.randomUUID().toUpperCase();
const rnd = () => (crypto.getRandomValues(new Uint32Array(1))[0]);
const clock = (n = 1) => pb().u(1, n).u(2, rnd());
// a notes file id is the sheet id + 1 in its last hex group
const plusOne = id => id.slice(0, 24) + (BigInt('0x' + id.slice(24)) + 1n).toString(16).toUpperCase().padStart(12, '0');
const sheetId = () => { let id; do { id = uuid(); } while (id.endsWith('FFFFFFFFFFFF')); return id; };

function rgba(hex, a = 1) {
  const n = parseInt((hex || '#000000').slice(1), 16);
  return pb().f(1, ((n >> 16) & 255) / 255).f(2, ((n >> 8) & 255) / 255).f(3, (n & 255) / 255).f(4, a);
}

// ---------- strokes → Goodnotes geometry ----------
// The centre line is written exactly as Folio draws it: quadratic pieces from midpoint to
// midpoint with the points as controls (shapes and highlighters: straight pieces between
// their points). Every point carries its half width in points as third value — Goodnotes
// draws the line from it. Each piece also gets its outline: both edges as curves, offset by
// the radius, joined by straight lines.
function strokeTpl(s) {
  const fixed = s.tool === 'highlighter' || s.shape;
  const rs = fixed ? null : toRadius(s).points; // half widths (no-op for radius strokes)
  let pts = s.points.map((p, i) => [p[0] * PT, p[1] * PT, (fixed ? s.width / 2 : rs[i][2]) * PT]);
  if (s.closed && pts.length > 2) pts = [...pts, pts[0]];
  // Zero-length segments make direction/tangent 0/0 → Goodnotes draws spikes. Drop near-duplicates.
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.05);
  if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.1, pts[0][1], pts[0][2]]];
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

  // pieces [start, control, end]
  const pieces = [];
  if (fixed || pts.length === 2) {
    for (let i = 1; i < pts.length; i++) pieces.push([pts[i - 1], mid(pts[i - 1], pts[i]), pts[i]]);
  } else {
    let prev = pts[0];
    for (let i = 1; i < pts.length - 1; i++) { const m = mid(pts[i], pts[i + 1]); pieces.push([prev, pts[i], m]); prev = m; }
    const last = pts[pts.length - 1];
    pieces.push([prev, mid(prev, last), last]);
  }

  const unit = (x, y) => { const l = Math.hypot(x, y); return l > 1e-6 ? [x / l, y / l] : null; };
  const segs = [], ctrl = [], tangents = [], outline = [], cmds = [], counts = [];
  for (const [a, c, b] of pieces) {
    const chord = unit(b[0] - a[0], b[1] - a[1]) || [1, 0];
    const ta = unit(c[0] - a[0], c[1] - a[1]) || chord, tb = unit(b[0] - c[0], b[1] - c[1]) || chord;
    segs.push(...c, ...b);
    ctrl.push(c[0], c[1]);
    tangents.push(...a, ...ta, ...b, ...tb);
    // Edge of the piece at distance r on one side (side = 1 left, -1 right): ends offset along
    // their normals; the control is where the two offset tangents meet (fallback: offset control).
    const edge = side => {
      const na = [-ta[1] * side, ta[0] * side], nb = [-tb[1] * side, tb[0] * side];
      const A = [a[0] + na[0] * a[2], a[1] + na[1] * a[2]], B = [b[0] + nb[0] * b[2], b[1] + nb[1] * b[2]];
      const det = ta[0] * tb[1] - ta[1] * tb[0];
      let C;
      if (Math.abs(det) > 1e-3) {
        const t = ((B[0] - A[0]) * tb[1] - (B[1] - A[1]) * tb[0]) / det;
        C = [A[0] + ta[0] * t, A[1] + ta[1] * t];
        if (Math.hypot(C[0] - c[0], C[1] - c[1]) > 4 * Math.max(a[2], b[2], c[2]) + 1) C = null; // runaway
      }
      if (!C) { const n = unit(na[0] + nb[0], na[1] + nb[1]) || na; C = [c[0] + n[0] * c[2], c[1] + n[1] * c[2]]; }
      return [A, C, B];
    };
    const [la, lc, lb] = edge(1), [ra, rc, rb] = edge(-1);
    // Outline commands as in Goodnotes' own strokes: 0 = start a piece, 2 = curve stored as
    // 3 points (start, control, end), 3 = straight line to the next curve's start / back to
    // the piece's start. Each command 2 MUST have its 3 points; Goodnotes crashes otherwise.
    outline.push(...la, ...lc, ...lb, ...rb, ...rc, ...ra);
    cmds.push(0, 2, 3, 2, 3); counts.push(5);
  }
  const n = pieces.length;
  return tpl([
    ['v', 2],
    ['Av', [0, ...Array(n).fill(1)]],
    ['Au', pts[0]],
    ['Au', segs],
    ['Av', counts],
    ['Av', cmds],
    ['Au', ctrl],
    ['Au', []],
    ['Au', outline],
    ['Au', tangents],
    ['Av', Array(2 * n).fill(1)],
  ]);
}

// ---------- text boxes ----------
// Layout from a Goodnotes 6 file with text boxes (record schema 35): element field 21 with
// 20 position (top-left of the box, points) + scale, 21 sizing (2 = fixed width {box width,
// min height, max height}), 32 the text: 1 content (Apple-LZ4 protobuf: 1.1 text, 1.2 style
// run: 3 colour, 40 size; -404 = "use default"; 1.3 paragraph style), 2 text size, 5 default
// style (30 font, 40 size), 10 insets. 30/31/33 (fill, border, shadow) are copied as Goodnotes
// writes them for a plain box. 32.1.3 is 8 bytes that look random (no hash matched) → random.
const TEXT_SCHEMA = 35, INSET = 10, UNSET = -404;
const u64 = v => BigInt.asUintN(64, BigInt(v)); // negative varints
const white = () => pb().m(1, pb().f(1, 1).f(2, 1).f(3, 1));
function textElement(e, id, hc, seq) {
  const size = e.size * PT, w = e.w * PT, h = textHeight(e) * PT;
  const run = pb().m(3, rgba(e.color)).f(40, size).u(60, u64(UNSET)).f(70, UNSET);
  const para = pb().m(1, pb().m(1, new Uint8Array())).m(2, pb().u(1, u64(-1))).m(3, pb().u(1, u64(-1)).u(2, u64(-1)));
  const content = pb().m(1, pb().s(1, e.text || '').m(2, run).m(3, para)).done();
  const style = pb()
    .m(1, pb().m(3, pb().f(4, 1)).s(30, 'Helvetica Neue').f(40, size).u(60, u64(-60)).f(70, -20))
    .m(2, pb().m(1, pb().m(1, new Uint8Array())).m(2, new Uint8Array()).m(3, pb().u(1, u64(-1)).u(2, u64(-1))));
  return pb().m(21, pb().s(1, id).u(2, TEXT_SCHEMA).m(3, hc).m(7, pb().m(1, clock(seq))).u(9, 1)
    .m(20, pb().m(1, pb().f(1, e.x * PT - INSET).f(2, e.y * PT - INSET)).f(3, 1))
    .m(21, pb().m(2, pb().f(1, w + 2 * INSET).f(2, 32).f(3, Infinity)))
    .m(22, pb().m(1, new Uint8Array()))
    .m(30, pb().m(1, white()))
    .m(31, pb().m(2, pb().m(1, new Uint8Array())).m(3, white()))
    .m(32, pb()
      .m(1, pb().m(2, bv41(content)).m(3, crypto.getRandomValues(new Uint8Array(8))).u(4, 1))
      .m(2, pb().f(1, w).f(2, h))
      .m(5, style)
      .m(10, pb().f(1, INSET).f(2, INSET).f(3, INSET).f(4, INSET))
      .m(11, new Uint8Array())) // present on fixed-width boxes
    .m(33, pb().m(1, pb().f(4, 0.2)).m(3, pb().f(2, 5))));
}

// ---------- whole document ----------
// quiet: no progress toast (background copies for Google Drive)
export async function notebookToGoodnotes(doc, { quiet = false } = {}) {
  if (doc.kind === 'textdoc') return textDocToGoodnotes(doc, { quiet });
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) throw new Error('PDF-Bibliothek nicht geladen (offline?)');
  if (!quiet) toast('Goodnotes-Datei wird erstellt…', 0);
  const files = [];
  const device = (BigInt(rnd()) << 31n) | BigInt(rnd() >>> 1);
  let counter = Date.now();
  const now = () => Date.now() + Math.random();
  const docId = uuid();
  const common = (m, a, b, c) => m.d(10, now()).s(11, uuid()).u(a, device).u(b, counter++).u(c, SCHEMA);

  // 1) Backgrounds: one PDF, a page per note page (paper, template, background image)
  let pdf;
  for (const page of doc.pages) {
    const h = pageH(page), s = 2;
    const c = document.createElement('canvas');
    c.width = PAGE_W * s; c.height = Math.round(h * s);
    const bgOnly = { ...page, elements: [] };
    await renderPage(c.getContext('2d'), bgOnly, s);
    const fmt = [PAGE_W * PT, h * PT];
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: fmt, orientation: fmt[0] > fmt[1] ? 'l' : 'p', compress: true });
    else pdf.addPage(fmt, fmt[0] > fmt[1] ? 'l' : 'p');
    pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, fmt[0], fmt[1]);
  }
  const bgPdf = new Uint8Array(pdf.output('arraybuffer'));
  const bgAtt = uuid();
  files.push([`attachments/${bgAtt}`, bgPdf]);

  // Record layout follows a document Goodnotes 6 wrote itself (same fields, same order of types).
  const DEFAULT_PAPER = '5A53E89E-F4C2-4548-8DD3-E9DF9FB4592E'; // id Goodnotes uses in fields 3/7
  const events = [], noteIndex = [], attIndex = [[bgAtt, `attachments/${bgAtt}`]], searchIndex = [];
  events.push(pb().s(1, docId).m(30, common(pb()
    .s(1, docId)
    .m(2, pb().s(1, doc.name || 'Folio').m(2, clock()))
    .m(3, pb().s(1, DEFAULT_PAPER).m(2, clock()))
    .m(6, pb().s(1, 'P').m(2, clock()))
    .m(7, pb().s(1, DEFAULT_PAPER).m(2, clock()))
    .s(9, 'auto'), 13, 14, 20)
    .m(17, new Uint8Array()).m(18, new Uint8Array()).m(19, pb().m(2, clock()))));
  // An attachment is announced (6), and Goodnotes indexes it for search (105, 103 + search file).
  const attachment = (id, size) => {
    events.push(pb().s(1, id).m(6, common(pb().s(1, id).s(2, id).u(5, size).s(6, docId), 14, 15, 16).m(12, new Uint8Array())));
    events.push(pb().s(1, id).m(105, common(pb().s(2, docId).s(3, id), 13, 14, 15)));
    events.push(pb().s(1, id).m(103, common(pb().s(1, id).s(2, docId).u(14, 1).s(16, uuid()), 18, 19, 20)));
    files.push([`search/${id}`, stream([pb().u(2, 1).m(3, new Uint8Array())])]);
    searchIndex.push(id);
  };
  attachment(bgAtt, bgPdf.length);

  // 2) Images used on pages → attachments (one per distinct image)
  const imageAtts = new Map();
  for (const page of doc.pages) for (const e of page.elements) {
    if (e.type !== 'image' || imageAtts.has(e.src)) continue;
    const bytes = new Uint8Array(await (await fetch(e.src)).arrayBuffer());
    const id = uuid();
    imageAtts.set(e.src, id);
    files.push([`attachments/${id}`, bytes]);
    attIndex.push([id, `attachments/${id}`]);
    attachment(id, bytes.length);
  }
  // Fractional sort keys like Goodnotes' own ("42nWp", "A8Zo6"): 5 base-62 chars, evenly spaced,
  // never ending in "0".
  const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const sortKey = i => {
    let n = Math.floor((i + 1) * (62 ** 5 - 1) / (doc.pages.length + 1)), k = '';
    for (let d = 0; d < 5; d++) { k = B62[n % 62] + k; n = Math.floor(n / 62); }
    return k.replace(/0+$/, '') || '1';
  };
  const sheetLists = [];
  let elementSeq = 3_700_000; // header counter: small numbers in Goodnotes' own files

  // 3) Pages: background record, sheet record (sort key), notes file
  for (const [i, page] of doc.pages.entries()) {
    const bgId = uuid(), sid = sheetId(), nid = plusOne(sid);
    const w = PAGE_W * PT, h = pageH(page) * PT;
    events.push(pb().s(1, bgId).m(2, common(pb().s(1, docId).s(2, bgId).s(4, bgAtt).u(5, i + 1)
      .m(8, pb().f(1, w).f(2, h)), 15, 16, 21)
      .m(12, pb().m(2, clock())).m(13, pb().m(2, clock())).m(17, pb().m(2, clock())).m(19, pb().m(2, clock()))));
    events.push(pb().s(1, sid).m(54, common(pb().s(1, docId).s(2, sid)
      .m(3, pb().s(1, bgId).m(2, clock()))
      .m(4, pb().s(1, sortKey(i)).m(2, clock())), 13, 14, 15)
      .m(17, pb().m(1, pb().m(2, pb().m(1, rgba('#DDDDDD')).m(2, rgba('#FFFFFF')))).m(2, clock()))));

    // Image headers carry a second id (6) and their clock (2); the sheet's element list (record
    // 106) repeats both, as in Goodnotes' own files. Strokes have neither.
    const recs = [], members = [];
    let seq = 1;
    for (const e of page.elements) {
      const id = uuid(), key = uuid(), hc = clock(seq);
      if (e.type === 'stroke') {
        recs.push(pb().s(1, id).m(2, hc).u(8, device).u(9, elementSeq++).u(14, 5381).u(16, SCHEMA));
        recs.push(pb().m(7, pb().s(1, id).m(2, bv41(strokeTpl(e))).u(3, 1)
          .m(4, rgba(e.color, e.tool === 'highlighter' ? 0.4 : 1))
          .m(6, new Uint8Array()).m(7, pb().m(1, clock(seq))).m(9, new Uint8Array())
          .m(15, clock(seq)).m(20, new Uint8Array()).u(21, SCHEMA)));
      } else if (e.type === 'image' && imageAtts.has(e.src)) {
        const ref = uuid(), x = e.x * PT, y = e.y * PT, iw = e.w * PT, ih = e.h * PT;
        members.push(pb().s(1, key).m(2, hc));
        recs.push(pb().s(1, id).m(2, hc).s(4, ref).s(6, key).s(7, imageAtts.get(e.src))
          .u(8, device).u(9, elementSeq++).s(11, uuid()).m(12, pb().s(1, uuid()).s(2, docId)).m(13, pb().s(1, uuid()).s(2, docId))
          .u(14, 5381).u(16, SCHEMA));
        recs.push(pb().m(1, pb().s(1, id)
          .m(2, pb().m(1, pb().f(1, x).f(2, y)).m(2, pb().f(1, iw).f(2, ih)))
          .m(3, pb().m(1, pb().f(1, x + iw / 2).f(2, y + ih / 2)).m(2, pb().f(1, iw).f(2, ih)))
          .s(4, ref).m(5, pb().m(1, clock(seq))).m(15, clock(seq)).u(18, SCHEMA)));
      } else if (e.type === 'text' && (e.text || '').trim()) {
        recs.push(pb().s(1, id).m(2, hc).u(8, device).u(9, elementSeq++).u(14, 5381).u(16, TEXT_SCHEMA));
        recs.push(textElement(e, id, hc, seq));
      }
      seq++;
    }
    files.push([`notes/${nid}`, stream(recs)]);
    noteIndex.push([nid, `notes/${nid}`]);
    if (members.length) {
      const list = pb().s(1, nid);
      for (const m of members) list.m(2, m);
      sheetLists.push(pb().s(1, nid).m(106, common(list, 13, 14, 15).s(16, docId)));
    }
  }

  // Element lists come after all sheets. No handwriting registration (104): Goodnotes pairs it
  // with a search file for the page, and a page with an image showed up empty without one.
  events.push(...sheetLists);

  // 4) Indexes and the rest of the package
  const index = list => stream(list.map(([id, path]) => pb().s(1, id).s(2, path)));
  const thumb = document.createElement('canvas');
  thumb.width = 300; thumb.height = Math.round(300 * pageH(doc.pages[0]) / PAGE_W);
  await renderPage(thumb.getContext('2d'), doc.pages[0], 300 / PAGE_W);
  const thumbBytes = new Uint8Array(await (await fetch(thumb.toDataURL('image/jpeg', 0.85))).arrayBuffer());
  files.push(
    ['document.info.pb', new Uint8Array()],
    ['index.attachments.pb', index(attIndex)],
    ['index.events.pb', stream(events)],
    ['index.notes.pb', index(noteIndex)],
    ['index.search.pb', stream(searchIndex.map(id => pb().s(1, id).s(2, `search/${id}`).u(3, 1)))],
    ['schema.pb', pb().u(1, SCHEMA).done()],
    ['thumbnail.jpg', thumbBytes],
  );
  return new Blob([zip(files)], { type: 'application/octet-stream' });
}

// ---------- text documents ----------
// Layout of a Goodnotes text document (document type 5, record schema 31): one sheet on a
// blank 834 × 1079 pt page, whose notes file holds one element with field 13 = { 1 id, 2 31,
// 3 clock, 10 Yjs update, 11 Yjs state vector }. The Yjs document is what slate-yjs writes
// for the Slate nodes Folio stores (see textdoc.js). Images are attachments (record 6 with
// 17 = asset id) referred to as "app://api/attachments/<asset id>".
const TD_SCHEMA = 31, TD_PAGE = [834.24, 1078.827];

async function textDocToGoodnotes(doc, { quiet = false } = {}) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) throw new Error('PDF-Bibliothek nicht geladen (offline?)');
  if (!quiet) toast('Goodnotes-Datei wird erstellt…', 0);
  const { loadYjs, renderTextThumb } = await import('./textdoc.js');
  const Y = await loadYjs();
  const files = [], events = [], attIndex = [];
  const device = (BigInt(rnd()) << 31n) | BigInt(rnd() >>> 1);
  let counter = Date.now();
  const now = () => Date.now() + Math.random();
  const docId = uuid();
  const common = (m, a, b, c, schema = SCHEMA) => m.d(10, now()).s(11, uuid()).u(a, device).u(b, counter++).u(c, schema);

  // blank page background
  const pdf = new jsPDF({ unit: 'pt', format: TD_PAGE, orientation: 'p', compress: true });
  const bgPdf = new Uint8Array(pdf.output('arraybuffer'));
  const bgAtt = uuid();
  files.push([`attachments/${bgAtt}`, bgPdf]);
  attIndex.push([bgAtt, `attachments/${bgAtt}`]);

  // images → attachments with an asset id
  const images = [];
  const collect = n => { if (n.type === 'img' && n.src) images.push(n); (n.children || []).forEach(collect); };
  doc.blocks.forEach(collect);
  const assetOf = new Map();
  for (const n of images) {
    if (assetOf.has(n.src)) continue;
    const bytes = new Uint8Array(await (await fetch(n.src)).arrayBuffer());
    const att = uuid(), asset = uuid();
    files.push([`attachments/${att}`, bytes]);
    attIndex.push([att, `attachments/${att}`]);
    assetOf.set(n.src, { att, asset, size: bytes.length });
  }

  // Slate nodes → Yjs (slate-yjs layout)
  const ydoc = new Y.Doc();
  const toDelta = nodes => nodes.flatMap(n => {
    if (n.text !== undefined) {
      const { text, ...marks } = n;
      return text ? [Object.keys(marks).length ? { insert: text, attributes: marks } : { insert: text }] : [];
    }
    return [{ insert: toXml(n) }];
  });
  const toXml = n => {
    const t = new Y.XmlText();
    const { children, src, ...props } = n;
    if (n.type === 'img' && src && assetOf.has(src)) props.url = `app://api/attachments/${assetOf.get(src).asset}`;
    for (const [k, v] of Object.entries(props)) if (v !== undefined) t.setAttribute(k, v);
    t.applyDelta(toDelta(children || []), { sanitize: false });
    return t;
  };
  ydoc.get('content', Y.XmlText).applyDelta(toDelta(doc.blocks), { sanitize: false });
  const update = Y.encodeStateAsUpdate(ydoc), stateVector = Y.encodeStateVector(ydoc);

  const name = doc.name || 'Unbenanntes Textdokument';
  const DEFAULT_PAPER = '5A53E89E-F4C2-4548-8DD3-E9DF9FB4592E';
  events.push(pb().s(1, docId).m(30, common(pb()
    .s(1, docId)
    .m(2, pb().s(1, name).m(2, clock()))
    .m(3, pb().s(1, DEFAULT_PAPER).m(2, clock()))
    .m(6, pb().s(1, 'P').m(2, clock()))
    .m(7, pb().s(1, DEFAULT_PAPER).m(2, clock()))
    .s(9, 'auto'), 13, 14, 20, TD_SCHEMA)
    .u(15, 5) // document type: text document
    .m(17, new Uint8Array()).m(18, new Uint8Array()).m(19, pb().m(2, clock()))));
  events.push(pb().s(1, bgAtt).m(6, common(pb().s(1, bgAtt).s(2, bgAtt).u(5, bgPdf.length).s(6, docId), 14, 15, 16).m(12, new Uint8Array())));
  const bgId = uuid(), sid = sheetId(), nid = plusOne(sid);
  events.push(pb().s(1, bgId).m(2, common(pb().s(1, docId).s(2, bgId).s(4, bgAtt).u(5, 1)
    .m(8, pb().f(1, TD_PAGE[0]).f(2, TD_PAGE[1])), 15, 16, 21)
    .m(12, pb().m(2, clock())).m(13, pb().m(2, clock())).m(17, pb().m(2, clock())).m(19, pb().m(2, clock()))));
  events.push(pb().s(1, sid).m(54, common(pb().s(1, docId).s(2, sid)
    .m(3, pb().s(1, bgId).m(2, clock()))
    .m(4, pb().s(1, 'U').m(2, clock())), 13, 14, 15)
    .m(17, pb().m(1, pb().m(2, pb().m(1, rgba('#DDDDDD')).m(2, rgba('#FFFFFF')))).m(2, clock()))));
  events.push(pb().s(1, bgAtt).m(105, common(pb().s(2, docId).s(3, bgAtt), 13, 14, 15)));
  events.push(pb().s(1, bgAtt).m(103, common(pb().s(1, bgAtt).s(2, docId).u(14, 1).s(16, uuid()), 18, 19, 20)));
  for (const { att, asset, size } of assetOf.values()) {
    events.push(pb().s(1, att).m(6, common(pb().s(1, att).s(2, att).u(5, size).s(6, docId), 14, 15, 16, TD_SCHEMA)
      .m(12, pb().u(1, 1).u(2, 1)).s(17, asset)));
  }
  files.push([`search/${bgAtt}`, stream([pb().u(2, 1).m(3, new Uint8Array())])]);

  // the notes file: header + text element
  const elId = uuid(), hc = clock(1);
  files.push([`notes/${nid}`, stream([
    pb().s(1, elId).m(2, hc).u(8, device).u(9, 3_700_000).u(14, 5381).u(16, TD_SCHEMA),
    pb().m(13, pb().s(1, elId).u(2, TD_SCHEMA).m(3, hc).m(10, update).m(11, stateVector)),
  ])]);

  const index = list => stream(list.map(([id, path]) => pb().s(1, id).s(2, path)));
  const thumb = document.createElement('canvas');
  renderTextThumb(thumb, doc, 300);
  const thumbBytes = new Uint8Array(await (await fetch(thumb.toDataURL('image/jpeg', 0.85))).arrayBuffer());
  files.push(
    ['document.info.pb', pb().u(1, 5).done()],
    ['index.attachments.pb', index(attIndex)],
    ['index.events.pb', stream(events)],
    ['index.notes.pb', index([[nid, `notes/${nid}`]])],
    ['index.search.pb', stream([pb().s(1, bgAtt).s(2, `search/${bgAtt}`).u(3, 1)])],
    ['schema.pb', pb().u(1, TD_SCHEMA).done()],
    ['thumbnail.jpg', thumbBytes],
  );
  return new Blob([zip(files)], { type: 'application/octet-stream' });
}

// The .goodnotes file is built in memory with an image of every page: long documents are refused
// (instead of the app running out of memory on an iPad).
export const MAX_GN_PAGES = 150;
export async function exportGoodnotes(doc) {
  if ((doc.pages?.length || 0) > MAX_GN_PAGES) return toast(`Zu lang für den Goodnotes-Export (${doc.pages.length} Seiten, höchstens ${MAX_GN_PAGES}). Als PDF exportieren geht.`, 5000);
  try {
    const blob = await notebookToGoodnotes(doc);
    const name = (doc.name || 'Folio').replace(/[\\/:*?"<>|]/g, '_') + '.goodnotes';
    const file = new File([blob], name, { type: 'application/octet-stream' });
    // iPad: share sheet ("In Goodnotes öffnen" / "In Dateien sichern"). iOS only opens it right
    // after a tap, and building the file takes too long for that — so ask for one more tap.
    // Only iPad/iPhone use the share sheet; on a PC (where Chrome/Edge can also "share") download.
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && navigator.canShare?.({ files: [file] })) {
      toast('', 1);
      const go = h('button', { class: 'pill-btn primary', style: { width: '100%', justifyContent: 'center', height: '44px' } }, 'Teilen / Sichern…');
      const body = h('div', { class: 'form' },
        h('div', {}, `„${name}“ ist fertig.`),
        h('div', { class: 'hint' }, 'Im Teilen-Menü „In Goodnotes öffnen“ oder „In Dateien sichern“ wählen.'),
        go);
      const done = sheet({ title: 'Goodnotes-Export', body, done: null });
      go.onclick = async () => {
        try { await navigator.share({ files: [file] }); } catch (err) { if (err.name !== 'AbortError') toast('Teilen nicht möglich: ' + err.message, 5000); }
        go.closest('.sheet')?.querySelector('.sheet-head .textbtn')?.click();
      };
      await done;
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Goodnotes-Datei exportiert');
  } catch (err) { toast('Export fehlgeschlagen: ' + err.message, 6000); }
}
