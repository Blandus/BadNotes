import { PenInput } from './handwriting.js';
import { $, h, uid, clamp, debounce, pickFile, onContext } from './util.js';
import { icon } from './icons.js';
import { store, settings, saveSettings, bus, PAGE_W, newPage, TEMPLATES } from './store.js';
import { renderPage, renderThumb, pageH, pageW, pageX0, pageY0, fitInfinite, drawStroke, FONTS, fontFamily } from './render.js';
import { menu, popover, sheet, toast, segmented, closePopover, promptText, toggle } from './ui.js';
import { exportPdf, exportPng, loadImageFile } from './pdf.js';
import { suggestNames } from './suggest.js';
import { renderLibrary, templatePicker, openSettings, showConflicts } from './library.js';
import { clearSelection, renderSelection, finishText, selectIds, hasSelection, deleteSelection } from './tools.js';
import { addPageMenu as openAddPage } from './addpage.js';
import { ensureLocal } from './offload.js';

// Page canvases only need to look fine while scrolling; the detail layer provides sharpness.
// Keeping them smaller saves iPad memory and makes each re-render faster.
const MAX_CANVAS_PX = 6e6;
const MAX_ZOOM = 10;

// ---------- Tool configuration (per device) ----------
const DEFAULT_TOOLS = {
  pen: {
    pen: 'fountain', colors: ['#0F2747', '#2F6DB5', '#4F7A66'], color: 0, widths: [1.5, 3, 5], width: 1,
    sharp: 0.5, press: 0.5, stab: 0, // tip sharpness, pressure sensitivity, stroke stabilisation (0..1)
    drawHold: true, scribble: true, scribbleAll: true, circleLasso: true,
  },
  highlighter: { colors: ['#FFE14D', '#7CE38B', '#FF8AD0'], color: 0, widths: [12, 20, 30], width: 1, straight: false },
  shapes: { colors: ['#0F2747', '#2F6DB5', '#4F7A66'], color: 0, widths: [1.5, 3, 5], width: 1 },
  eraser: { sizes: [6, 14, 30], size: 1, mode: 'precise', hlOnly: false },
  lasso: { strokes: true, images: true, text: true },
  text: { colors: ['#0F2747', '#2F6DB5', '#4F7A66'], color: 0, size: 24 },
  laser: { colors: ['#2F6DB5', '#4F7A66', '#E8A23B'], color: 0 },
};
const saved = settings.tools || {};
export const T = Object.fromEntries(Object.entries(DEFAULT_TOOLS).map(([k, v]) => [k, { ...v, ...(saved[k] || {}) }]));
T.presets = saved.presets || [];
settings.tools = T;
export const saveTools = debounce(saveSettings, 300);

// Tools, shown in the tool row in these groups (drawing · content · presentation)
const TOOL_GROUPS = [['pen', 'highlighter', 'eraser', 'lasso', 'shapes'], ['text', 'image'], ['laser', 'screenshot']];
const TOOLS = [
  ['pen', 'Stift', 'pen'], ['eraser', 'Radierer', 'eraser'], ['highlighter', 'Textmarker', 'highlighter'],
  ['text', 'Text', 'text'], ['shapes', 'Formen', 'shapes'], ['image', 'Bild', 'image'],
  ['laser', 'Laserpointer', 'laser'], ['screenshot', 'Screenshot', 'screenshot'],
];
// Colour palettes for the colour picker (switchable; the choice is saved per device).
// PALETTE is the active one — updated in place so other modules (lasso recolour) see the switch.
export const PALETTES = {
  standard: ['Standard', ['#000000', '#4A4A4A', '#8E8E93', '#FFFFFF', '#1F4FD1', '#2E8BFF', '#36B7E8', '#1F8A4C', '#5BC236', '#F2C200',
    '#FF9500', '#D12F2F', '#FF2D55', '#AF52DE', '#8E5A2B', '#FFE14D', '#7CE38B', '#8FD3FF', '#FF8AD0', '#FFB86B']],
  pastel: ['Pastell', ['#F4A6A6', '#F7C59F', '#F9E2A0', '#D8EDA0', '#AEE2C3', '#9FDDD6', '#A6D8EE', '#B5C8F2', '#C5B9EF', '#E2B6EA',
    '#F5B8D2', '#E8D5C4', '#CFC6BD', '#B8C4CC', '#FFD6D6', '#FFE6C7', '#FFF4C2', '#DDF5D0', '#D4ECFA', '#EBDDF8']],
  folio: ['Folio', ['#0F2747', '#1F3A5F', '#3E6E9F', '#5E7F9F', '#8EB8E6', '#4F7A66', '#6B8F7E', '#9DB5A6', '#A7B4C6', '#3A3F4A',
    '#D9D2C6', '#B8A68A', '#C9A35B', '#E3C9A0', '#7D6B91', '#B6A6C9', '#E8E3D8', '#FAF9F5', '#FFFFFF', '#000000']],
  vivid: ['Kräftig', ['#000000', '#E60026', '#FF4D00', '#FF8C00', '#FFC400', '#B5D800', '#00B140', '#00B3A4', '#00A3E0', '#0066FF',
    '#3D2BFF', '#7A1FFF', '#B000E6', '#FF00A8', '#FF3D7F', '#8B4513', '#5C3A21', '#808080', '#C0C0C0', '#FFFFFF']],
  gray: ['Graustufen', ['#000000', '#1C1C1E', '#2C2C2E', '#3A3A3C', '#48484A', '#545456', '#636366', '#7C7C80', '#8E8E93', '#A1A1A6',
    '#AEAEB2', '#BCBCC0', '#C7C7CC', '#D1D1D6', '#DCDCE0', '#E5E5EA', '#EDEDF0', '#F2F2F7', '#F9F9FB', '#FFFFFF']],
};
export const PALETTE = [...(PALETTES[settings.palette] || PALETTES.standard)[1]];
function usePalette(key) {
  settings.palette = key; saveSettings();
  PALETTE.splice(0, PALETTE.length, ...PALETTES[key][1]);
}

// ---------- Editor state ----------
export const ed = {
  doc: null, tool: settings.tool || 'pen', zoom: 1,
  // older versions stored tabs as plain document ids
  tabs: (settings.tabs || []).map(t => (typeof t === 'string' ? { key: uid(), id: t, view: null } : t)),
  tab: null,
  sel: null, editing: null, busy: false, pageEls: [], cur: 0,
  hist: new Map(),
};
// restore the active tab key (older versions stored the document id instead)
ed.tab = (ed.tabs.find(t => t.key === settings.activeTab) || ed.tabs.find(t => t.id === settings.activeTab))?.key || null;
if (ed.tool === 'image') ed.tool = 'pen';
export const sc = $('#scroller');
const visible = new Set();
const view = $('#editor');

// ---------- Tabs ----------
// A tab is a view of a document: { key, id, view: { zoom, top, left, page } }. The same
// document can be open in several tabs (e.g. exercise in one, solution further back in
// another); they share the document itself, each keeps its own position.
const tabOf = key => ed.tabs.find(t => t.key === key);
const tabNames = new Map();
function persistTabs() { settings.tabs = ed.tabs; settings.activeTab = view.hidden ? null : ed.tab; saveSettings(); }

// Opens a document. Re-uses a tab already showing it unless newTab is set; page = page index to show.
export async function openDoc(id, { newTab = false, page } = {}) {
  let tab = !newTab && (ed.tabs.find(t => t.key === ed.tab && t.id === id) || ed.tabs.find(t => t.id === id));
  if (!tab) {
    saveView();
    const cur = tabOf(ed.tab);
    tab = { key: uid(), id, view: newTab && cur?.id === id ? { ...cur.view } : null };
    const at = cur ? ed.tabs.indexOf(cur) + 1 : ed.tabs.length;
    ed.tabs.splice(at, 0, tab);
  }
  return activateTab(tab.key, page);
}

