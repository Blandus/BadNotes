// Structured PDF export: original PDF pages, text objects, vector ink and embedded images.
// All coordinates/layout come from the same model as the editor. No whole-page screenshots.
import { PAGE_W } from './store.js';
import { pageH, pageX0, pageY0, unionBox, paperColor, drawTemplate, drawInfiniteTemplate, loadImage } from './render.js';
import { layout } from './richtext.js';
import { strokeSamples, strokeRadiusFn, addSamplesToPath } from './ink.js';
import { pdfExportSource } from './pdfdoc.js';

export const MAX_EXPORT_PAGES = 500;
export function exportArea(page) {
  if (!page.inf) return { x: 0, y: 0, w: PAGE_W, h: pageH(page) };
  if (!page.elements.length) return { x: pageX0(page), y: pageY0(page), w: PAGE_W, h: 1414 };
  const b = unionBox(page.elements), m = 40;
  return { x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m };
}

let libraries;
function loadScript(name, global) {
  if (window[global]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/pdf/' + name, import.meta.url).href;
    script.onload = () => window[global] ? resolve() : reject(new Error('PDF-Bibliothek nicht verfügbar'));
    script.onerror = () => { script.remove(); reject(new Error('PDF-Export nicht geladen. Folio einmal online öffnen.')); };
    document.head.append(script);
  });
}
async function loadLibraries() {
  if (!libraries) libraries = Promise.all([
    loadScript('pdf-lib.min.js', 'PDFLib'), loadScript('fontkit.umd.min.js', 'fontkit'),
  ]).catch(err => { libraries = null; throw err; });
  await libraries;
  return window.PDFLib;
}

// A small path recorder shared with ink.js. Circular joins stay cubic curves, not polygons.
class VectorPath {
  constructor() { this.parts = []; }
  moveTo(x, y) { this.parts.push(`M${x} ${y}`); }
  lineTo(x, y) { this.parts.push(`L${x} ${y}`); }
  closePath() { this.parts.push('Z'); }
  arc(x, y, r, start, end) {
    const count = Math.max(1, Math.ceil(Math.abs(end - start) / (Math.PI / 2)));
    for (let i = 0; i < count; i++) {
      const a = start + (end - start) * i / count, b = start + (end - start) * (i + 1) / count;
      const k = 4 / 3 * Math.tan((b - a) / 4);
      this.parts.push(`C${x + r * (Math.cos(a) - k * Math.sin(a))} ${y + r * (Math.sin(a) + k * Math.cos(a))} ${x + r * (Math.cos(b) + k * Math.sin(b))} ${y + r * (Math.sin(b) - k * Math.cos(b))} ${x + r * Math.cos(b)} ${y + r * Math.sin(b)}`);
    }
  }
  toString() { return this.parts.join(' '); }
}

// Only the canvas primitives used by the existing paper-template renderer.
class PaperWriter {
  constructor(page, area, pt, lib) {
    Object.assign(this, { page, area, pt, lib, fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, stack: [] });
  }
  color(value) {
    const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
    if (rgba) {
      const [r, g, b, a = 1] = rgba[1].split(',').map(Number);
      return { color: this.lib.rgb(r / 255, g / 255, b / 255), opacity: a };
    }
    let hex = value.replace('#', '');
    if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
    if (!/^[\da-f]{6}$/i.test(hex)) throw new Error('Ungültige Farbe im Dokument');
    return { color: this.lib.rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255), opacity: 1 };
  }
  x(v) { return (v - this.area.x) * this.pt; }
  y(v) { return (this.area.y + this.area.h - v) * this.pt; }
  save() { this.stack.push([this.fillStyle, this.strokeStyle, this.lineWidth]); }
  restore() { [this.fillStyle, this.strokeStyle, this.lineWidth] = this.stack.pop(); }
  beginPath() { this.path = new VectorPath(); }
  moveTo(x, y) { this.path.moveTo(x, y); }
  lineTo(x, y) { this.path.lineTo(x, y); }
  stroke() {
    const { color, opacity } = this.color(this.strokeStyle);
    this.page.drawSvgPath(String(this.path), { x: this.x(0), y: this.y(0), scale: this.pt,
      borderColor: color, borderOpacity: opacity, borderWidth: this.lineWidth });
  }
  fillRect(x, y, w, h) {
    this.page.drawRectangle({ x: this.x(x), y: this.y(y + h), width: w * this.pt, height: h * this.pt, ...this.color(this.fillStyle) });
  }
}

