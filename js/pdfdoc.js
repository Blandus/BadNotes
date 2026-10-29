// Imported PDFs are kept as the original file and their pages drawn when needed.
//
// Before, every PDF page was turned into a JPEG and stored as text in the document: a 450-page
// textbook became one ~100 MB record that had to be loaded, saved and synced as a whole, and a
// folder of literature several hundred MB — too much for an iPad's memory. Now:
// - the PDF is stored once, as a file (IndexedDB store 'files': { id, blob, size, name,
//   uploaded, created }); a page only refers to it: page.pdf = { file, n } (n = page number);
// - pages are rendered with pdf.js at the size they are shown (only the visible part when
//   zoomed in), results kept in a bounded cache, at most a few PDFs open at once;
// - sync.js uploads the file once to Google Drive (<id>.pdf) and loads it on another device the
//   first time a page is shown; offload.js may drop the local copy of large unused files.
// Older documents whose pages are images keep working unchanged.
import { store, PAGE_W } from './store.js';
import { uid } from './util.js';

const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const pdfjs = () => {
  const p = window.pdfjsLib;
  if (!p) throw new Error('PDF-Bibliothek nicht geladen (offline?)');
  p.GlobalWorkerOptions.workerSrc = WORKER;
  return p;
};

// Hooks from sync.js: fetchFile(id) → Blob from Drive (or null).
let hooks = { fetchFile: null };
export function configurePdf(h) { hooks = { ...hooks, ...h }; }

// ---------- Files ----------
export async function savePdfFile(blob, name = '') {
  const id = 'pdf' + uid();
  const b = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
  await store.putFile({ id, blob: b, size: b.size, name, uploaded: false, created: Date.now() });
  return id;
}
// pdf file ids a record refers to
export function filesOf(r) {
  if (r.offloaded || r.light) return r.pdfFiles || [];
  const s = new Set();
  for (const p of r.pages || []) if (p.pdf?.file) s.add(p.pdf.file);
  return [...s];
}

// The file's bytes: on this device, or loaded from Drive once (then kept here).
const fetching = new Map(), failedAt = new Map();
async function fileBlob(id) {
  const e = await store.getFile(id);
  if (e?.blob) return e.blob;
  if (!hooks.fetchFile) throw new Error('nicht auf diesem Gerät');
  if (Date.now() - (failedAt.get(id) || 0) < 30000) throw new Error('nicht verfügbar');
  if (!fetching.has(id)) {
    fetching.set(id, (async () => {
      try {
        const blob = await hooks.fetchFile(id);
        if (!blob) throw new Error('nicht in Google Drive gefunden');
        await store.putFile({ ...(e || { id, name: '', created: Date.now() }), blob, size: blob.size, uploaded: true });
        return blob;
      } catch (err) { failedAt.set(id, Date.now()); throw err; }
      finally { fetching.delete(id); }
    })());
  }
  return fetching.get(id);
}

// Original bytes and PDF.js' exact display transforms for lossless PDF export.
// Missing/offloaded originals must raise an error, never become a placeholder in the export.
export async function pdfExportSource(id, numbers) {
  const bytes = new Uint8Array(await (await fileBlob(id)).arrayBuffer());
  const views = new Map();
  await withDoc(id, async doc => {
    for (const n of numbers) {
      if (!Number.isInteger(n) || n < 1 || n > doc.numPages) throw new Error('Ungültige PDF-Seitennummer');
      const page = await doc.getPage(n);
      const width = page.getViewport({ scale: 1 }).width;
      const view = page.getViewport({ scale: PAGE_W / width });
      views.set(n, { transform: view.transform, width: view.width, height: view.height, box: page.view });
    }
  });
  return { bytes, views };
}

// load a file from Drive now if it is not on this device (favourites: available offline)
export const fetchFileNow = id => fileBlob(id).then(() => true);

// ---------- Open documents (at most a few, least recently used are closed) ----------
const MAX_DOCS = 3;
const docs = new Map(); // id → { p: Promise<PDFDocumentProxy>, uses }
function closeIdle() {
  for (const [id, d] of docs) {
    if (docs.size <= MAX_DOCS) break;
    if (d.uses) continue;
    docs.delete(id);
    d.p.then(doc => doc.destroy()).catch(() => {});
  }
}
async function withDoc(id, fn) {
  let d = docs.get(id);
  if (d) { docs.delete(id); docs.set(id, d); } // most recently used
  else {
    d = { uses: 0 };
    d.p = (async () => pdfjs().getDocument({ data: new Uint8Array(await (await fileBlob(id)).arrayBuffer()) }).promise)();
    d.p.catch(() => { if (docs.get(id) === d) docs.delete(id); });
    docs.set(id, d);
  }
  d.uses++;
  try { return await fn(await d.p); } finally { d.uses--; closeIdle(); }
}