export async function activateTab(key, page) {
  const tab = tabOf(key);
  if (!tab) return;
  await finishText();
  await flushSave();
  saveView();
  const same = !view.hidden && ed.doc?.id === tab.id;
  let doc = same ? ed.doc : await store.get(tab.id);
  if (doc?.offloaded) { // kept only in Google Drive: load it first
    doc = await ensureLocal(doc);
    if (!doc) { ed.tabs = ed.tabs.filter(t => t.id !== tab.id); persistTabs(); if (view.hidden) renderLibrary(); return; }
  }
  if (!doc || doc.deleted || doc.trashed) {
    ed.tabs = ed.tabs.filter(t => t.id !== tab.id); persistTabs();
    return toast('Dokument nicht gefunden');
  }
  ed.tab = key;
  $('#library').hidden = true; view.hidden = false;
  persistTabs();
  if (!same) {
    doc.opened = Date.now();
    store.put(doc);
    ed.doc = doc;
    buildPages();
  }
  clearSelection();
  restoreView(tab, page);
  renderTabs(); renderThumbs(); updateChrome(); renderOptions();
}

export async function showLibrary() {
  await finishText();
  await flushSave();
  saveView();
  ed.doc = null;
  clearSelection(); closePopover();
  observer.disconnect(); visible.clear();
  $('#pages').replaceChildren();
  view.hidden = true; $('#library').hidden = false;
  persistTabs();
  renderLibrary();
}

function closeTab(key) {
  const i = ed.tabs.findIndex(t => t.key === key);
  if (i < 0) return;
  ed.tabs.splice(i, 1);
  persistTabs();
  if (key === ed.tab) {
    const next = ed.tabs[i] || ed.tabs[i - 1];
    next ? activateTab(next.key) : showLibrary();
  } else renderTabs();
}
const closeDocTabs = id => { for (const t of ed.tabs.filter(t => t.id === id)) closeTab(t.key); };

function saveView() {
  const t = tabOf(ed.tab);
  if (!t || !ed.doc || t.id !== ed.doc.id || view.hidden) return;
  t.view = { zoom: ed.zoom, top: sc.scrollTop, left: sc.scrollLeft, page: ed.cur };
  persistTabs();
}
function restoreView(tab, page) {
  const v = tab.view || { zoom: 1, top: 0, left: 0 };
  ed.zoom = v.zoom; applyZoom(); updateZoomLabel();
  sc.scrollTop = v.top; sc.scrollLeft = v.left;
  if (page != null) scrollToPage(page);
  refreshDetails(true);
  updateCurrent();
}

async function renderTabs() {
  for (const id of new Set(ed.tabs.map(t => t.id))) {
    if (id === ed.doc?.id) { tabNames.set(id, ed.doc.name); continue; }
    const r = await store.get(id);
    if (!r || r.deleted || r.trashed) ed.tabs = ed.tabs.filter(t => t.id !== id);
    else tabNames.set(id, r.name);
  }
  $('#tabs').replaceChildren(...ed.tabs.map(t => h('div', { class: 'tab' + (t.key === ed.tab ? ' active' : ''), 'data-key': t.key },
    h('button', { class: 'tab-title', onclick: () => t.key !== ed.tab && activateTab(t.key) }),
    h('button', { class: 'tab-close', title: 'Tab schließen', onclick: () => closeTab(t.key) }, icon('close', 14)))));
  updateTabLabels();
  // Tabs only appear once more than one tab is open (the web app has none).
  $('#tabbar').hidden = ed.tabs.length < 2;
  if (ed.doc) {
    $('#docTitleText').textContent = ed.doc.name;
    // breadcrumb: the folder the document lives in
    const folder = ed.doc.parent && await store.get(ed.doc.parent);
    $('#docCrumb').textContent = folder && !folder.deleted ? folder.name : '';
  }
}
// Tab titles; when a document is open in several tabs, each shows its page number.
function updateTabLabels() {
  for (const el of document.querySelectorAll('#tabs .tab')) {
    const t = tabOf(el.dataset.key);
    if (!t) continue;
    const name = tabNames.get(t.id) || '';
    const page = (t.key === ed.tab ? ed.cur : t.view?.page ?? 0) + 1;
    const label = ed.tabs.filter(x => x.id === t.id).length > 1 ? `${name} · S. ${page}` : name;
    const btn = el.querySelector('.tab-title');
    if (btn.textContent !== label) { btn.textContent = label; btn.title = label; }
  }
}

// Remote (sync) updates to the open document
bus.addEventListener('remote', async e => {
  if (!ed.doc || e.detail !== ed.doc.id) return;
  const doc = await store.get(ed.doc.id);
  if (!doc || doc.deleted || doc.trashed) return closeDocTabs(e.detail);
  const top = sc.scrollTop;
  ed.doc = doc; ed.hist.delete(doc.id);
  clearSelection();
  buildPages(); sc.scrollTop = top;
  renderTabs(); renderThumbs(); updateChrome();
});

// ---------- Saving ----------
let saveT = null;
export function changed() {
  ed.doc.updated = Date.now();
  clearTimeout(saveT);
  // Saving clones the document on the main thread: never while a stroke is being drawn.
  saveT = setTimeout(function later() { if (ed.busy) saveT = setTimeout(later, 300); else flushSave(); }, 600);
}
export async function flushSave() {
  if (saveT === null) return;
  clearTimeout(saveT); saveT = null;
  if (ed.doc) await store.put(ed.doc);
}
export const isLocked = id => ed.doc?.id === id && (ed.busy || saveT !== null || !!ed.editing);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });

// ---------- History (snapshots of a page's element list, or of the page list) ----------
function hist() {
  let hs = ed.hist.get(ed.doc.id);
  if (!hs) ed.hist.set(ed.doc.id, hs = { undo: [], redo: [] });
  return hs;
}
export function commit(page, next) {
  if (next === page.elements) return;
  hist().undo.push({ pageId: page.id, before: page.elements, after: next });
  hist().redo = [];
  const prev = page.elements;
  page.elements = next;
  const grown = growInfinite(page);
  // Strokes added on top (the usual case while writing) are painted onto the page's existing
  // canvases instead of re-rendering the whole page: same pixels, a fraction of the work, and
  // the main thread is free again for the next pen-down right away.
  const added = !grown && next.length > prev.length && prev.every((e, i) => next[i] === e) ? next.slice(prev.length) : null;
  const done = refreshPage(page, added);
  changed(); updateChrome();
  return done;
}
export function commitPages(next) {
  hist().undo.push({ pages: true, before: ed.doc.pages, after: next });
  hist().redo = [];
  ed.doc.pages = next;
  clearSelection();
  buildPages(); renderThumbs(); changed(); updateChrome();
}
function applyHist(op, back) {
  const v = back ? op.before : op.after;
  clearSelection();
  if (op.pages) { ed.doc.pages = v; buildPages(); renderThumbs(); }
  else {
    const page = ed.doc.pages.find(p => p.id === op.pageId);
    if (!page) return;
    page.elements = v; refreshPage(page);
    scrollToPage(ed.doc.pages.indexOf(page), true);
  }
  changed(); updateChrome();
}
export async function undo() { await finishText(); const op = hist().undo.pop(); if (op) { hist().redo.push(op); applyHist(op, true); } }
export async function redo() { await finishText(); const op = hist().redo.pop(); if (op) { hist().undo.push(op); applyHist(op, false); } }

// ---------- Pages ----------
const observer = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting) { visible.add(e.target); renderEl(e.target); }
    else {
      visible.delete(e.target);
      e.target._canvas.width = 0; e.target._canvas.height = 0;
      e.target._detail.hidden = true; e.target._detail.width = 0;
    }
  }
}, { root: sc, rootMargin: '300px 0px' });