function inverse([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  if (!det) throw new Error('Ungültige PDF-Seitentransformation');
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
// Map our bottom-up export coordinates back into a copied PDF's native coordinates.
function overlayMatrix(view, area, pt) {
  const [a, b, c, d, e, f] = inverse(view.transform), top = area.y + area.h;
  return [a / pt, b / pt, -c / pt, -d / pt, a * area.x + c * top + e, b * area.x + d * top + f];
}

async function fontFor(pdf, cache, style) {
  const family = style.font === 'serif' ? 'NotoSerif' : style.font === 'mono' ? 'NotoSansMono' : 'NotoSans';
  const italic = style.italic && family !== 'NotoSansMono';
  const face = (style.bold ? 'Bold' : '') + (italic ? 'Italic' : '') || 'Regular';
  const name = `${family}-${face}`;
  if (!cache.has(name)) cache.set(name, (async () => {
    const response = await fetch(new URL(`../vendor/pdf/${name}.ttf`, import.meta.url));
    if (!response.ok) throw new Error('PDF-Schrift nicht verfügbar. Folio einmal online öffnen.');
    return pdf.embedFont(await response.arrayBuffer(), { subset: true });
  })());
  return cache.get(name);
}

async function drawText(pdf, writer, text, fonts, measure) {
  for (const line of layout(text, measure).lines) {
    for (const seg of line.segs) {
      if (!seg.text.trim()) continue;
      const font = await fontFor(pdf, fonts, seg.style);
      const supported = new Set(font.getCharacterSet());
      const missing = [...seg.text].find(c => !supported.has(c.codePointAt(0)));
      if (missing) throw new Error(`Das Zeichen „${missing}“ wird von der PDF-Schrift noch nicht unterstützt.`);
      // Keep the editor's line breaks and run widths even when the platform font differs.
      const size = seg.style.size * writer.pt;
      const width = font.widthOfTextAtSize(seg.text, size);
      const x = writer.x(text.x + seg.x), y = writer.y(text.y + line.y + line.size * 0.97);
      const stretch = width > 0 ? seg.w * writer.pt / width : 1;
      const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, degrees } = writer.lib;
      writer.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(stretch, 0, 0, 1, x, y));
      writer.page.drawText(seg.text, { x: 0, y: 0, size, font, ...writer.color(seg.style.color || '#000000'),
        ySkew: degrees(seg.style.font === 'mono' && seg.style.italic ? 12 : 0) });
      writer.page.pushOperators(popGraphicsState());
    }
  }
}

function drawInk(writer, stroke) {
  if (!stroke.points.length) return;
  const path = new VectorPath(), color = writer.color(stroke.color);
  const opts = { x: writer.x(0), y: writer.y(0), scale: writer.pt };
  if (stroke.tool === 'highlighter' || stroke.shape) {
    const p = stroke.points;
    path.moveTo(p[0][0], p[0][1]);
    if (p.length === 1) path.lineTo(p[0][0] + 0.1, p[0][1]);
    for (let i = 1; i < p.length; i++) path.lineTo(p[i][0], p[i][1]);
    if (stroke.closed) path.closePath();
    writer.page.pushOperators(writer.lib.pushGraphicsState(), writer.lib.setLineJoin(1));
    writer.page.drawSvgPath(String(path), { ...opts, borderColor: color.color, borderWidth: stroke.width,
      borderOpacity: stroke.tool === 'highlighter' ? 0.4 : color.opacity,
      borderLineCap: stroke.tool === 'highlighter' ? 0 : 1,
      blendMode: stroke.tool === 'highlighter' ? writer.lib.BlendMode.Multiply : writer.lib.BlendMode.Normal });
    writer.page.pushOperators(writer.lib.popGraphicsState());
  } else {
    addSamplesToPath(path, strokeSamples(stroke.points, strokeRadiusFn(stroke)));
    writer.page.drawSvgPath(String(path), { ...opts, ...color });
  }
}

