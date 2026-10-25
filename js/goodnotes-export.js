// Export to the Goodnotes document format (.goodnotes) — EXPERIMENTAL.
// Mirrors the structure read in goodnotes.js (see there for the format description):
// - one PDF attachment holding every page's background (paper, template, imported PDF/image
//   background and text boxes, flattened), referenced by one page-background record per page
// - one sheet per page with a sort key, and a notes file per sheet with the ink:
//   header + element record per stroke (Apple-LZ4-wrapped "tpl" geometry) and per image
// Search/handwriting-recognition indexes (record types 102–106) are left out; Goodnotes
// builds those itself.
import { PAGE_W } from './store.js';
import { pageH, pieceWidth, renderPage } from './render.js';
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
// Each segment between two points becomes a straight quadratic segment (control = midpoint) and
// a piece of outline along both edges at the local width (move, line, line, line → closed band).
// Joints and ends are covered by the neighbouring pieces; no outline point lies inside the stroke.
function strokeTpl(s) {
  let pts = s.points.map(p => [p[0] * PT, p[1] * PT, p[2] ?? 0.5]);
  if (s.closed && pts.length > 2) pts = [...pts, pts[0]];
  // Zero-length segments make direction/tangent 0/0 → Goodnotes draws spikes. Drop near-duplicates.
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 0.05);
  if (pts.length === 1) pts = [pts[0], [pts[0][0] + 0.1, pts[0][1], pts[0][2]]];
  const hl = s.tool === 'highlighter' || s.shape;
  const widthAt = (p, dx, dy) => (hl ? s.width : pieceWidth(s, p, dx, dy)) * PT;
  const segs = [], ctrl = [], tangents = [], outline = [], cmds = [], counts = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, mp = (a[2] + b[2]) / 2;
    segs.push(mx, my, mp, b[0], b[1], b[2]);
    ctrl.push(mx, my);
    tangents.push(a[0], a[1], a[2], ux, uy, b[0], b[1], b[2], ux, uy);
    const ra = widthAt(a[2], dx, dy) / 2, rb = widthAt(b[2], dx, dy) / 2;
    outline.push(
      a[0] + nx * ra, a[1] + ny * ra,   // move: start, left edge
      b[0] + nx * rb, b[1] + ny * rb,   // line: end, left edge
      b[0] - nx * rb, b[1] - ny * rb,   // line: end, right edge
      a[0] - nx * ra, a[1] - ny * ra);  // line: start, right edge
    cmds.push(0, 2, 2, 2); counts.push(4);
  }
  const n = pts.length - 1;
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