export async function renderEl(el) {
  visible.add(el);
  const c = el._canvas, page = el._page, ph = pageH(page);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pw = pageW(page), scale = Math.min(el.clientWidth * dpr / pw, Math.sqrt(MAX_CANVAS_PX / (pw * ph)));
  const w = Math.round(pw * scale), hh = Math.round(ph * scale);
  // Draw offscreen, then swap in one go to avoid flicker.
  const off = document.createElement('canvas'); off.width = w; off.height = hh;
  await renderPage(off.getContext('2d'), page, scale, hideIdFor(page));
  if (el._page !== page) return;
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(off, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  c._xf = { scale, ox: 0, oy: 0, box: pageBox(page) };
  await renderDetail(el);
}
const pageBox = page => [pageX0(page), pageY0(page), pageW(page), pageH(page)].join();

// Paints strokes that were appended to a page onto its page canvas and sharp detail layer, with
// the transform each was rendered with (renderPage draws elements in order, so drawing the new
// ones last gives the same pixels as a full render). A render still in flight reads the page's
// elements only when it draws them, so it includes the new strokes too. Returns false when the
// canvases can't be reused (not rendered yet, resized, zoomed) — then the page is re-rendered.
function paintAppended(el, added) {
  const page = el._page, c = el._canvas, box = pageBox(page);
  if (!added.every(e => e.type === 'stroke') || !c._xf || c._xf.box !== box || !c.width) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 3), pw = pageW(page);
  if (Math.abs(Math.min(el.clientWidth * dpr / pw, Math.sqrt(MAX_CANVAS_PX / (pw * pageH(page)))) - c._xf.scale) > 1e-6) return false;
  const paint = (cv, { scale: k, ox, oy }) => {
    const ctx = cv.getContext('2d');
    ctx.setTransform(k, 0, 0, k, ox - pageX0(page) * k, oy - pageY0(page) * k);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    for (const e of added) drawStroke(ctx, e);
  };
  paint(c, c._xf);
  // The detail layer maps page units to its pixels independently of scroll and zoom (it is
  // placed in % of the page), so it can always take the new strokes while it shows content.
  const det = el._detail;
  if (det && !det.hidden && det._xf?.box === box) paint(det, det._xf);
  return true;
}

// ---------- Sharp detail layer ----------
// The page canvas above has a capped resolution (memory), so it gets soft when zoomed in.
// On top of it, each visible page gets a "detail" canvas covering its on-screen part plus a
// margin, rendered at exact device resolution — sharp at any zoom, like Goodnotes. It is placed
// in % of the page, so it moves and scales with the page: while scrolling or pinching it stays
// in place (sharp for short scrolls, scaled while zooming) and is redrawn once movement stops.
// not drawn on the page: the text box being edited, a selection lifted off the page while dragged (tools.js)
const hideIdFor = page => ed.lift?.page === page ? ed.lift.ids : ed.editing?.page === page ? ed.editing.id : null;
const DETAIL_MARGIN = 0.2; // of the viewport, on every side
const DETAIL_MAX_PX = 12e6; // device pixels per page (≈48 MB) — iPad Safari limits canvas memory
async function renderDetail(el) {
  const det = el._detail;
  if (!det || !visible.has(el)) return;
  const token = el._detailToken = (el._detailToken || 0) + 1;
  const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  let m = DETAIL_MARGIN, x0, y0, x1, y1;
  for (;;) {
    x0 = Math.max(r.left, s.left - s.width * m); y0 = Math.max(r.top, s.top - s.height * m);
    x1 = Math.min(r.right, s.right + s.width * m); y1 = Math.min(r.bottom, s.bottom + s.height * m);
    if (m === 0 || (x1 - x0) * (y1 - y0) * dpr * dpr <= DETAIL_MAX_PX) break;
    m = m > 0.02 ? m / 2 : 0;
  }
  if (x1 <= x0 || y1 <= y0 || !r.width) { det.hidden = true; return; }
  const k = r.width / pageW(el._page) * dpr;
  const off = document.createElement('canvas');
  off.width = Math.round((x1 - x0) * dpr); off.height = Math.round((y1 - y0) * dpr);
  await renderPage(off.getContext('2d'), el._page, k, hideIdFor(el._page), -(x0 - r.left) * dpr, -(y0 - r.top) * dpr);
  if (token !== el._detailToken) return; // superseded, or scrolled/zoomed meanwhile
  det.width = off.width; det.height = off.height;
  det.getContext('2d').drawImage(off, 0, 0);
  det._xf = { scale: k, ox: -(x0 - r.left) * dpr, oy: -(y0 - r.top) * dpr, box: pageBox(el._page) };
  const pct = v => v * 100 + '%';
  Object.assign(det.style, { left: pct((x0 - r.left) / r.width), top: pct((y0 - r.top) / r.height), width: pct((x1 - x0) / r.width), height: pct((y1 - y0) / r.height) });
  det.hidden = false;
}
let detailT;
// After scrolling or zooming: redraw the detail layers once movement stops. They stay visible
// meanwhile (hide = true only when they may show something else, e.g. another view of the tab).
// schedule = false when a full re-render (which includes the details) follows anyway.
function refreshDetails(hide = false, schedule = true) {
  // Bumping the token also discards any detail render still in flight.
  ed.pageEls.forEach(el => { if (el._detail) { if (hide) el._detail.hidden = true; el._detailToken = (el._detailToken || 0) + 1; } });
  clearTimeout(detailT);
  if (schedule) detailT = setTimeout(() => visible.forEach(renderDetail), 140);
}
// Redraws only an area of a page (page units) on its page canvas and sharp detail layer: much
// cheaper than a full render (used while erasing). Repaints of a page run one after another, as
// they draw onto the live canvases; areas requested meanwhile are merged into the next one.
export function repaintArea(el, a) {
  const c = el._canvas, box = pageBox(el._page);
  if (!visible.has(el) || !c._xf || c._xf.box !== box || !c.width) return renderEl(el);
  const d = el._dirty;
  el._dirty = d ? { x: Math.min(d.x, a.x), y: Math.min(d.y, a.y), w: Math.max(d.x + d.w, a.x + a.w) - Math.min(d.x, a.x), h: Math.max(d.y + d.h, a.y + a.h) - Math.min(d.y, a.y) } : a;
  el._repaint ||= (async () => {
    while (el._dirty) {
      const area = el._dirty, page = el._page, det = el._detail;
      el._dirty = null;
      await renderPage(c.getContext('2d'), page, c._xf.scale, hideIdFor(page), c._xf.ox, c._xf.oy, area);
      if (det && !det.hidden && det.width && det._xf?.box === box) await renderPage(det.getContext('2d'), page, det._xf.scale, hideIdFor(page), det._xf.ox, det._xf.oy, area);
    }
    el._repaint = null;
  })();
  return el._repaint;
}
export const elForPage = page => ed.pageEls.find(el => el._page === page);
export function refreshPage(page, added = null) {
  const el = elForPage(page);
  const done = el && visible.has(el) ? (added && paintAppended(el, added) ? Promise.resolve() : renderEl(el)) : Promise.resolve();
  scheduleThumb(page);
  if (ed.sel?.page === page) renderSelection();
  return done;
}
const rerenderVisible = () => visible.forEach(renderEl);

function baseWidth() { return Math.min(sc.clientWidth - 32, 860); }
function applyZoom() { $('#pages').style.setProperty('--pw', Math.round(baseWidth() * ed.zoom) + 'px'); }

let zoomT;
const updateZoomLabel = () => { $('#zoomLabel').textContent = Math.round(ed.zoom * 100) + ' %'; };
export function setZoom(z, cx, cy) {
  // infinite pages can be zoomed out further; up to 1000 % for fine detail (the detail layer
  // renders only the visible part, so a high zoom costs no extra memory)
  z = clamp(z, ed.doc?.pages.some(p => p.inf) ? 0.2 : 0.5, MAX_ZOOM);
  if (Math.abs(z - ed.zoom) < 0.001) return;
  const r = sc.getBoundingClientRect();
  cx ??= r.left + r.width / 2; cy ??= r.top + r.height / 2;
  const ox = cx - r.left + sc.scrollLeft, oy = cy - r.top + sc.scrollTop;
  const k = z / ed.zoom;
  ed.zoom = z; applyZoom();
  sc.scrollLeft = ox * k - (cx - r.left);
  sc.scrollTop = oy * k - (cy - r.top);
  updateZoomLabel();
  refreshDetails(false, false);
  clearTimeout(zoomT); zoomT = setTimeout(() => { zoomT = null; rerenderVisible(); renderSelection(); }, 160);
  repositionText();
}

// Page box: aspect ratio, and for infinite pages a width relative to the normal page width (--pw)
function sizePageEl(el, page) {
  el.style.aspectRatio = `${pageW(page)} / ${pageH(page)}`;
  el.style.width = page.inf ? `calc(var(--pw) * ${pageW(page) / PAGE_W})` : '';
}
// Infinite page: grow it with its content; the view stays where it was (the page may grow left/up).
function growInfinite(page) {
  const el = elForPage(page);
  const before = el?.getBoundingClientRect(), k = el ? el.clientWidth / pageW(page) : 0;
  const moved = fitInfinite(page);
  if (!moved || !el) return !!moved;
  sizePageEl(el, page);
  const after = el.getBoundingClientRect();
  sc.scrollLeft += after.left + moved.dx * k - before.left;
  sc.scrollTop += after.top + moved.dy * k - before.top;
  return true;
}

