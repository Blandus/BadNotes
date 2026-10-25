// Import of Goodnotes documents (.goodnotes). Reverse-engineered from a Goodnotes 6 export:
//
// - The file is a ZIP. index.notes.pb / index.attachments.pb map ids → files.
// - index.events.pb is a change log (length-prefixed protobuf records). Relevant record types:
//     30/31  document (2.1 = title)            6  attachment (2 = file id)
//      2     page background: 4 = attachment (PDF), 5 = page number, 8 = size in points
//     54     sheet: 3.1 = page background id, 4.1 = sort key (fractional index, byte order)
// - notes/<id> holds one sheet's ink (id = sheet id with the last hex digit + 1). Records with
//   field 7 are elements: 1 id, 2 geometry blob, 4 colour RGBA (floats), 6 offset (x, y),
//   9 shape (9.1 points, 9.15 width), 14 = 1 → deleted. Images: see sheetElements().
// - The geometry blob is Apple LZ4 ("bv41") wrapping a "tpl" serialisation
//   "vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)": #2 start point (x, y, pressure),
//   #3 per segment a control point and an end point (x, y, pressure) of a quadratic curve,
//   #8 points of the rendered ink shape (x, y) — used here only to measure the stroke width.
// Strokes are imported as centre line + pressure + width, so they behave exactly like strokes
// drawn in BadNotes (erasing, lasso, recolouring, sync).
import { PAGE_W, newPage } from './store.js';
import { uid, r1 } from './util.js';
import { toast } from './ui.js';

// ---------- ZIP (central directory + DecompressionStream) ----------
async function unzip(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Keine gültige Goodnotes-Datei (kein ZIP)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extra + comment;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = b.subarray(start, start + csize);
    files.set(name, async () => method === 0 ? data
      : new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()));
  }
  return files;
}

// ---------- Protobuf (schema-less) ----------
function varint(b, s) {
  let x = 0, mul = 1;
  for (;;) { const c = b[s.i++]; x += (c & 127) * mul; if (c < 128) return x; mul *= 128; }
}
// → Map field → [values]; values are numbers, float32 numbers or Uint8Array (length-delimited)
function msg(b) {
  const s = { i: 0 }, m = new Map();
  const add = (f, v) => { if (!m.has(f)) m.set(f, []); m.get(f).push(v); };
  while (s.i < b.length) {
    const key = varint(b, s), f = Math.floor(key / 8), wt = key % 8;
    if (wt === 0) add(f, varint(b, s));
    else if (wt === 1) { add(f, new DataView(b.buffer, b.byteOffset + s.i, 8).getFloat64(0, true)); s.i += 8; }
    else if (wt === 5) { add(f, new DataView(b.buffer, b.byteOffset + s.i, 4).getFloat32(0, true)); s.i += 4; }
    else if (wt === 2) { const n = varint(b, s); add(f, b.subarray(s.i, s.i + n)); s.i += n; }
    else throw new Error('protobuf');
  }
  return m;
}
const records = b => { const s = { i: 0 }, out = []; while (s.i < b.length) { const n = varint(b, s); out.push(b.subarray(s.i, s.i + n)); s.i += n; } return out; };
const str = v => (v instanceof Uint8Array ? new TextDecoder().decode(v) : undefined);
const one = (m, f) => m.get(f)?.[m.get(f).length - 1];
const sub = (m, f) => { const v = one(m, f); return v instanceof Uint8Array ? msg(v) : new Map(); };

