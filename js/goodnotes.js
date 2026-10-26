// Import of Goodnotes documents (.goodnotes). Reverse-engineered from a Goodnotes 6 export:
//
// - The file is a ZIP. index.notes.pb / index.attachments.pb map ids → files.
// - index.events.pb is a change log (length-prefixed protobuf records). Relevant record types:
//     30/31  document (2.1 = title)            6  attachment (2 = file id)
//      2     page background: 4 = attachment (PDF), 5 = page number, 8 = size in points
//     54     sheet: 3.1 = page background id, 4.1 = sort key (fractional index, byte order)
//      3     sheet background changed later: 2 = sheet, 3.1 = new page background id
// - notes/<id> holds one sheet's ink (id = sheet id with the last hex digit + 1). Records with
//   field 7 are elements: 1 id, 2 geometry blob, 4 colour RGBA (floats), 6 offset (x, y),
//   9 shape (9.1 points, 9.15 width), 14 = 1 → deleted. Images and text boxes (field 21):
//   see sheetElements() and convertText().
// - The geometry blob is Apple LZ4 ("bv41") wrapping a "tpl" serialisation
//   "vA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)": #2 start point (x, y, r),
//   #3 per segment a control point and an end point (x, y, r) of a quadratic curve, r = half
//   width in points; #4/#5/#8 the ink outline (commands per segment, commands, points).
// Strokes are imported as centre line + radius per point — the model Folio itself uses —
// so they behave exactly like strokes drawn in Folio (erasing, lasso, recolouring, sync).
import { PAGE_W, newPage } from './store.js';
import { uid, r1 } from './util.js';
import { toast } from './ui.js';
import { loadYjs } from './textdoc.js';

// ---------- ZIP (central directory + DecompressionStream) ----------
export async function unzip(buf) {
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
    // ZIPs made with Windows' own tools use "\" as path separator
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
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

  // Centre line → Folio points. Folio draws quadratic pieces from midpoint to midpoint
  // with its points as controls, and Goodnotes' pieces are nearly that (each end ≈ midpoint of
  // the neighbouring controls), so the controls become the points (plus the final end). A line
  // made only of straight pieces (control = midpoint of its ends, e.g. shapes) keeps its piece
  // ends instead, so corners stay sharp. The third value of every point is the half width.
  const pieces = [];
  for (let s = 0, prev = start; s + 5 < segs.length; s += 6) {
    const c = segs.slice(s, s + 3), e = segs.slice(s + 3, s + 6);
    pieces.push({ c, e, straight: Math.hypot(c[0] - (prev[0] + e[0]) / 2, c[1] - (prev[1] + e[1]) / 2) < 0.01 });
    prev = e;
  }
  const polyline = pieces.every(q => q.straight);
  const line = [[...P(start[0], start[1]), start[2]]];
  pieces.forEach(({ c, e, straight }, i) => {
    const last = i === pieces.length - 1;
    // Folio ends its lines with a straight piece; its control is not a point of the line
    if (!polyline && !(last && straight)) line.push([...P(c[0], c[1]), c[2]]);
    if (polyline || last) line.push([...P(e[0], e[1]), e[2]]);
  });
  const rs = line.map(p => p[2]).filter(r => r > 0).sort((a, b) => a - b);
  let med = rs[Math.floor(rs.length / 2)];
  if (!med) {
    // no radii: fall back to the outline (median distance of its points to the centre line)
    const ds = [];
    for (let q = 0; q + 1 < outline.length; q += 2) {
      const [x, y] = P(outline[q], outline[q + 1]);
      let best = Infinity;
      for (let i = 1; i < line.length; i++) best = Math.min(best, segDist([x, y], line[i - 1], line[i]));
      if (line.length === 1) best = Math.hypot(x - line[0][0], y - line[0][1]);
      ds.push(best);
    }
    ds.sort((a, b) => a - b);
    med = (ds[Math.floor(ds.length / 2)] || 0.5) / k;
  }
  const width = Math.max(0.6, r1(2 * med * k));
  // Pen strokes keep the radius per point (Folio stores strokes the same way, see ink.js);
  // highlighters have one constant width.
  const pen = tool === 'pen';
  for (const p of line) p[2] = pen ? Math.round((p[2] > 0 ? p[2] : med) * k * 100) / 100 : 0.5;
  return { id: uid(), type: 'stroke', tool, pen: 'ball', color, width, points: line, ...(pen ? { rad: 1 } : {}) };
}