export function buildPages() {
  observer.disconnect(); visible.clear();
  applyZoom();
  ed.pageEls = ed.doc.pages.map(page => {
    const el = h('div', { class: 'page' });
    sizePageEl(el, page);
    const c = h('canvas'), det = h('canvas', { class: 'page-detail', hidden: true });
    el.append(c, det);
    if (page.bookmark) el.append(h('div', { class: 'page-bm' }, icon('bookmarkFill', 20)));
    el._page = page; el._canvas = c; el._detail = det;
    observer.observe(el);
    return el;
  });
  $('#pages').replaceChildren(...ed.pageEls);
  ed.cur = Math.min(ed.cur, ed.pageEls.length - 1);
  if (ed.sel) renderSelection();
}

export function scrollToPage(i, onlyIfHidden = false) {
  const el = ed.pageEls[i];
  if (!el) return;
  if (onlyIfHidden) {
    const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    if (r.bottom > s.top && r.top < s.bottom) return;
  }
  sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 12;
}

export const currentPage = () => ed.doc.pages[ed.cur];

function updateCurrent() {
  if (!ed.doc) return;
  const s = sc.getBoundingClientRect(), probe = s.top + s.height * 0.35;
  let best = 0, bestD = Infinity;
  // only pages near the viewport (runs on every scroll event; long documents have hundreds)
  const near = visible.size ? ed.pageEls.filter(el => visible.has(el)) : ed.pageEls;
  near.forEach(el => {
    const i = ed.pageEls.indexOf(el), r = el.getBoundingClientRect();
    const d = probe < r.top ? r.top - probe : probe > r.bottom ? probe - r.bottom : 0;
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best !== ed.cur) { ed.cur = best; highlightThumb(); updateTabLabels(); }
  updateBookmarkBtn();
  const ind = `${ed.cur + 1} von ${ed.doc.pages.length}`, pi = $('#pageInd');
  if (pi.textContent !== ind) pi.textContent = ind;
}
// (while a zoom's re-render is pending, that re-render redraws the details anyway)
sc.addEventListener('scroll', () => { updateCurrent(); repositionText(); refreshDetails(false, !zoomT); });

let resizeT;
window.addEventListener('resize', () => {
  if (!ed.doc) return;
  applyZoom(); repositionText();
  clearTimeout(resizeT); resizeT = setTimeout(() => { rerenderVisible(); renderSelection(); }, 200);
});

// Keeps an open text editor aligned after zoom/scroll (implemented in tools.js via event)
function repositionText() { if (ed.editing) ed.editing.place(); }

// ---------- Page operations ----------
function insertPages(pages, at) {
  const next = ed.doc.pages.slice();
  next.splice(at, 0, ...pages);
  commitPages(next);
  requestAnimationFrame(() => scrollToPage(at));
  setTimeout(() => scrollToPage(at), 50);
}
export function deletePage(i) {
  if (ed.doc.pages.length === 1) return toast('Die letzte Seite kann nicht gelöscht werden');
  commitPages(ed.doc.pages.filter((_, j) => j !== i));
  toast('Seite gelöscht – rückgängig mit ↶');
}
function duplicatePage(i) {
  const p = structuredClone(ed.doc.pages[i]);
  p.id = uid(); p.bookmark = false;
  for (const e of p.elements) e.id = uid();
  insertPages([p], i + 1);
}
function replacePage(i, patch) {
  const next = ed.doc.pages.slice();
  next[i] = { ...next[i], ...patch };
  commitPages(next);
}
function toggleBookmark(i = ed.cur) { replacePage(i, { bookmark: !ed.doc.pages[i].bookmark }); }
function clearPage(i = ed.cur) { if (ed.doc.pages[i].elements.length) commit(ed.doc.pages[i], []); }

async function changeTemplate(i = ed.cur) {
  const page = ed.doc.pages[i];
  let tmpl = page.template || 'blank', scope = 'page';
  const body = h('div', { class: 'form' },
    segmented([['page', 'Diese Seite'], ['all', 'Alle Seiten']], scope, v => { scope = v; }),
    templatePicker(tmpl, v => { tmpl = v; }, pageH(page)));
  if (!await sheet({ title: 'Papiervorlage', body, className: 'wide' })) return;
  commitPages(ed.doc.pages.map((p, j) => (scope === 'all' || j === i) ? { ...p, template: tmpl } : p));
}

// "Seite hinzufügen" window: see addpage.js
function addPageMenu(anchor) {
  return openAddPage(anchor, { doc: ed.doc, cur: ed.cur, insert: (pages, at) => insertPages(pages, at) });
}

export async function insertImage() {
  const f = await pickFile('image/*');
  if (!f || !ed.doc) return;
  const img = await loadImageFile(f);
  const page = currentPage(), el = ed.pageEls[ed.cur], ph = pageH(page);
  const w = Math.min(500, img.w), hh = w * img.h / img.w;
  // Place in the middle of the visible part of the page.
  const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
  const midY = ((Math.max(r.top, s.top) + Math.min(r.bottom, s.bottom)) / 2 - r.top) / r.height * ph;
  let x = (PAGE_W - w) / 2, y = clamp(midY - hh / 2, 0, Math.max(0, ph - hh));
  if (page.inf) { // infinite page: the middle of the visible area
    const midX = ((Math.max(r.left, s.left) + Math.min(r.right, s.right)) / 2 - r.left) / r.width * pageW(page);
    x = pageX0(page) + midX - w / 2; y = pageY0(page) + midY - hh / 2;
  }
  const e = { id: uid(), type: 'image', src: img.src, x, y, w, h: hh };
  commit(page, [...page.elements, e]);
  selectTool('lasso');
  selectIds(page, [e.id]);
}

// ---------- Thumbnails sidebar ----------
const thumbsEl = $('#thumbs');
const thumbObserver = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting && !e.target._done) {
    e.target._done = true;
    const page = ed.doc?.pages.find(p => p.id === e.target.dataset.pid);
    if (page) renderThumb(e.target, page, 220);
  }
}, { root: thumbsEl, rootMargin: '300px' });

let thumbFilter = 'all';
export function renderThumbs() {
  thumbsEl.hidden = !settings.thumbsOpen;
  $('#btnThumbs')?.classList.toggle('active', !!settings.thumbsOpen);
  if (!settings.thumbsOpen || !ed.doc) return;
  thumbObserver.disconnect();
  const items = ed.doc.pages.map((p, i) => [p, i]).filter(([p]) => thumbFilter === 'all' || p.bookmark).map(([p, i]) => {
    const c = h('canvas', { 'data-pid': p.id, style: { aspectRatio: p.inf ? `${PAGE_W} / 1414` : `${PAGE_W} / ${pageH(p)}` } });
    thumbObserver.observe(c);
    const item = h('button', { class: 'thumb-item' + (i === ed.cur ? ' active' : ''), 'data-i': i, onclick: () => scrollToPage(i) },
      h('div', { class: 'thumb-frame' }, c, p.bookmark ? h('span', { class: 'thumb-bm' }, icon('bookmarkFill', 14)) : null),
      h('span', { class: 'thumb-num' }, i + 1));
    onContext(item, (x, y) => pageMenu(i, { x, y }));
    return item;
  });
  thumbsEl.replaceChildren(
    h('div', { class: 'thumbs-head' }, segmented([['all', 'Alle Seiten'], ['bm', 'Lesezeichen']], thumbFilter, v => { thumbFilter = v; renderThumbs(); })),
    h('div', { class: 'thumbs-list' }, items.length ? items : h('div', { class: 'empty small' }, 'Keine Lesezeichen')));
}
function highlightThumb() {
  thumbsEl.querySelectorAll('.thumb-item').forEach(b => {
    const on = +b.dataset.i === ed.cur;
    b.classList.toggle('active', on);
    if (on) b.scrollIntoView({ block: 'nearest' });
  });
}
const thumbTimers = new Map();
function scheduleThumb(page) {
  clearTimeout(thumbTimers.get(page.id));
  thumbTimers.set(page.id, setTimeout(() => {
    if (ed.busy) return scheduleThumb(page); // not while the pen is down
    const c = thumbsEl.querySelector(`canvas[data-pid="${page.id}"]`);
    if (c) renderThumb(c, page, 220);
  }, 500));
}

