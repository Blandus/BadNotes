import { PAGE_W } from './store.js';
import { renderPage, pageH } from './render.js';
import { uid, readAsDataURL } from './util.js';
import { toast } from './ui.js';
import { pdfFileToPages } from './pdfdoc.js';

// Pages of a new notebook from a PDF. The PDF itself is stored once and the pages refer to it
// (pdfdoc.js): nothing is converted to images, so even a 450-page textbook stays a small
// document. The text of each page is kept for search and name suggestions.
export async function pdfToPages(file) {
  const pages = await pdfFileToPages(file, { pageText, progress: (i, n) => toast(`PDF wird importiert: Seite ${i} von ${n}`, 0) });
  toast(`${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'} importiert`);
  return pages;
}

// Text of one PDF page (max. 4000 chars) and its "title": the line in the largest font
// within the upper half of the page.
async function pageText(p) {
  const tc = await p.getTextContent();
  const vh = p.getViewport({ scale: 1 }).height;
  const items = tc.items.filter(it => it.str?.trim()).map(it => ({
    str: it.str, size: Math.hypot(it.transform[2], it.transform[3]), y: it.transform[5],
  }));
  const text = items.map(it => it.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const top = items.filter(it => it.y > vh * 0.5);
  if (!top.length) return { text };
  const max = Math.max(...top.map(it => it.size));
  // all pieces of that size, top to bottom (PDF y grows upwards)
  const title = top.filter(it => it.size > max * 0.92).sort((a, b) => b.y - a.y)
    .map(it => it.str).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { text, title };
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

const safeName = n => (n || 'Folio').replace(/[\\/:*?"<>|]/g, '_');

export const MAX_EXPORT_PAGES = 500;
export async function exportPdf(doc, pages = doc.pages) {
  const { jsPDF } = window.jspdf || {};
  if (!jsPDF) return toast('PDF-Bibliothek nicht geladen (offline?)');
  // the whole PDF is built in memory: long documents get smaller page images, very long ones
  // are refused (an iPad would run out of memory) — export single pages or a range instead
  if (pages.length > MAX_EXPORT_PAGES) return toast(`Zu lang für den Export auf einmal (${pages.length} Seiten, höchstens ${MAX_EXPORT_PAGES}).`, 5000);
  const long = pages.length > 100, s = long ? 1.1 : 1.6, q = long ? 0.75 : 0.9;
  let pdf;
  for (const [i, page] of pages.entries()) {
    toast(`PDF wird erstellt: Seite ${i + 1} von ${pages.length}`, 0);
    const h = pageH(page);
    const c = document.createElement('canvas');
    c.width = PAGE_W * s; c.height = Math.round(h * s);
    await renderPage(c.getContext('2d'), page, s);
    const fmt = [PAGE_W * 0.595, h * 0.595]; // A4 width = 595 pt
    const orient = fmt[0] > fmt[1] ? 'l' : 'p';
    if (!pdf) pdf = new jsPDF({ unit: 'pt', format: fmt, orientation: orient });
    else pdf.addPage(fmt, orient);
    pdf.addImage(c.toDataURL('image/jpeg', q), 'JPEG', 0, 0, fmt[0], fmt[1]);
    c.width = c.height = 0;
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