// ---------- Rendered pages (bounded cache, like the image cache in render.js) ----------
const BUDGET = 64e6;
const rendered = new Map(); // key → { c: canvas, bytes } | { p: Promise }
let renderedBytes = 0;
function trimRendered() {
  for (const [k, v] of rendered) {
    if (renderedBytes <= BUDGET || rendered.size <= 3) break;
    rendered.delete(k); renderedBytes -= v.bytes || 0;
  }
}
// Render queue: newest request first, at most two at a time. Scrolling quickly through a book
// asks for many pages; the one now on screen must not wait behind all the pages flown past.
const queue = [];
let running = 0;
function renderInto(...args) {
  const job = { args };
  const p = new Promise((res, rej) => { job.res = res; job.rej = rej; });
  queue.push(job); pump();
  p.job = job;
  return p;
}
// asked for again (e.g. the page scrolled past earlier is now on screen): to the front
function bump(job) {
  const i = queue.indexOf(job);
  if (i >= 0 && i !== queue.length - 1) { queue.splice(i, 1); queue.push(job); }
}
function pump() {
  while (running < 2 && queue.length) {
    const job = queue.pop(); // most recent
    running++;
    renderNow(...job.args).then(job.res, job.rej).finally(() => { running--; pump(); });
  }
}
async function renderNow(page, W, H, scale, ox, oy) {
  const { file, n } = page.pdf;
  return withDoc(file, async doc => {
    const p = await doc.getPage(Math.min(Math.max(1, n || 1), doc.numPages));
    const vp1 = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: scale * PAGE_W / vp1.width, offsetX: ox, offsetY: oy });
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    // 'print' renders without requestAnimationFrame (also in background tabs)
    await p.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    p.cleanup();
    return c;
  });
}

// Draws the PDF page behind page's content into ctx (whose transform maps page units → pixels:
// scale, offset ox/oy in pixels). Returns false if the file is not available (offline).
let lastCut = null;
export async function drawPdfPage(ctx, page, scale, ox = 0, oy = 0) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const whole = !ox && !oy; // full page (page canvases, thumbnails): cached; zoomed-in parts are not
  const key = whole ? `${page.pdf.file}|${page.pdf.n}|${W}x${H}` : null;
  let c;
  try {
    if (key) {
      let v = rendered.get(key);
      if (v) { rendered.delete(key); rendered.set(key, v); if (!v.c && v.p.job) bump(v.p.job); }
      else {
        v = { p: renderInto(page, W, H, scale, 0, 0) };
        rendered.set(key, v);
        v.p.then(cv => { if (rendered.get(key) === v) { v.c = cv; v.bytes = W * H * 4; renderedBytes += v.bytes; trimRendered(); } },
          () => { if (rendered.get(key) === v) rendered.delete(key); });
      }
      c = v.c || await v.p;
    } else {
      // the latest cut-out (a page's sharp detail layer) is kept, so redrawing parts of it
      // (erasing) doesn't render the PDF again each time
      const k = `${page.pdf.file}|${page.pdf.n}|${W}x${H}|${scale}|${ox}|${oy}`;
      if (lastCut?.key !== k) lastCut = { key: k, p: renderInto(page, W, H, scale, ox, oy) };
      const cut = lastCut;
      try { c = await cut.p; } catch (err) { if (lastCut === cut) lastCut = null; throw err; }
    }
  } catch { return false; }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(c, 0, 0); ctx.restore();
  return true;
}

// ---------- Import ----------
// Pages of a PDF file, kept as the original: the file is stored, the pages refer to it.
// pageText(p) → { text, title } is passed in by pdf.js (search and name suggestions).
export async function pdfFileToPages(file, { pageText, progress } = {}) {
  const fileId = await savePdfFile(file, file.name || '');
  const doc = await pdfjs().getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      progress?.(i, doc.numPages);
      const p = await doc.getPage(i);
      const vp1 = p.getViewport({ scale: 1 });
      const page = { id: uid(), template: 'blank', pdf: { file: fileId, n: i }, h: Math.round(PAGE_W * vp1.height / vp1.width), elements: [] };
      if (pageText) {
        try {
          const { text, title } = await pageText(p);
          if (text) page.pdfText = text;
          if (i === 1 && title) page.pdfTitle = title;
        } catch {}
      }
      pages.push(page);
      p.cleanup();
    }
    try {
      const meta = (await doc.getMetadata())?.info?.Title?.trim();
      if (meta && pages[0]) pages[0].pdfMetaTitle = meta;
    } catch {}
    return pages;
  } finally { doc.destroy(); }
}