async function embedImage(pdf, src, cache) {
  if (!cache.has(src)) cache.set(src, (async () => {
    const response = await fetch(src);
    if (!response.ok) throw new Error('Ein Bild ist nicht verfügbar');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return pdf.embedJpg(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return pdf.embedPng(bytes);
    // Older notes can contain WebP/SVG images: convert that image only, never the page.
    const image = await loadImage(src);
    if (!image) throw new Error('Ein Bild konnte nicht geladen werden');
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    try { return await pdf.embedPng(canvas.toDataURL('image/png')); }
    finally { canvas.width = canvas.height = 0; }
  })());
  return cache.get(src);
}
async function drawImage(pdf, writer, image, cache) {
  writer.page.drawImage(await embedImage(pdf, image.src, cache), {
    x: writer.x(image.x), y: writer.y(image.y + image.h), width: image.w * writer.pt, height: image.h * writer.pt,
  });
}

// Returns bytes for download and for regression tests. Does not mutate the notebook.
export async function createPdf(doc, pages = doc.pages, progress = () => {}) {
  if (!pages?.length) throw new Error('Keine Seiten zum Exportieren');
  if (pages.length > MAX_EXPORT_PAGES) throw new Error(`Höchstens ${MAX_EXPORT_PAGES} Seiten auf einmal exportieren.`);
  const lib = await loadLibraries(), pdf = await lib.PDFDocument.create();
  pdf.registerFontkit(window.fontkit);
  pdf.setTitle(doc.name || 'Folio'); pdf.setCreator('Folio'); pdf.setProducer('Folio / pdf-lib');
  const fonts = new Map(), images = new Map(), originals = new Map(), groups = new Map();
  const measure = document.createElement('canvas').getContext('2d');
  for (const p of pages) if (p.pdf) {
    if (!groups.has(p.pdf.file)) groups.set(p.pdf.file, new Set());
    groups.get(p.pdf.file).add(p.pdf.n || 1);
  }
  // Copy each source's selected pages in one batch so shared fonts/images are copied once.
  // Release the parser before moving to the next file; never rasterize a missing original.
  for (const [file, numbers] of groups) {
    progress('Original-PDF wird geladen …');
    const { bytes, views } = await pdfExportSource(file, numbers);
    const source = await lib.PDFDocument.load(bytes);
    const ns = [...numbers];
    const copies = await pdf.copyPages(source, ns.map(n => n - 1)), assigned = new Set();
    for (const [index, model] of pages.entries()) {
      if (model.pdf?.file !== file) continue;
      const n = model.pdf.n || 1;
      const copy = assigned.has(n) ? (await pdf.copyPages(source, [n - 1]))[0] : copies[ns.indexOf(n)];
      assigned.add(n);
      originals.set(index, { page: copy, view: views.get(n) });
    }
  }
  for (const [i, model] of pages.entries()) {
    progress(`PDF wird erstellt: Seite ${i + 1} von ${pages.length}`);
    const area = exportArea(model), pt = Math.min(0.595, 14400 / Math.max(area.w, area.h));
    const original = originals.get(i);
    let page;
    if (original && !model.inf) {
      // Keep original page boxes, rotation, text, vectors and page annotations.
      // Duplicated Folio pages need independent content streams for their annotations.
      page = original.page;
      pdf.addPage(page);
    } else page = pdf.addPage([area.w * pt, area.h * pt]);
    const writer = new PaperWriter(page, area, pt, lib);
    page.pushOperators(lib.pushGraphicsState());
    if (original && !model.inf) page.pushOperators(lib.concatTransformationMatrix(...overlayMatrix(original.view, area, pt)));
    // Clip all Folio additions to the exported area, just like the editor canvas.
    page.pushOperators(lib.rectangle(0, 0, area.w * pt, area.h * pt), lib.clip(), lib.endPath());
    if (!original || model.inf) {
      writer.fillStyle = paperColor(model); writer.fillRect(area.x, area.y, area.w, area.h);
      if (model.bg) await drawImage(pdf, writer, { src: model.bg, x: 0, y: 0, w: PAGE_W, h: pageH(model) }, images);
      if (original) {
        const [left, bottom, right, top] = original.view.box;
        const embedded = await pdf.embedPage(original.page, { left, bottom, right, top }, [1, 0, 0, 1, 0, 0]);
        // Source PDF -> displayed Folio coordinates -> output PDF coordinates.
        const [a, b, c, d, e, f] = original.view.transform;
        page.pushOperators(lib.pushGraphicsState(), lib.concatTransformationMatrix(pt * a, -pt * b, pt * c, -pt * d, writer.x(e), writer.y(f)));
        page.drawPage(embedded); page.pushOperators(lib.popGraphicsState());
      }
    }
    if (model.inf) drawInfiniteTemplate(writer, { ...model, x0: area.x, y0: area.y, w: area.w, h: area.h });
    else drawTemplate(writer, model.template, pageH(model), model.paper === 'dark');
    for (const element of model.elements) {
      if (element.type === 'text') await drawText(pdf, writer, element, fonts, measure);
      else if (element.type === 'stroke') drawInk(writer, element);
      else if (element.type === 'image') await drawImage(pdf, writer, element, images);
    }
    page.pushOperators(lib.popGraphicsState());
    // Yield between pages so Safari can update progress and handle input.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return pdf.save();
}