// ---------- Apple LZ4 ("bv41") ----------
function bv41(b) {
  const out = []; let i = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (i + 4 <= b.length) {
    const tag = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); i += 4;
    if (tag === 'bv4$') break;
    const raw = dv.getUint32(i, true); i += 4;
    if (tag === 'bv4-') { for (let k = 0; k < raw; k++) out.push(b[i + k]); i += raw; continue; }
    const enc = dv.getUint32(i, true); i += 4;
    const end = i + enc;
    while (i < end) {
      const tok = b[i++]; let lit = tok >> 4;
      if (lit === 15) { let x; do { x = b[i++]; lit += x; } while (x === 255); }
      for (let k = 0; k < lit; k++) out.push(b[i++]);
      if (i >= end) break;
      const off = b[i] | (b[i + 1] << 8); i += 2;
      let ml = tok & 15; if (ml === 15) { let x; do { x = b[i++]; ml += x; } while (x === 255); } ml += 4;
      const from = out.length - off; for (let k = 0; k < ml; k++) out.push(out[from + k]);
    }
    i = end;
  }
  return new Uint8Array(out);
}

// ---------- tpl (header "tpl", u32 size, format string, then data in format order) ----------
function tpl(d) {
  if (d.length < 9 || d[0] !== 0x74 || d[1] !== 0x70 || d[2] !== 0x6c) return null;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let i = 8; const fs = i; while (d[i]) i++;
  const fmt = new TextDecoder().decode(d.subarray(fs, i)); i++;
  const items = [];
  for (let p = 0; p < fmt.length;) {
    const c = fmt[p];
    if (c === 'v') { items.push(dv.getUint16(i, true)); i += 2; p++; }
    else if (c === 'u') { items.push(dv.getUint32(i, true)); i += 4; p++; }
    else if (c === 'A' && fmt[p + 1] === '(' && fmt[p + 3] === ')') {
      const t = fmt[p + 2], n = dv.getUint32(i, true); i += 4; const arr = [];
      if (t === 'v') { for (let k = 0; k < n; k++) arr.push(dv.getUint16(i + k * 2, true)); i += n * 2; }
      else if (t === 'u') { for (let k = 0; k < n; k++) arr.push(dv.getFloat32(i + k * 4, true)); i += n * 4; }
      else return null;
      items.push(arr); p += 4;
    } else return null; // other layouts (e.g. shapes) are read from their protobuf fields instead
  }
  return items;
}

// distance of point p to segment a–b
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

// ---------- Elements of one sheet ----------
const hex = v => Math.round(Math.max(0, Math.min(1, v || 0)) * 255).toString(16).padStart(2, '0');

function convertElement(m, k) {
  if (one(m, 14) === 1) return null; // erased
  const c = sub(m, 4), a = one(c, 4) ?? 1;
  const color = '#' + hex(one(c, 1)) + hex(one(c, 2)) + hex(one(c, 3));
  const off = sub(m, 6), dx = one(off, 1) || 0, dy = one(off, 2) || 0;
  const P = (x, y) => [r1((x + dx) * k), r1((y + dy) * k)];
  const tool = a < 0.95 ? 'highlighter' : 'pen';

  // Shapes: points and width directly in the protobuf
  const shape = sub(m, 9);
  if (shape.size) {
    // 9.1 is a list message whose repeated field 1 holds the points {1: x, 2: y}
    const list = sub(shape, 1);
    const pts = (list.get(1) || []).filter(v => v instanceof Uint8Array).map(v => { const q = msg(v); return P(one(q, 1) || 0, one(q, 2) || 0); });
    if (pts.length < 2) return null;
    const first = pts[0], last = pts[pts.length - 1];
    const closed = pts.length > 2 && Math.hypot(first[0] - last[0], first[1] - last[1]) < 0.5;
    return { id: uid(), type: 'stroke', tool, pen: 'ball', shape: true, closed, color, width: r1((one(shape, 15) || 2) * k), points: (closed ? pts.slice(0, -1) : pts).map(p => [...p, 0.5]) };
  }

  const blob = one(m, 2);
  if (!(blob instanceof Uint8Array) || blob.length < 12) return null;
  const items = tpl(blob[0] === 0x62 ? bv41(blob) : blob);
  if (!items || items.length < 9) return null;
  const [, , start, segs, , , , , outline] = items;
  if (!start?.length || !outline?.length) return null;

  // Centre line: start point, then each segment's quadratic curve sampled at t = .5 and 1
  const line = [[...P(start[0], start[1]), r1(start[2])]];
  let prev = start;
  for (let s = 0; s + 5 < segs.length; s += 6) {
    const cx = segs[s], cy = segs[s + 1], ex = segs[s + 3], ey = segs[s + 4], ep = segs[s + 5];
    const mx = 0.25 * prev[0] + 0.5 * cx + 0.25 * ex, my = 0.25 * prev[1] + 0.5 * cy + 0.25 * ey;
    line.push([...P(mx, my), r1((prev[2] + ep) / 2)], [...P(ex, ey), r1(ep)]);
    prev = [ex, ey, ep];
  }
  // Stroke width from the outline: twice the median distance of the outline points to the centre
  // line (outline points sit on the stroke's edges; the median ignores the few cap points).
  const ds = [];
  for (let q = 0; q + 1 < outline.length; q += 2) {
    const [x, y] = P(outline[q], outline[q + 1]);
    let best = Infinity;
    for (let i = 1; i < line.length; i++) best = Math.min(best, segDist([x, y], line[i - 1], line[i]));
    if (line.length === 1) best = Math.hypot(x - line[0][0], y - line[0][1]);
    ds.push(best);
  }
  ds.sort((a, b) => a - b);
  const width = Math.max(0.6, r1(2 * (ds[Math.floor(ds.length / 2)] || 0.5)));
  return { id: uid(), type: 'stroke', tool, pen: 'ball', color, width, points: line };
}