function pageMenu(i, anchor) {
  const p = ed.doc.pages[i];
  menu(anchor, [
    { label: 'In neuem Tab öffnen', icon: 'copy', action: () => openDoc(ed.doc.id, { newTab: true, page: i }) },
    { label: p.bookmark ? 'Lesezeichen entfernen' : 'Lesezeichen setzen', icon: p.bookmark ? 'bookmarkFill' : 'bookmark', action: () => toggleBookmark(i) },
    { label: 'Seite duplizieren', icon: 'copy', action: () => duplicatePage(i) },
    { label: 'Papiervorlage ändern', icon: 'doc', action: () => changeTemplate(i) },
    { label: 'Seite leeren', icon: 'eraser', action: () => clearPage(i) },
    '-',
    { label: 'Seite löschen', icon: 'trash', danger: true, action: () => deletePage(i) },
  ]);
}

// ---------- Search panel ----------
const searchEl = $('#searchPanel');
export function toggleSearch(open = searchEl.hidden) {
  searchEl.hidden = !open;
  $('#btnSearch').classList.toggle('active', open);
  if (!open) return;
  const results = h('div', { class: 'search-results' });
  const input = h('input', {
    class: 'searchfield', type: 'search', placeholder: 'In Dokument suchen',
    oninput: () => {
      const q = input.value.trim().toLowerCase();
      if (!q) return results.replaceChildren();
      const hits = [];
      ed.doc.pages.forEach((p, i) => p.elements.forEach(e => {
        if (e.type !== 'text') return;
        const idx = e.text.toLowerCase().indexOf(q);
        if (idx >= 0) hits.push({ i, e, snippet: e.text.slice(Math.max(0, idx - 30), idx + q.length + 40) });
      }));
      results.replaceChildren(...(hits.length ? hits.map(r => h('button', {
        class: 'search-hit', onclick: () => { scrollToPage(r.i); selectTool('lasso'); selectIds(ed.doc.pages[r.i], [r.e.id]); },
      }, h('div', { class: 'hit-page' }, `Seite ${r.i + 1}`), h('div', { class: 'hit-text' }, r.snippet))) : [h('div', { class: 'empty small' }, 'Keine Treffer')]));
    },
  });
  searchEl.replaceChildren(
    h('div', { class: 'panel-head' }, input, h('button', { class: 'iconbtn', title: 'Schließen', onclick: () => toggleSearch(false) }, icon('close', 18))),
    h('div', { class: 'hint pad' }, 'Durchsucht Textfelder. Handschrift wird nicht erkannt.'),
    results);
  input.focus();
}

// ---------- Toolbar ----------
function tb(id, ic, title, onclick, size = 20) { return h('button', { class: 'barbtn', id, title, 'aria-label': title, onclick }, icon(ic, size)); }
const toolBtn = ([id, label, ic]) => h('button', {
  class: 'toolbtn', 'data-tool': id, title: label, 'aria-label': label, onclick: () => selectTool(id),
}, h('span', {}, icon(ic, 22)));

function exportMenu(anchor) {
  menu(anchor, [
    { label: 'Dokument als PDF', icon: 'pdf', action: () => exportPdf(ed.doc) },
    { label: 'Aktuelle Seite als PDF', icon: 'doc', action: () => exportPdf(ed.doc, [currentPage()]) },
    { label: 'Aktuelle Seite als Bild', icon: 'image', action: () => exportPng(ed.doc, currentPage(), ed.cur) },
    '-',
    { label: 'Als Goodnotes-Datei (Beta)', icon: 'doc', action: async () => { await flushSave(); (await import('./goodnotes-export.js')).exportGoodnotes(ed.doc); } },
  ]);
}

function buildToolbar() {
  $('#tbLeft').append(
    tb('btnHome', 'chevronLeft', 'Bibliothek', showLibrary, 22),
    h('button', {
      class: 'doc-title', id: 'docTitle', title: 'Dokument',
      onclick: e => menu(e.currentTarget, [
        { label: 'In neuem Tab öffnen', icon: 'copy', action: () => openDoc(ed.doc.id, { newTab: true }) },
        { label: 'Umbenennen', icon: 'rename', action: renameDoc },
        { label: 'Papiervorlage ändern', icon: 'doc', action: () => changeTemplate() },
        { label: 'Exportieren', icon: 'share', action: () => exportMenu($('#btnShare')) },
        '-',
        { label: 'Zur Bibliothek', icon: 'library', action: showLibrary },
      ]),
    }, h('span', { id: 'docCrumb', class: 'crumb' }), h('span', { id: 'docTitleText' }), icon('chevronDown', 14)),
    tb('btnThumbs', 'sidebar', 'Seitenübersicht', () => { settings.thumbsOpen = !settings.thumbsOpen; saveSettings(); renderThumbs(); setTimeout(() => { applyZoom(); rerenderVisible(); }, 0); }),
    tb('btnSearch', 'search', 'Suchen', () => toggleSearch()),
    tb('btnBookmark', 'bookmark', 'Lesezeichen', () => toggleBookmark()));
  // Folio tool row: drawing · content · presentation
  const byTool = Object.fromEntries([...TOOLS, ['lasso', 'Lasso', 'lasso']].map(t => [t[0], t]));
  $('#tbTools').append(...TOOL_GROUPS.flatMap((g, i) => [i ? h('div', { class: 'tool-sep' }) : null, ...g.map(id => toolBtn(byTool[id]))]).filter(Boolean));
  $('#undoPill').append(
    h('button', { id: 'btnUndo', title: 'Rückgängig (Strg+Z)', 'aria-label': 'Rückgängig', onclick: undo }, icon('undo')),
    h('button', { id: 'btnRedo', title: 'Wiederholen (Strg+Y)', 'aria-label': 'Wiederholen', onclick: redo }, icon('redo')));
  $('#zoomPill').append(
    h('button', { title: 'Verkleinern', onclick: () => setZoom(ed.zoom / 1.2) }, icon('minus', 18)),
    h('button', { id: 'zoomLabel', class: 'mono', title: 'Auf 100 % zurücksetzen', onclick: () => setZoom(1) }, '100 %'),
    h('button', { title: 'Vergrößern', onclick: () => setZoom(ed.zoom * 1.2) }, icon('plus', 18)));
  $('#tbRight').append(
    // only shown while the sync merge left notes on this document
    tb('btnConflict', 'sync', 'Sync-Hinweise', async () => {
      const doc = ed.doc;
      if (await showConflicts(doc) && ed.doc === doc) { delete doc.conflicts; changed(); updateChrome(); }
    }),
    tb('btnAdd', 'addPage', 'Seite hinzufügen', e => addPageMenu(e.currentTarget)),
    tb('btnShare', 'share', 'Exportieren', e => exportMenu(e.currentTarget)),
    tb('btnMore', 'moreCircle', 'Mehr', e => menu(e.currentTarget, [
      { label: 'Dokument umbenennen', icon: 'rename', action: renameDoc },
      { label: 'Papiervorlage ändern', icon: 'doc', action: () => changeTemplate() },
      { label: 'Seite duplizieren', icon: 'copy', action: () => duplicatePage(ed.cur) },
      { label: 'Seite leeren', icon: 'eraser', action: () => clearPage() },
      { label: 'Seite löschen', icon: 'trash', danger: true, action: () => deletePage(ed.cur) },
      '-',
      { label: 'Nur mit Stift zeichnen', checked: !settings.fingerDraw, action: () => { settings.fingerDraw = !settings.fingerDraw; saveSettings(); } },
      { label: 'Einstellungen', icon: 'gear', action: openSettings },
    ])));
}

async function renameDoc() {
  const name = await promptText('Umbenennen', ed.doc.name, '', suggestNames(ed.doc));
  if (!name) return;
  ed.doc.name = name; changed(); renderTabs();
}