// Text box (element field 21): 20.1 top-left of the box, 20.3 scale; 32.1.2 the text as
// Apple-LZ4 protobuf (1.1 text, 1.2 style run: 3 colour, 40 size, negative = default),
// 32.2 text size (w, h), 32.5.1 default style (3 colour, 40 size), 32.10 insets.
// One colour and size per box (the first run's), as Folio text boxes have.
function convertText(t, k, headers) {
  const head = headers.get(str(one(t, 1)));
  if (head?.deleted) return null;
  const place = sub(t, 20), o = sub(place, 1), scale = one(place, 3) || 1;
  const box = sub(t, 32), content = sub(box, 1), blob = one(content, 2);
  if (!(blob instanceof Uint8Array)) return null;
  const body = sub(msg(blob[0] === 0x62 ? bv41(blob) : blob), 1);
  const text = (str(one(body, 1)) || '').normalize('NFC');
  if (!text.trim()) return null;
  const run = sub(body, 2), def = sub(sub(box, 5), 1);
  const runSize = one(run, 40), size = (runSize > 0 ? runSize : one(def, 40) || 24) * scale;
  const c = run.has(3) ? sub(run, 3) : sub(def, 3);
  const color = '#' + hex(one(c, 1)) + hex(one(c, 2)) + hex(one(c, 3));
  const ins = sub(box, 10), dim = sub(box, 2);
  const x = (one(o, 1) || 0) + (one(ins, 2) ?? 10) * scale, y = (one(o, 2) || 0) + (one(ins, 1) ?? 10) * scale;
  // 21.2 = fixed width {box width, …}; 21.3 = grows with the text up to {min, max, …} → no
  // wrapping in Folio either (its font is a little wider than Helvetica)
  const sizing = sub(t, 21), auto = sub(sizing, 3);
  const w = (auto.size ? Math.max(one(auto, 2) || 600, one(dim, 1) || 0) : (one(dim, 1) || 200)) * scale;
  return { id: uid(), type: 'text', x: r1(x * k), y: r1(y * k), w: r1(w * k), size: r1(size * k), color, text };
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
      } else if (!m.has(2) && one(m, 21) instanceof Uint8Array) {
        const t = convertText(msg(one(m, 21)), k, headers);
        if (t) els.push(t);
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

// ---------- Text documents ----------
// Document type 5 (record 30, field 15). Its one notes file holds an element with field 13:
// 10 = a Yjs update of a slate-yjs document (root XmlText "content"; every Slate element is an
// embedded XmlText whose attributes are the element's props, text is inserted with the marks
// as formatting), 11 = its state vector. Images refer to "app://api/attachments/<asset id>";
// the asset id is field 17 of the attachment record (6).
async function textDocBlocks(read, notesIdx, imageSrc, assets) {
  const Y = await loadYjs();
  for (const path of notesIdx.values()) {
    const b = await read(path);
    if (!b?.length) continue;
    for (const r of records(b)) {
      const m = msg(r), el = one(m, 13);
      if (!(el instanceof Uint8Array)) continue;
      const update = one(msg(el), 10);
      if (!(update instanceof Uint8Array)) continue;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, update);
      const toNodes = t => t.toDelta().map(d => (d.insert instanceof Y.XmlText ? toElement(d.insert) : { text: String(d.insert), ...(d.attributes || {}) }));
      const toElement = t => { const kids = toNodes(t); return { ...t.getAttributes(), children: kids.length ? kids : [{ text: '' }] }; };
      const blocks = toNodes(doc.get('content', Y.XmlText)).filter(n => n.type);
      // images: attachment → data URL (the Goodnotes url is not kept; export makes new ones)
      const walk = async n => {
        if (n.type === 'img' && n.url) {
          const asset = String(n.url).split('/').pop();
          n.src = await imageSrc(assets.get(asset) || asset);
          delete n.url;
        }
        for (const c of n.children || []) await walk(c);
      };
      for (const n of blocks) await walk(n);
      return blocks.length ? blocks : null;
    }
  }
  return null;
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

  let title = file.name?.replace(/\.goodnotes$/i, '') || 'Goodnotes-Import', textDoc = false;
  const assets = new Map(); // asset id (used in text documents' image urls) → attachment id
  const bgs = new Map(), sheets = new Map(), attFile = new Map(), newBg = new Map();
  for (const r of records(events)) {
    const m = msg(r);
    for (const [type, vals] of m) {
      if (type === 1) continue;
      const v = vals[vals.length - 1];
      if (!(v instanceof Uint8Array)) continue;
      const x = msg(v);
      if (type === 30 || type === 31) { const t = str(one(sub(x, 2), 1)); if (t) title = t; if (type === 30 && one(x, 15) === 5) textDoc = true; }
      else if (type === 6) { attFile.set(str(one(x, 1)), str(one(x, 2))); if (str(one(x, 17))) assets.set(str(one(x, 17)), str(one(x, 1))); }
      else if (type === 2) {
        const size = sub(x, 8);
        bgs.set(str(one(x, 2)), { att: str(one(x, 4)), page: one(x, 5) || 1, w: one(size, 1) || 595, h: one(size, 2) || 842 });
      } else if (type === 54) {
        const id = str(one(x, 2));
        sheets.set(id, { id, bg: newBg.get(id) || str(one(sub(x, 3), 1)), order: str(one(sub(x, 4), 1)) || '' });
      } else if (type === 3) {
        // later change of a sheet's background (e.g. other paper/format): 2 sheet, 3.1 background
        const id = str(one(x, 2)), bg = str(one(sub(x, 3), 1));
        if (id && bg) { newBg.set(id, bg); if (sheets.has(id)) sheets.get(id).bg = bg; }
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

  if (textDoc) {
    const blocks = await textDocBlocks(read, notesIdx, imageSrc, assets);
    toast('Textdokument importiert');
    return { name: title.normalize('NFC'), blocks };
  }

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
  const all = pages.flatMap(p => p.elements), images = all.filter(e => e.type === 'image').length, texts = all.filter(e => e.type === 'text').length;
  toast(`${pages.length} Seiten · ${all.length - images - texts} Striche${images ? ` · ${images} Bilder` : ''}${texts ? ` · ${texts} Textfelder` : ''} importiert`);
  // Apple stores "Ü" as U + combining diaeresis; normalise so search and sorting work
  return { name: title.normalize('NFC'), pages };
}