// A notes file alternates header records (1 id, 2 clock, 3 present → deleted, 7 attachment id
// for images) and element records: field 7 = stroke/shape, field 1 (nested) = image with
// 1 id and 2 frame {1: origin {x, y}, 2: size {w, h}} in points.
async function sheetElements(bytes, k, imageSrc) {
  const recs = records(bytes).map(r => msg(r));
  const headers = new Map();
  for (const m of recs) {
    if (!m.has(2)) continue;
    const id = str(one(m, 1));
    if (id) headers.set(id, { deleted: m.has(3), att: str(one(m, 7)) });
  }
  const els = [];
  for (const m of recs) {
    try {
      const e = one(m, 7);
      if (e instanceof Uint8Array && !m.has(2)) {
        const x = convertElement(msg(e), k);
        if (x) els.push(x);
      } else if (!m.has(2) && one(m, 1) instanceof Uint8Array) {
        const img = msg(one(m, 1)), id = str(one(img, 1)), head = headers.get(id);
        if (!head || head.deleted || !head.att) continue;
        const frame = sub(img, 2), o = sub(frame, 1), s = sub(frame, 2);
        const w = one(s, 1), h = one(s, 2);
        const src = w && h && await imageSrc(head.att);
        if (src) els.push({ id: uid(), type: 'image', src, x: r1((one(o, 1) || 0) * k), y: r1((one(o, 2) || 0) * k), w: r1(w * k), h: r1(h * k) });
      }
    } catch {}
  }
  // Goodnotes draws ink above pasted images, whatever order they were added in.
  return [...els.filter(e => e.type === 'image'), ...els.filter(e => e.type !== 'image')];
}