export function selectTool(t) {
  if (t === 'image') return insertImage();
  finishText();
  if (t !== 'lasso') clearSelection();
  ed.tool = t; settings.tool = t; saveSettings();
  view.dataset.tool = t;
  document.querySelectorAll('.toolbtn').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  renderOptions();
}

function updateBookmarkBtn() {
  const b = $('#btnBookmark');
  if (!b || !ed.doc) return;
  const on = !!currentPage()?.bookmark;
  if (b._on === on) return; // called on every scroll event: only touch the DOM on a change
  b._on = on;
  b.replaceChildren(icon(on ? 'bookmarkFill' : 'bookmark', 24));
  b.classList.toggle('on', on);
}
export function updateChrome() {
  if (!ed.doc) return;
  $('#btnUndo').disabled = !hist().undo.length;
  $('#btnRedo').disabled = !hist().redo.length;
  updateBookmarkBtn();
  $('#btnConflict').hidden = !ed.doc.conflicts?.length;
  $('#btnAdd').hidden = ed.doc.pages.some(p => p.inf); // an infinite notebook is one growing page
  view.dataset.tool = ed.tool;
  document.querySelectorAll('.toolbtn').forEach(b => b.classList.toggle('active', b.dataset.tool === ed.tool));
}

// ---------- Tool options bar ----------
const optbar = $('#optbar');
const sep = () => h('div', { class: 'opt-sep' });

// Direct-choice colours: 1–10 slots per tool. Tap = choose, tap the active one = edit;
// "+" adds a slot (copy of the active colour).
const MAX_SLOTS = 10;
function colorSlots(cfg) {
  return h('div', { class: 'opt-group' }, cfg.colors.map((c, i) => h('button', {
    class: 'swatch' + (cfg.color === i ? ' active' : ''), style: { '--c': c }, title: cfg.color === i ? 'Farbe ändern' : 'Farbe wählen',
    onclick: e => {
      if (cfg.color === i) return colorPopover(e.currentTarget, cfg, i);
      cfg.color = i; saveTools(); renderOptions(); recolorSelection(c);
    },
  })), cfg.colors.length < MAX_SLOTS ? h('button', {
    class: 'swatch-add', title: 'Farbe zur Direktauswahl hinzufügen', 'aria-label': 'Farbe hinzufügen',
    onclick: () => { cfg.colors.push(cfg.colors[cfg.color] || '#0F2747'); cfg.color = cfg.colors.length - 1; saveTools(); renderOptions(); colorPopover(optbar.querySelector('.swatch.active'), cfg, cfg.color); },
  }, icon('plus', 16)) : null);
}

// Colour window: palette (switchable), own saved colours, any colour + hex, remove slot
function colorPopover(anchor, cfg, i) {
  const own = () => (settings.customColors ||= []);
  const set = (c, close) => { cfg.colors[i] = c; cfg.color = i; saveTools(); renderOptions(); recolorSelection(c); if (close) closePopover(); else draw(); };
  const body = h('div', { class: 'colorpop' });
  const draw = () => {
    const cur = (cfg.colors[i] || '#000000').toLowerCase();
    const sw = c => h('button', { class: 'pal' + (c.toLowerCase() === cur ? ' active' : ''), style: { '--c': c }, title: c.toUpperCase(), onclick: () => set(c, true) });
    const hex = h('input', { class: 'field mono', value: cur.toUpperCase(), maxlength: 7, 'aria-label': 'Hex-Farbwert' });
    hex.onchange = () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) set(hex.value); };
    const picker = h('input', { type: 'color', class: 'colorwell', value: cur, onchange: e => set(e.target.value), oninput: e => { hex.value = e.target.value.toUpperCase(); } });
    const ownSw = c => {
      const b = sw(c);
      b.title = c.toUpperCase() + ' — gedrückt halten oder Rechtsklick zum Entfernen';
      onContext(b, () => { settings.customColors = own().filter(x => x !== c); saveSettings(); draw(); });
      return b;
    };
    body.replaceChildren(
      h('div', { class: 'pal-tabs' }, Object.entries(PALETTES).map(([k, [label]]) => h('button', {
        class: 'chip' + ((settings.palette || 'standard') === k ? ' on' : ''), onclick: () => { usePalette(k); draw(); },
      }, label))),
      h('div', { class: 'palette' }, PALETTE.map(sw)),
      h('div', { class: 'pop-title' }, 'Eigene Farben'),
      h('div', { class: 'palette own' }, own().map(ownSw), h('button', {
        class: 'pal pal-add', title: 'Aktuelle Farbe speichern', 'aria-label': 'Aktuelle Farbe speichern',
        onclick: () => { if (!own().includes(cur)) { own().push(cur); saveSettings(); } draw(); },
      }, icon('plus', 16))),
      h('div', { class: 'custom-color' }, picker, hex),
      cfg.colors.length > 1 ? h('button', {
        class: 'menu-item danger pal-remove', onclick: () => {
          cfg.colors.splice(i, 1); cfg.color = Math.min(cfg.color, cfg.colors.length - 1);
          saveTools(); renderOptions(); closePopover();
        },
      }, h('span', { class: 'menu-label' }, 'Aus Direktauswahl entfernen'), h('span', { class: 'menu-icon' }, icon('trash', 18))) : null);
  };
  draw();
  popover(anchor, body);
}

// Widths are stored in page units; shown and entered in millimetres (A4: 1000 units = 210 mm,
// the same paper millimetres Goodnotes uses).
const MM = PAGE_W / 210;
function widthSlots(cfg, max, scale) {
  return h('div', { class: 'opt-group' }, cfg.widths.map((w, i) => h('button', {
    class: 'widthbtn' + (cfg.width === i ? ' active' : ''), title: (w / MM).toFixed(2).replace('.', ',') + ' mm' + (cfg.width === i ? ' – anpassen' : ''),
    onclick: e => {
      if (cfg.width !== i) { cfg.width = i; saveTools(); return renderOptions(); }
      const min = 0.1, maxMM = Math.round(max / MM * 10) / 10; // mm
      const format = n => String(Number(n.toFixed(2))).replace('.', ',');
      const update = n => {
        cfg.widths[i] = Math.round(n * MM * 100) / 100;
        range.value = n;
        saveTools(); renderOptionsKeepPopover();
      };
      const value = h('input', {
        type: 'text', inputmode: 'decimal', class: 'width-value mono', value: format(w / MM),
        'aria-label': 'Stärke in Millimetern', title: 'Stärke in mm eingeben (' + format(min) + '–' + format(maxMM) + ')',
        onfocus: ev => ev.target.select(),
        oninput: ev => {
          // A text field accepts decimal commas on the German iPad keyboard, too.
          const raw = ev.target.value.trim().replace(',', '.');
          const n = Number(raw);
          const valid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw) && Number.isFinite(n) && n >= min && n <= maxMM;
          ev.target.setCustomValidity(valid ? '' : 'Wert zwischen ' + format(min) + ' und ' + format(maxMM) + ' mm eingeben.');
          if (valid) update(Math.round(n * 100) / 100);
        },
        onblur: ev => {
          ev.target.value = format(cfg.widths[i] / MM);
          ev.target.setCustomValidity('');
        },
        onkeydown: ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); }
        },
      });
      const range = h('input', {
        type: 'range', min, max: maxMM, step: 0.05, value: w / MM, 'aria-label': 'Stärke in Millimetern',
        oninput: ev => {
          update(+ev.target.value);
          value.value = format(cfg.widths[i] / MM);
          value.setCustomValidity('');
        },
      });
      popover(e.currentTarget, h('div', { class: 'widthpop' },
        h('div', { class: 'pop-title' }, 'Stärke (mm)'), range, value));
    },
  }, h('span', { class: 'width-dot', style: { width: Math.max(3, Math.min(22, w * scale)) + 'px', height: Math.max(3, Math.min(22, w * scale)) + 'px' } }))));
}
// Re-render the bar without closing an open popover (popover anchors are replaced, so only update dots).
function renderOptionsKeepPopover() {
  const cfg = T[ed.tool];
  optbar.querySelectorAll('.widthbtn .width-dot').forEach((d, i) => {
    const sc2 = ed.tool === 'highlighter' ? 0.55 : 2.6;
    const s = Math.max(3, Math.min(22, cfg.widths[i] * sc2)) + 'px';
    d.style.width = d.style.height = s;
  });
}

