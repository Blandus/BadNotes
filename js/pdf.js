import { PAGE_W } from './store.js';
import { renderPage, pageH } from './render.js';
import { uid, readAsDataURL } from './util.js';
import { toast } from './ui.js';

const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Renders each PDF page to a JPEG background of a new note page.
export async function pdfToPages(file) {
  const pdfjs = window.pdfjsLib;
  if (!pdfjs) throw new Error('PDF-Bibliothek nicht geladen (offline?)');
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    toast(`PDF wird importiert: Seite ${i} von ${doc.numPages}`, 0);
    const p = await doc.getPage(i);
    const vp1 = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: 1600 / vp1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    // 'print' intent renders without requestAnimationFrame (works in background tabs too)
    await p.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    pages.push({ id: uid(), template: 'blank', bg: c.toDataURL('image/jpeg', 0.85), h: Math.round(PAGE_W * vp1.height / vp1.width), elements: [] });
  }
  toast(`${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} importiert`);
  return pages;
}

// Downscales an image file and returns {src, w, h} in pixels.
export async function loadImageFile(file, max = 1600) {
  const src = await readAsDataURL(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const png = file.type === 'image/png';
  return { src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.88), w: c.width, h: c.height };
}

const safeName = n => (n || 'Notizen').replace(/[\\/:*?"<>|]/g, '_');

export async function exportPdf(doc, pages = doc.pages) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) return toast('PDF-Bibliothek nicht geladen (offline?)');
  toast('PDF wird erstellt…', 0);
  let pdf;
  for (const page of pages) {
    const h = pageH(page), s = 1.6;
    const c = document.createElement('canvas');
    c.width = PAGE_W * s; c.height = Math.round(h * s);
    await renderPage(c.getContext('2d'), page, s);
    const fmt = [PAGE_W * 0.595, h * 0.595]; // A4 width = 595 pt
    const orient = fmt[0] > fmt[1] ? 'l' : 'p';
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: fmt, orientation: orient });
    else pdf.addPage(fmt, orient);
    pdf.addImage(c.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, fmt[0], fmt[1]);
  }
  pdf.save(safeName(doc.name) + '.pdf');
  toast('PDF exportiert');
}

export async function exportPng(doc, page, index) {
  const c = document.createElement('canvas'), s = 2;
  c.width = PAGE_W * s; c.height = Math.round(pageH(page) * s);
  await renderPage(c.getContext('2d'), page, s);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `${safeName(doc.name)} – Seite ${index + 1}.png`;
  a.click();
}