// ---------- Background PDF pages ----------
const pdfCache = new Map();
async function pdfPageImage(bytes, n, key) {
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) throw new Error('PDF-Bibliothek nicht geladen (offline?)');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  if (!pdfCache.has(key)) pdfCache.set(key, pdfjs.getDocument({ data: bytes.slice() }).promise);
  const doc = await pdfCache.get(key);
  const p = await doc.getPage(Math.min(Math.max(1, n || 1), doc.numPages));
  const vp1 = p.getViewport({ scale: 1 }), vp = p.getViewport({ scale: 1600 / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await p.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
  return c.toDataURL('image/jpeg', 0.85);
}

// ---------- Whole document ----------
export async function goodnotesToNotebook(file) {
  toast('Goodnotes-Datei wird gelesen…', 0);
  const zip = await unzip(await file.arrayBuffer());
  const read = async path => (zip.has(path) ? zip.get(path)() : null);
  const index = async path => {
    const map = new Map(), b = await read(path);
    if (b) for (const r of records(b)) { const m = msg(r); map.set(str(one(m, 1)), str(one(m, 2))); }
    return map;
  };
  const notesIdx = await index('index.notes.pb'), attIdx = await index('index.attachments.pb');
  const events = await read('index.events.pb');
  if (!events) throw new Error('Unbekanntes Goodnotes-Format (index.events.pb fehlt)');

  let title = file.name?.replace(/\.goodnotes$/i, '') || 'Goodnotes-Import';
  const bgs = new Map(), sheets = new Map(), attFile = new Map();
  for (const r of records(events)) {
    const m = msg(r);
    for (const [type, vals] of m) {
      if (type === 1) continue;
      const v = vals[vals.length - 1];
      if (!(v instanceof Uint8Array)) continue;
      const x = msg(v);
      if (type === 30 || type === 31) { const t = str(one(sub(x, 2), 1)); if (t) title = t; }
      else if (type === 6) attFile.set(str(one(x, 1)), str(one(x, 2)));
      else if (type === 2) {
        const size = sub(x, 8);
        bgs.set(str(one(x, 2)), { att: str(one(x, 4)), page: one(x, 5) || 1, w: one(size, 1) || 595, h: one(size, 2) || 842 });
      } else if (type === 54) {
        const id = str(one(x, 2));
        sheets.set(id, { id, bg: str(one(sub(x, 3), 1)), order: str(one(sub(x, 4), 1)) || '' });
      }
    }
  }
  // Sheet order: byte order of the fractional sort keys
  const ordered = [...sheets.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  // A sheet's ink file has the sheet id + 1 (as a hex number in the last group, with carry).
  const plusOne = id => {
    const head = id.slice(0, 24), tail = id.slice(24);
    return head + (BigInt('0x' + tail) + 1n).toString(16).toUpperCase().padStart(tail.length, '0');
  };
  const notesFor = id => {
    if (!id) return null;
    const next = plusOne(id);
    return [...notesIdx.keys()].find(n => n === next || n === id) || null;
  };

  // Image attachments (PNG/JPEG) as data URLs, each read once
  const attPath = id => attIdx.get(id) || (attFile.get(id) && `attachments/${attFile.get(id)}`);
  const imgCache = new Map();
  const imageSrc = id => {
    if (!imgCache.has(id)) imgCache.set(id, (async () => {
      const bytes = attPath(id) && await read(attPath(id));
      if (!bytes) return null;
      const type = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : null;
      return type && new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(new Blob([bytes], { type })); });
    })());
    return imgCache.get(id);
  };

  const pages = [];
  for (const [i, s] of ordered.entries()) {
    toast(`Goodnotes-Import: Seite ${i + 1} von ${ordered.length}`, 0);
    const bg = bgs.get(s.bg) || { w: 595, h: 842 };
    const k = PAGE_W / bg.w;
    const page = newPage('blank', Math.round(bg.h * k));
    if (bg.att) {
      const path = attIdx.get(bg.att) || (attFile.get(bg.att) && `attachments/${attFile.get(bg.att)}`);
      const bytes = path && await read(path);
      if (bytes && bytes[0] === 0x25 && bytes[1] === 0x50) { // %P(DF)
        try { page.bg = await pdfPageImage(bytes, bg.page, path); } catch {}
      }
    }
    const nid = notesFor(s.id);
    if (nid) {
      const b = await read(notesIdx.get(nid));
      if (b?.length) page.elements = await sheetElements(b, k, imageSrc);
    }
    pages.push(page);
  }
  if (!pages.length) throw new Error('Keine Seiten in der Goodnotes-Datei gefunden');
  const all = pages.flatMap(p => p.elements), images = all.filter(e => e.type === 'image').length;
  toast(`${pages.length} Seiten · ${all.length - images} Striche${images ? ` · ${images} Bilder` : ''} importiert`);
  // Apple stores "Ü" as U + combining diaeresis; normalise so search and sorting work
  return { name: title.normalize('NFC'), pages };
}