// ---------- whole document ----------
export async function notebookToGoodnotes(doc) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) throw new Error('PDF-Bibliothek nicht geladen (offline?)');
  toast('Goodnotes-Datei wird erstellt…', 0);
  const files = [];
  const device = (BigInt(rnd()) << 31n) | BigInt(rnd() >>> 1);
  let counter = Date.now();
  const now = () => Date.now() + Math.random();
  const docId = uuid();
  const common = (m, a, b, c) => m.d(10, now()).s(11, uuid()).u(a, device).u(b, counter++).u(c, SCHEMA);

  // 1) Backgrounds: one PDF, a page per note page (paper, template, background image, text boxes)
  let pdf;
  for (const page of doc.pages) {
    const h = pageH(page), s = 2;
    const c = document.createElement('canvas');
    c.width = PAGE_W * s; c.height = Math.round(h * s);
    const bgOnly = { ...page, elements: page.elements.filter(e => e.type === 'text') };
    await renderPage(c.getContext('2d'), bgOnly, s);
    const fmt = [PAGE_W * PT, h * PT];
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: fmt, orientation: fmt[0] > fmt[1] ? 'l' : 'p', compress: true });
    else pdf.addPage(fmt, fmt[0] > fmt[1] ? 'l' : 'p');
    pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, fmt[0], fmt[1]);
  }
  const bgPdf = new Uint8Array(pdf.output('arraybuffer'));
  const bgAtt = uuid();
  files.push([`attachments/${bgAtt}`, bgPdf]);

  const events = [], noteIndex = [], attIndex = [[bgAtt, `attachments/${bgAtt}`]];
  events.push(pb().s(1, docId).m(30, common(pb()
    .s(1, docId)
    .m(2, pb().s(1, doc.name || 'BadNotes').m(2, clock(3)))
    .m(3, pb().s(1, uuid()).m(2, clock(3)))
    .m(6, pb().s(1, 'P').m(2, clock()))
    .m(7, pb().s(1, uuid()).m(2, clock()))
    .s(9, 'de_DE'), 13, 14, 20)
    .m(17, new Uint8Array()).m(18, new Uint8Array()).m(19, pb().m(2, clock()))));
  // Title again as a rename record (type 31) — Goodnotes takes the current title from these
  events.push(pb().s(1, docId).m(31, common(pb().s(1, docId).m(2, pb().s(1, doc.name || 'BadNotes').m(2, clock(6))), 13, 14, 15)));
  events.push(pb().s(1, bgAtt).m(6, common(pb().s(1, bgAtt).s(2, bgAtt).u(5, bgPdf.length).s(6, docId), 14, 15, 16)
    .m(12, pb().u(1, 1).u(2, doc.pages.length))));

  // 2) Images used on pages → attachments (one per distinct image)
  const imageAtts = new Map();
  for (const page of doc.pages) for (const e of page.elements) {
    if (e.type !== 'image' || imageAtts.has(e.src)) continue;
    const bytes = new Uint8Array(await (await fetch(e.src)).arrayBuffer());
    const id = uuid();
    imageAtts.set(e.src, id);
    files.push([`attachments/${id}`, bytes]);
    attIndex.push([id, `attachments/${id}`]);
    events.push(pb().s(1, id).m(6, common(pb().s(1, id).s(2, id).u(5, bytes.length).s(6, docId), 14, 15, 16).m(12, new Uint8Array())));
  }

  // 3) Pages: background record, sheet record (sort key), notes file
  for (const [i, page] of doc.pages.entries()) {
    const bgId = uuid(), sid = sheetId(), nid = plusOne(sid);
    const w = PAGE_W * PT, h = pageH(page) * PT;
    events.push(pb().s(1, bgId).m(2, common(pb().s(1, docId).s(2, bgId).s(4, bgAtt).u(5, i + 1)
      .m(8, pb().f(1, w).f(2, h)), 15, 16, 21)
      .m(12, pb().m(2, clock())).m(13, pb().m(2, clock())).m(17, pb().m(2, clock())).m(19, pb().m(2, clock()))));
    events.push(pb().s(1, sid).m(54, common(pb().s(1, docId).s(2, sid)
      .m(3, pb().s(1, bgId).m(2, clock()))
      .m(4, pb().s(1, 'a' + String(i).padStart(5, '0')).m(2, clock())), 13, 14, 15)
      .m(17, pb().m(1, pb().m(2, pb().m(1, rgba('#DDDDDD')).m(2, rgba('#FFFFFF')))).m(2, clock()))));

    const recs = [];
    let seq = 1;
    for (const e of page.elements) {
      const id = uuid();
      if (e.type === 'stroke') {
        recs.push(pb().s(1, id).m(2, clock(seq)).u(8, device).u(9, counter++).u(14, 5381).u(16, SCHEMA));
        recs.push(pb().m(7, pb().s(1, id).m(2, bv41(strokeTpl(e))).u(3, 1)
          .m(4, rgba(e.color, e.tool === 'highlighter' ? 0.4 : 1))
          .m(6, new Uint8Array()).m(7, pb().m(1, clock(seq))).m(9, new Uint8Array())
          .m(15, clock(seq)).m(20, new Uint8Array()).u(21, SCHEMA)));
      } else if (e.type === 'image' && imageAtts.has(e.src)) {
        const ref = uuid(), x = e.x * PT, y = e.y * PT, iw = e.w * PT, ih = e.h * PT;
        recs.push(pb().s(1, id).m(2, clock(seq)).s(4, ref).s(6, uuid()).s(7, imageAtts.get(e.src))
          .u(8, device).u(9, counter++).s(11, uuid()).m(12, pb().s(1, uuid()).s(2, docId)).m(13, pb().s(1, uuid()).s(2, docId))
          .u(14, 5381).u(16, SCHEMA));
        recs.push(pb().m(1, pb().s(1, id)
          .m(2, pb().m(1, pb().f(1, x).f(2, y)).m(2, pb().f(1, iw).f(2, ih)))
          .m(3, pb().m(1, pb().f(1, x + iw / 2).f(2, y + ih / 2)).m(2, pb().f(1, iw).f(2, ih)))
          .s(4, ref).m(5, pb().m(1, clock(seq))).m(15, clock(seq)).u(18, SCHEMA)));
      }
      seq++;
    }
    files.push([`notes/${nid}`, stream(recs)]);
    noteIndex.push([nid, `notes/${nid}`]);
  }

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
    ['index.search.pb', new Uint8Array()],
    ['schema.pb', pb().u(1, SCHEMA).done()],
    ['thumbnail.jpg', thumbBytes],
  );
  return new Blob([zip(files)], { type: 'application/octet-stream' });
}

export async function exportGoodnotes(doc) {
  try {
    const blob = await notebookToGoodnotes(doc);
    const name = (doc.name || 'BadNotes').replace(/[\\/:*?"<>|]/g, '_') + '.goodnotes';
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