const chip = (label, on, fn) => h('button', { class: 'chip' + (on ? ' on' : ''), onclick: fn }, label);

function presetsButton(kind) {
  return h('button', {
    class: 'iconbtn', title: 'Favoriten',
    onclick: e => {
      const list = T.presets.filter(p => p.tool === kind);
      const cfg = T[kind];
      menu(e.currentTarget, [
        ...list.map(p => ({
          label: `${p.pen ? { fountain: 'Füller', ball: 'Kugelschreiber', brush: 'Pinsel' }[p.pen] + ' · ' : ''}${Number(p.width.toFixed(2))}`,
          swatch: p.color,
          action: () => {
            let ci = cfg.colors.findIndex(c => c.toLowerCase() === p.color.toLowerCase());
            if (ci < 0) { ci = cfg.color; cfg.colors[ci] = p.color; }
            let wi = cfg.widths.indexOf(p.width);
            if (wi < 0) { wi = cfg.width; cfg.widths[wi] = p.width; }
            Object.assign(cfg, { color: ci, width: wi }, p.pen ? { pen: p.pen } : {});
            saveTools(); renderOptions();
          },
        })),
        list.length ? '-' : null,
        {
          label: 'Aktuelle Einstellung merken', icon: 'star', action: () => {
            T.presets.push({ tool: kind, pen: cfg.pen, color: cfg.colors[cfg.color], width: cfg.widths[cfg.width] });
            saveTools(); toast('Als Favorit gespeichert');
          },
        },
        list.length ? { label: 'Favoriten entfernen', icon: 'trash', danger: true, action: () => { T.presets = T.presets.filter(p => p.tool !== kind); settings.tools.presets = T.presets; saveTools(); } } : null,
      ]);
    },
  }, icon('star'));
}

// White dropdown button at the start of the options pill (pen type, eraser mode).
function optDrop(ic, label, items) {
  return h('button', { class: 'opt-drop', onclick: e => menu(e.currentTarget, items) }, icon(ic, 18), h('span', {}, label), icon('chevronDown', 14));
}
const PENS = [['fountain', 'Füller', 'nibFountain'], ['ball', 'Kugelschreiber', 'nibBall'], ['brush', 'Pinsel', 'nibBrush']];
const PEN_TITLES = { fountain: 'Füllfederhalter', ball: 'Kugelschreiber', brush: 'Pinselstift' };

// Pen settings popover (as in Goodnotes): preview, pen type, three sliders,
// "Zeichnen und Halten" and a "Stiftgesten" subpage.
function penPopover(anchor) {
  const cfg = T.pen;
  const wrap = h('div', { class: 'penpop' });
  const set = (k, v) => { cfg[k] = v; saveTools(); };

  const preview = h('canvas', { class: 'pen-preview' });
  function drawPreview() {
    const w = 560, hh = 170;
    preview.width = w; preview.height = hh;
    const ctx = preview.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    // S-curve with pressure rising then falling, like a natural stroke
    const pts = Array.from({ length: 90 }, (_, i) => {
      const t = i / 89;
      return [30 + t * 220, 45 - Math.sin(t * Math.PI * 2 - 0.4) * 22, 0.25 + 0.6 * Math.sin(t * Math.PI)];
    });
    const stroke = {
      type: 'stroke', tool: 'pen', ink: 2, rad: 1, pen: cfg.pen, color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000',
      width: Math.max(4, cfg.widths[cfg.width] * 2.4), sharp: cfg.sharp, press: cfg.press,
    };
    const input = new PenInput(stroke, pts[0], 0, 1, cfg.stab);
    pts.slice(1).forEach((p, i) => input.push(p, (i + 1) * 1000 / 120));
    drawStroke(ctx, { ...stroke, points: input.finish() });
  }

  function slider(label, key) {
    const val = h('span', { class: 'pp-val mono' }, Math.round(cfg[key] * 100) + ' %');
    const input = h('input', {
      type: 'range', class: 'pp-range', min: 0, max: 100, step: 1, value: Math.round(cfg[key] * 100), 'aria-label': label,
      oninput: e => {
        set(key, e.target.value / 100);
        val.textContent = e.target.value + ' %';
        input.style.setProperty('--v', e.target.value + '%');
        drawPreview();
      },
    });
    input.style.setProperty('--v', Math.round(cfg[key] * 100) + '%');
    return h('div', { class: 'pp-slider' },
      h('div', { class: 'pp-label' }, h('span', {}, label), val),
      h('div', { class: 'pp-track' }, input, h('div', { class: 'pp-ticks' }, [0, 1, 2, 3, 4].map(() => h('span')))));
  }

  function mainPage() {
    wrap.replaceChildren(
      h('div', { class: 'pp-title' }, PEN_TITLES[cfg.pen]),
      preview,
      h('div', { class: 'pp-types' }, PENS.map(([k, , ic]) => h('button', {
        class: 'pp-type' + (cfg.pen === k ? ' active' : ''),
        onclick: () => {
          set('pen', k); mainPage();
          // keep the toolbar button in sync without re-rendering it (it anchors this popover)
          anchor.replaceChildren(icon(ic, 18), h('span', {}, PENS.find(p => p[0] === k)[1]), icon('chevronDown', 14));
        },
      }, icon(ic, 26), h('span', {}, PEN_TITLES[k])))),
      h('div', { class: 'pp-sep' }),
      slider('Schärfe der Spitze', 'sharp'),
      slider('Druckempfindlichkeit', 'press'),
      slider('Strich-Stabilisierung', 'stab'),
      h('div', { class: 'pp-sep' }),
      h('div', { class: 'pp-section' }, 'Einstellungen'),
      toggle('Zeichnen und Halten', cfg.drawHold, v => set('drawHold', v)),
      h('button', { class: 'pp-row', onclick: gesturesPage }, h('span', {}, 'Stiftgesten'), icon('chevronRight', 18)));
    drawPreview();
  }

  function gesturesPage() {
    const all = toggle('Formen und Textmarker löschen', cfg.scribbleAll, v => set('scribbleAll', v));
    const syncAll = () => all.classList.toggle('disabled', !cfg.scribble);
    wrap.replaceChildren(
      h('div', { class: 'pp-head' },
        h('button', { class: 'pp-back', title: 'Zurück', onclick: mainPage }, icon('chevronLeft', 20)),
        h('span', {}, 'Stiftgesten')),
      toggle('Kritzeln zum Löschen', cfg.scribble, v => { set('scribble', v); syncAll(); }),
      all,
      h('div', { class: 'pp-hint' }, 'Handschrift und Zeichnungen durch Überkritzeln löschen'),
      h('div', { class: 'pp-sep' }),
      toggle('Umkreisen für Lasso', cfg.circleLasso, v => set('circleLasso', v)),
      h('div', { class: 'pp-hint' }, 'Zeichne um etwas herum, um es auszuwählen und zu verschieben'));
    syncAll();
  }

  mainPage();
  popover(anchor, wrap, { className: 'penpop-wrap' });
}

