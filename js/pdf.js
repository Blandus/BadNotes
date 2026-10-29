import { renderPage, pageX0, pageY0 } from './render.js';
import { readAsDataURL } from './util.js';
import { toast } from './ui.js';
import { pdfFileToPages } from './pdfdoc.js';
import { createPdf, exportArea } from './pdf-export.js';
export { MAX_EXPORT_PAGES } from './pdf-export.js';

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

// Renders an area of a page into a new canvas (scale s, capped so the canvas stays within browser limits).
async function renderArea(page, a, s) {
  s = Math.min(s, Math.sqrt(1.6e7 / (a.w * a.h)), 16000 / Math.max(a.w, a.h));
  const c = document.createElement('canvas');
  c.width = Math.round(a.w * s); c.height = Math.round(a.h * s);
  await renderPage(c.getContext('2d'), page, s, null, -(a.x - pageX0(page)) * s, -(a.y - pageY0(page)) * s);
  return c;
}

let exportingPdf = false;
export async function exportPdf(doc, pages = doc.pages) {
  if (exportingPdf) return toast('Ein PDF-Export läuft bereits');
  exportingPdf = true;
  try {
    const snapshot = structuredClone(pages);
    const bytes = await createPdf({ name: doc.name }, snapshot, message => toast(message, 0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url; link.download = safeName(doc.name) + '.pdf';
    document.body.append(link); link.click(); link.remove();
    // Safari needs the URL after the click has returned, especially for large PDFs.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('PDF mit Text und Vektoren exportiert');
  } catch (err) {
    console.error('PDF-Export:', err);
    toast('PDF-Export fehlgeschlagen: ' + (err.message || 'Unbekannter Fehler'), 8000);
  } finally { exportingPdf = false; }
}

export async function exportPng(doc, page, index) {
  const c = await renderArea(page, exportArea(page), 2);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `${safeName(doc.name)} – Seite ${index + 1}.png`;
  a.click();
}