export function renderOptions() {
  const t = ed.tool, cfg = T[t];
  let parts = [];
  if (t === 'pen') {
    const cur = PENS.find(p => p[0] === cfg.pen) || PENS[0];
    parts = [
      h('button', { class: 'opt-drop', onclick: e => penPopover(e.currentTarget) }, icon(cur[2], 18), h('span', {}, cur[1]), icon('chevronDown', 14)),
      colorSlots(cfg), sep(), widthSlots(cfg, 24, 2.6), sep(), presetsButton('pen'),
    ];
  } else if (t === 'highlighter') {
    parts = [colorSlots(cfg), sep(), widthSlots(cfg, 50, 0.55), sep(),
      chip('Gerade Linie', cfg.straight, () => { cfg.straight = !cfg.straight; saveTools(); renderOptions(); }), sep(), presetsButton('highlighter')];
  } else if (t === 'shapes') {
    parts = [colorSlots(cfg), sep(), widthSlots(cfg, 12, 2.6), sep(), h('span', { class: 'opt-hint' }, 'Form zeichnen – wird automatisch geglättet')];
  } else if (t === 'eraser') {
    parts = [
      optDrop('eraser', cfg.mode === 'precise' ? 'Präzise' : 'Ganzer Strich', [
        { label: 'Präzise', checked: cfg.mode === 'precise', action: () => { cfg.mode = 'precise'; saveTools(); renderOptions(); } },
        { label: 'Ganzer Strich', checked: cfg.mode === 'stroke', action: () => { cfg.mode = 'stroke'; saveTools(); renderOptions(); } },
        '-',
        { label: 'Nur Textmarker radieren', checked: cfg.hlOnly, action: () => { cfg.hlOnly = !cfg.hlOnly; saveTools(); renderOptions(); } },
        { label: 'Seite leeren', icon: 'trash', danger: true, action: () => clearPage() },
      ]),
      h('div', { class: 'opt-group' }, cfg.sizes.map((s, i) => h('button', {
        class: 'widthbtn' + (cfg.size === i ? ' active' : ''), title: 'Größe', onclick: () => { cfg.size = i; saveTools(); renderOptions(); },
      }, h('span', { class: 'eraser-dot', style: { width: 10 + i * 8 + 'px', height: 10 + i * 8 + 'px' } })))),
    ];
  } else if (t === 'lasso') {
    // free-hand or rectangle selection; both use the same filters and actions
    const mode = cfg.mode === 'rect' ? 'rect' : 'free';
    const modeBtn = (m, ic, label) => h('button', {
      class: 'iconbtn' + (mode === m ? ' on' : ''), title: label, 'aria-label': label, 'aria-pressed': mode === m ? 'true' : 'false',
      onclick: () => { cfg.mode = m; saveTools(); renderOptions(); },
    }, icon(ic, 20));
    parts = [h('div', { class: 'opt-group' }, modeBtn('free', 'lasso', 'Freihand-Lasso'), modeBtn('rect', 'lassoRect', 'Rechteck-Auswahl')), sep(),
      h('span', { class: 'opt-label' }, 'Auswählen:'),
      chip('Handschrift', cfg.strokes, () => { cfg.strokes = !cfg.strokes; saveTools(); renderOptions(); }),
      chip('Bilder', cfg.images, () => { cfg.images = !cfg.images; saveTools(); renderOptions(); }),
      chip('Text', cfg.text, () => { cfg.text = !cfg.text; saveTools(); renderOptions(); }),
      hasSelection() ? [sep(), h('button', { class: 'chip danger', onclick: deleteSelection }, 'Auswahl löschen')] : null];
  } else if (t === 'text') {
    // values of the box being edited (or the first selected one), else the tool's defaults
    const selText = ed.sel && ed.sel.page.elements.find(e => ed.sel.ids.has(e.id) && e.type === 'text');
    const cur = ed.editing ? ed.editing.current() : selText || cfg;
    const size = Math.round(cur.size);
    parts = [colorSlots(cfg), sep(), h('div', { class: 'stepper' },
      h('button', { class: 'iconbtn', title: 'Kleiner', onclick: () => applyTextStyle({ size: Math.max(8, size - 2) }) }, icon('minus', 18)),
      h('span', { class: 'mono' }, size + ' pt'),
      h('button', { class: 'iconbtn', title: 'Größer', onclick: () => applyTextStyle({ size: Math.min(160, size + 2) }) }, icon('plus', 18))),
      sep(),
      h('button', { class: 'iconbtn txt-style' + (cur.bold ? ' on' : ''), title: 'Fett', 'aria-pressed': !!cur.bold, onclick: () => applyTextStyle({ bold: !cur.bold }) }, h('b', {}, 'B')),
      h('button', { class: 'iconbtn txt-style' + (cur.italic ? ' on' : ''), title: 'Kursiv', 'aria-pressed': !!cur.italic, onclick: () => applyTextStyle({ italic: !cur.italic }) }, h('i', {}, 'I')),
      h('button', {
        class: 'opt-drop', title: 'Schriftart', style: { fontFamily: fontFamily(cur) },
        onclick: e => { const p = menu(e.currentTarget, Object.entries(FONTS).map(([k, [label]]) => ({ label, checked: (cur.font || 'sans') === k, action: () => applyTextStyle({ font: k }) }))); keepTextFocus(p.el); },
      }, h('span', {}, (FONTS[cur.font] || FONTS.sans)[0]), icon('chevronDown', 14)),
      ed.editing || selText ? null : [sep(), h('span', { class: 'opt-hint' }, 'Auf die Seite tippen, um ein Textfeld zu erstellen')]];
  } else if (t === 'laser') {
    parts = [colorSlots(cfg), sep(), h('span', { class: 'opt-hint' }, 'Die Spur verschwindet automatisch')];
  } else if (t === 'screenshot') {
    parts = [h('span', { class: 'opt-hint', style: { padding: '0 8px' } }, 'Bereich aufziehen – oder auf die Seite tippen für die ganze Seite')];
  }
  optbar.replaceChildren(h('div', { class: 'opt-inner' }, parts.flat()));
}

// Colour/size changes apply to the current lasso selection or text being edited.
function recolorSelection(c) {
  if (ed.editing) { ed.editing.setColor(c); return; }
  if (!ed.sel) return;
  const page = ed.sel.page;
  commit(page, page.elements.map(e => ed.sel.ids.has(e.id) && e.type !== 'image' ? { ...e, color: c } : e));
}
// Size / bold / italic / font: for the box being edited, the selected text boxes, and new boxes.
function applyTextStyle(patch) {
  const cfg = T.text;
  // while editing, the style goes to the selected characters only; otherwise it also becomes
  // the default for new text boxes
  if (!ed.editing) { for (const [k, v] of Object.entries(patch)) cfg[k] = v; saveTools(); }
  if (ed.editing) ed.editing.setStyle(patch);
  else if (ed.sel) {
    const page = ed.sel.page;
    commit(page, page.elements.map(e => ed.sel.ids.has(e.id) && e.type === 'text' ? { ...e, ...patch } : e));
    renderSelection();
  }
  renderOptions();
}
// Clicks in the bar or its menus must not take the focus from the text being edited.
function keepTextFocus(el) {
  for (const t of ['pointerdown', 'mousedown']) el.addEventListener(t, e => { if (ed.editing && !e.target.closest('input')) e.preventDefault(); });
}
keepTextFocus(optbar);
function resizeSelectionText(size) {
  if (ed.editing) { ed.editing.setSize(size); return; }
  if (!ed.sel) return;
  const page = ed.sel.page;
  commit(page, page.elements.map(e => ed.sel.ids.has(e.id) && e.type === 'text' ? { ...e, size } : e));
}

// ---------- Tool details bar (dock) ----------
// The details of the active tool (variants, colours, widths) live in their own bar so the main
// tool row never changes. It docks at the top (horizontal) or at the left/right edge (vertical);
// only its grip moves it, so using its buttons and sliders never drags it by accident.
const dock = $('#optdock');
function applyDock(where = settings.optDock || 'top') {
  dock.classList.remove('top', 'left', 'right', 'dragging');
  dock.style.left = dock.style.top = '';
  dock.classList.add(where);
  view.classList.toggle('dock-top', where === 'top');
}
function initDock() {
  applyDock();
  const grip = dock.querySelector('.optdock-grip');
  grip.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    try { grip.setPointerCapture(e.pointerId); } catch {}
    const stage = dock.parentElement.getBoundingClientRect(), r = dock.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    let moved = false;
    const move = ev => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      dock.classList.add('dragging');
      dock.style.left = (ev.clientX - stage.left - dx) + 'px'; dock.style.top = (ev.clientY - stage.top - dy) + 'px';
    };
    const up = ev => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
      if (!moved) return applyDock();
      // near the left / right edge → dock there (vertical), otherwise at the top (horizontal)
      const x = ev.clientX - stage.left, edge = Math.min(120, stage.width * 0.18);
      settings.optDock = x < edge ? 'left' : x > stage.width - edge ? 'right' : 'top';
      saveSettings(); applyDock();
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
  });
  // touches on the bar must not reach the page (no drawing / scrolling underneath)
  for (const t of ['pointerdown', 'touchstart']) dock.addEventListener(t, e => e.stopPropagation(), { passive: true });
}

export function initEditor() {
  initDock();
  buildToolbar();
  selectTool(ed.tool);
}
