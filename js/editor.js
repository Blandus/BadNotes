import { $, h, uid, clamp, debounce, pickFile, onContext } from './util.js';
import { icon } from './icons.js';
import { store, settings, saveSettings, bus, PAGE_W, newPage, TEMPLATES } from './store.js';
import { renderPage, renderThumb, pageH, drawStroke } from './render.js';
import { menu, popover, sheet, toast, segmented, closePopover, promptText, toggle } from './ui.js';
import { exportPdf, exportPng, loadImageFile } from './pdf.js';
import { renderLibrary, templatePicker, openSettings } from './library.js';
import { clearSelection, renderSelection, finishText, selectIds, hasSelection, deleteSelection } from './tools.js';

const MAX_CANVAS_PX = 16e6; // iPad Safari's per-canvas limit (16.7 MP); few pages are kept rendered

// ---------- Tool configuration (per device) ----------
const DEFAULT_TOOLS = {
  pen: {
    pen: 'fountain', colors: ['#1A1A1A', '#1F4FD1', '#D12F2F'], color: 0, widths: [1.5, 3, 5], width: 1,
    sharp: 0.5, press: 0.5, stab: 0, // tip sharpness, pressure sensitivity, stroke stabilisation (0..1)
    drawHold: true, scribble: true, scribbleAll: true, circleLasso: true,
  },
  highlighter: { colors: ['#FFE14D', '#7CE38B', '#FF8AD0'], color: 0, widths: [12, 20, 30], width: 1, straight: false },
  shapes: { colors: ['#1A1A1A', '#1F4FD1', '#D12F2F'], color: 0, widths: [1.5, 3, 5], width: 1 },
  eraser: { sizes: [6, 14, 30], size: 1, mode: 'precise', hlOnly: false },
  lasso: { strokes: true, images: true, text: true },
  text: { colors: ['#1A1A1A', '#1F4FD1', '#D12F2F'], color: 0, size: 24 },
  laser: { colors: ['#FF3B30', '#34C759', '#0A84FF'], color: 0 },
};
const saved = settings.tools || {};
export const T = Object.fromEntries(Object.entries(DEFAULT_TOOLS).map(([k, v]) => [k, { ...v, ...(saved[k] || {}) }]));
T.presets = saved.presets || [];
settings.tools = T;
export const saveTools = debounce(saveSettings, 300);

// Lasso sits in the left group (as in Goodnotes); these are the centre tools.
const TOOLS = [
  ['pen', 'Stift', 'pen'], ['eraser', 'Radierer', 'eraser'], ['highlighter', 'Textmarker', 'highlighter'],
  ['text', 'Text', 'text'], ['shapes', 'Formen', 'shapes'], ['image', 'Bild', 'image'],
  ['laser', 'Laserpointer', 'laser'], ['screenshot', 'Screenshot', 'screenshot'],
];
export const PALETTE = ['#000000', '#4A4A4A', '#8E8E93', '#FFFFFF', '#1F4FD1', '#2E8BFF', '#36B7E8', '#1F8A4C', '#5BC236', '#F2C200',
  '#FF9500', '#D12F2F', '#FF2D55', '#AF52DE', '#8E5A2B', '#FFE14D', '#7CE38B', '#8FD3FF', '#FF8AD0', '#FFB86B'];

// ---------- Editor state ----------
export const ed = {
  doc: null, tabs: settings.tabs || [], tool: settings.tool || 'pen', zoom: 1,
  sel: null, editing: null, busy: false, pageEls: [], cur: 0,
  hist: new Map(), views: new Map(),
};
if (ed.tool === 'image') ed.tool = 'pen';
export const sc = $('#scroller');
const visible = new Set();
const view = $('#editor');

// ---------- Opening & closing documents ----------
export async function openDoc(id) {
  await finishText();
  await flushSave();
  if (ed.doc) saveView();
  const doc = await store.get(id);
  if (!doc || doc.deleted || doc.trashed) return toast('Dokument nicht gefunden');
  if (!ed.tabs.includes(id)) ed.tabs.push(id);
  settings.tabs = ed.tabs; settings.activeTab = id; saveSettings();
  $('#library').hidden = true; view.hidden = false;
  doc.opened = Date.now();
  store.put(doc);
  ed.doc = doc;
  clearSelection();
  buildPages();
  restoreView();
  renderTabs(); renderThumbs(); updateChrome(); renderOptions();
}

export async function showLibrary() {
  await finishText();
  await flushSave();
  saveView();
  settings.activeTab = null; saveSettings();
  ed.doc = null;
  clearSelection(); closePopover();
  observer.disconnect(); visible.clear();
  $('#pages').replaceChildren();
  view.hidden = true; $('#library').hidden = false;
  renderLibrary();
}

function closeTab(id) {
  ed.tabs = ed.tabs.filter(t => t !== id);
  settings.tabs = ed.tabs; saveSettings();
  if (ed.doc?.id === id) { const next = ed.tabs[ed.tabs.length - 1]; next ? openDoc(next) : showLibrary(); }
  else renderTabs();
}

function saveView() { if (ed.doc) ed.views.set(ed.doc.id, { zoom: ed.zoom, top: sc.scrollTop, left: sc.scrollLeft }); }
function restoreView() {
  const v = ed.views.get(ed.doc.id) || { zoom: 1, top: 0, left: 0 };
  ed.zoom = v.zoom; applyZoom(); updateZoomLabel();
  sc.scrollTop = v.top; sc.scrollLeft = v.left;
  updateCurrent();
}

async function renderTabs() {
  const recs = await Promise.all(ed.tabs.map(id => store.get(id)));
  ed.tabs = ed.tabs.filter((id, i) => recs[i] && !recs[i].deleted && !recs[i].trashed);
  const tabs = ed.tabs.map(id => {
    const name = id === ed.doc?.id ? ed.doc.name : recs.find(r => r?.id === id).name;
    return h('div', { class: 'tab' + (id === ed.doc?.id ? ' active' : '') },
      h('button', { class: 'tab-title', title: name, onclick: () => id !== ed.doc?.id && openDoc(id) }, name),
      h('button', { class: 'tab-close', title: 'Tab schließen', onclick: () => closeTab(id) }, icon('close', 14)));
  });
  $('#tabs').replaceChildren(...tabs);
  // Tabs only appear once more than one document is open (the web app has none).
  $('#tabbar').hidden = ed.tabs.length < 2;
  if (ed.doc) $('#docTitleText').textContent = ed.doc.name;
}

// Remote (sync) updates to the open document
bus.addEventListener('remote', async e => {
  if (!ed.doc || e.detail !== ed.doc.id) return;
  const doc = await store.get(ed.doc.id);
  if (!doc || doc.deleted || doc.trashed) return closeTab(e.detail);
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
  saveT = setTimeout(flushSave, 600);
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
  page.elements = next;
  const done = refreshPage(page);
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
    else { visible.delete(e.target); e.target._canvas.width = 0; e.target._canvas.height = 0; }
  }
}, { root: sc, rootMargin: '300px 0px' });

export async function renderEl(el) {
  visible.add(el);
  const c = el._canvas, page = el._page, ph = pageH(page);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(el.clientWidth * dpr / PAGE_W, Math.sqrt(MAX_CANVAS_PX / (PAGE_W * ph)));
  const w = Math.round(PAGE_W * scale), hh = Math.round(ph * scale);
  // Draw offscreen, then swap in one go to avoid flicker.
  const off = document.createElement('canvas'); off.width = w; off.height = hh;
  await renderPage(off.getContext('2d'), page, scale, ed.editing?.page === page ? ed.editing.id : null);
  if (el._page !== page) return;
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(off, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
}
export const elForPage = page => ed.pageEls.find(el => el._page === page);
export function refreshPage(page) {
  const el = elForPage(page);
  const done = el && visible.has(el) ? renderEl(el) : Promise.resolve();
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
  z = clamp(z, 0.5, 4);
  if (Math.abs(z - ed.zoom) < 0.001) return;
  const r = sc.getBoundingClientRect();
  cx ??= r.left + r.width / 2; cy ??= r.top + r.height / 2;
  const ox = cx - r.left + sc.scrollLeft, oy = cy - r.top + sc.scrollTop;
  const k = z / ed.zoom;
  ed.zoom = z; applyZoom();
  sc.scrollLeft = ox * k - (cx - r.left);
  sc.scrollTop = oy * k - (cy - r.top);
  updateZoomLabel();
  clearTimeout(zoomT); zoomT = setTimeout(() => { rerenderVisible(); renderSelection(); }, 200);
  repositionText();
}

export function buildPages() {
  observer.disconnect(); visible.clear();
  applyZoom();
  ed.pageEls = ed.doc.pages.map(page => {
    const el = h('div', { class: 'page', style: { aspectRatio: `${PAGE_W} / ${pageH(page)}` } });
    const c = h('canvas');
    el.append(c);
    if (page.bookmark) el.append(h('div', { class: 'page-bm' }, icon('bookmarkFill', 20)));
    el._page = page; el._canvas = c;
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
  ed.pageEls.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const d = probe < r.top ? r.top - probe : probe > r.bottom ? probe - r.bottom : 0;
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best !== ed.cur) { ed.cur = best; highlightThumb(); }
  updateBookmarkBtn();
  $('#pageInd').textContent = `${ed.cur + 1} von ${ed.doc.pages.length}`;
}
sc.addEventListener('scroll', () => { updateCurrent(); repositionText(); });

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

function addPageMenu(anchor) {
  const cur = currentPage();
  let tmpl = cur?.bg ? (settings.lastTemplate || 'lined') : (cur?.template || 'lined');
  const hh = cur?.bg ? 1414 : pageH(cur);
  const make = at => { closePopover(); insertPages([newPage(tmpl, hh, cur?.bg ? undefined : cur?.paper)], at); };
  const p = popover(anchor, h('div', { class: 'addpage' },
    h('div', { class: 'pop-title' }, 'Seite hinzufügen'),
    templatePicker(tmpl, v => { tmpl = v; }, hh),
    h('div', { class: 'addpage-btns' },
      h('button', { class: 'pill', onclick: () => make(ed.cur) }, 'Davor'),
      h('button', { class: 'pill primary', onclick: () => make(ed.cur + 1) }, 'Danach'),
      h('button', { class: 'pill', onclick: () => make(ed.doc.pages.length) }, 'Am Ende'))), { className: 'wide' });
  return p;
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
  const e = { id: uid(), type: 'image', src: img.src, x: (PAGE_W - w) / 2, y: clamp(midY - hh / 2, 0, Math.max(0, ph - hh)), w, h: hh };
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
    const c = h('canvas', { 'data-pid': p.id, style: { aspectRatio: `${PAGE_W} / ${pageH(p)}` } });
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
    const c = thumbsEl.querySelector(`canvas[data-pid="${page.id}"]`);
    if (c) renderThumb(c, page, 220);
  }, 500));
}

function pageMenu(i, anchor) {
  const p = ed.doc.pages[i];
  menu(anchor, [
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
function tb(id, ic, title, onclick, size = 24) { return h('button', { class: 'barbtn', id, title, 'aria-label': title, onclick }, icon(ic, size)); }
const toolBtn = ([id, label, ic]) => h('button', {
  class: 'toolbtn', 'data-tool': id, title: label, 'aria-label': label, onclick: () => selectTool(id),
}, h('span', {}, icon(ic, 24)));

function exportMenu(anchor) {
  menu(anchor, [
    { label: 'Dokument als PDF', icon: 'pdf', action: () => exportPdf(ed.doc) },
    { label: 'Aktuelle Seite als PDF', icon: 'doc', action: () => exportPdf(ed.doc, [currentPage()]) },
    { label: 'Aktuelle Seite als Bild', icon: 'image', action: () => exportPng(ed.doc, currentPage(), ed.cur) },
  ]);
}

function buildToolbar() {
  $('#tbLeft').append(
    tb('btnHome', 'home', 'Bibliothek', showLibrary),
    h('button', {
      class: 'doc-title', id: 'docTitle', title: 'Dokument',
      onclick: e => menu(e.currentTarget, [
        { label: 'Umbenennen', icon: 'rename', action: renameDoc },
        { label: 'Papiervorlage ändern', icon: 'doc', action: () => changeTemplate() },
        { label: 'Exportieren', icon: 'share', action: () => exportMenu($('#btnShare')) },
        '-',
        { label: 'Zur Bibliothek', icon: 'library', action: showLibrary },
      ]),
    }, h('span', { id: 'docTitleText' }), icon('chevronDown', 16)),
    tb('btnThumbs', 'sidebar', 'Seitenübersicht', () => { settings.thumbsOpen = !settings.thumbsOpen; saveSettings(); renderThumbs(); setTimeout(() => { applyZoom(); rerenderVisible(); }, 0); }),
    tb('btnSearch', 'search', 'Suchen', () => toggleSearch()),
    tb('btnBookmark', 'bookmark', 'Lesezeichen', () => toggleBookmark()),
    toolBtn(['lasso', 'Lasso', 'lasso']));
  $('#tbTools').append(...TOOLS.map(toolBtn));
  $('#undoPill').append(
    h('button', { id: 'btnUndo', title: 'Rückgängig (Strg+Z)', 'aria-label': 'Rückgängig', onclick: undo }, icon('undo')),
    h('button', { id: 'btnRedo', title: 'Wiederholen (Strg+Y)', 'aria-label': 'Wiederholen', onclick: redo }, icon('redo')));
  $('#zoomPill').append(
    h('button', { title: 'Verkleinern', onclick: () => setZoom(ed.zoom / 1.2) }, icon('minus', 18)),
    h('button', { id: 'zoomLabel', class: 'mono', title: 'Auf 100 % zurücksetzen', onclick: () => setZoom(1) }, '100 %'),
    h('button', { title: 'Vergrößern', onclick: () => setZoom(ed.zoom * 1.2) }, icon('plus', 18)));
  $('#tbRight').append(
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
  const name = await promptText('Umbenennen', ed.doc.name);
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
  b.replaceChildren(icon(on ? 'bookmarkFill' : 'bookmark', 24));
  b.classList.toggle('on', on);
}
export function updateChrome() {
  if (!ed.doc) return;
  $('#btnUndo').disabled = !hist().undo.length;
  $('#btnRedo').disabled = !hist().redo.length;
  updateBookmarkBtn();
  view.dataset.tool = ed.tool;
  document.querySelectorAll('.toolbtn').forEach(b => b.classList.toggle('active', b.dataset.tool === ed.tool));
}

// ---------- Tool options bar ----------
const optbar = $('#optbar');
const sep = () => h('div', { class: 'opt-sep' });

function colorSlots(cfg) {
  return h('div', { class: 'opt-group' }, cfg.colors.map((c, i) => h('button', {
    class: 'swatch' + (cfg.color === i ? ' active' : ''), style: { '--c': c }, title: cfg.color === i ? 'Farbe ändern' : 'Farbe wählen',
    onclick: e => {
      if (cfg.color === i) return colorPopover(e.currentTarget, cfg, i);
      cfg.color = i; saveTools(); renderOptions(); recolorSelection(c);
    },
  })));
}

function colorPopover(anchor, cfg, i) {
  const set = (c, close) => { cfg.colors[i] = c; cfg.color = i; saveTools(); renderOptions(); recolorSelection(c); if (close) closePopover(); };
  const hex = h('input', { class: 'field mono', value: cfg.colors[i].toUpperCase(), maxlength: 7 });
  hex.onchange = () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) set(hex.value); };
  const picker = h('input', { type: 'color', class: 'colorwell', value: cfg.colors[i], oninput: e => { hex.value = e.target.value.toUpperCase(); set(e.target.value); } });
  popover(anchor, h('div', { class: 'colorpop' },
    h('div', { class: 'pop-title' }, 'Farbe'),
    h('div', { class: 'palette' }, PALETTE.map(c => h('button', { class: 'pal' + (c.toLowerCase() === cfg.colors[i].toLowerCase() ? ' active' : ''), style: { '--c': c }, onclick: () => set(c, true) }))),
    h('div', { class: 'custom-color' }, picker, hex)));
}

function widthSlots(cfg, max, scale) {
  return h('div', { class: 'opt-group' }, cfg.widths.map((w, i) => h('button', {
    class: 'widthbtn' + (cfg.width === i ? ' active' : ''), title: cfg.width === i ? 'Stärke anpassen' : 'Stärke',
    onclick: e => {
      if (cfg.width !== i) { cfg.width = i; saveTools(); return renderOptions(); }
      const label = h('span', { class: 'mono' }, w.toFixed(1));
      popover(e.currentTarget, h('div', { class: 'widthpop' },
        h('div', { class: 'pop-title' }, 'Stärke'),
        h('input', {
          type: 'range', min: max / 20, max, step: 0.5, value: w,
          oninput: ev => { cfg.widths[i] = +ev.target.value; label.textContent = (+ev.target.value).toFixed(1); saveTools(); renderOptionsKeepPopover(); },
        }), label));
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
          label: `${p.pen ? { fountain: 'Füller', ball: 'Kugelschreiber', brush: 'Pinsel' }[p.pen] + ' · ' : ''}${p.width.toFixed(1)}`,
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
    drawStroke(ctx, {
      tool: 'pen', pen: cfg.pen, color: getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000',
      width: Math.max(4, cfg.widths[cfg.width] * 2.4), sharp: cfg.sharp, press: cfg.press, points: pts,
    });
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
      colorSlots(cfg), sep(), widthSlots(cfg, 12, 2.6), sep(), presetsButton('pen'),
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
    parts = [h('span', { class: 'opt-label' }, 'Auswählen:'),
      chip('Handschrift', cfg.strokes, () => { cfg.strokes = !cfg.strokes; saveTools(); renderOptions(); }),
      chip('Bilder', cfg.images, () => { cfg.images = !cfg.images; saveTools(); renderOptions(); }),
      chip('Text', cfg.text, () => { cfg.text = !cfg.text; saveTools(); renderOptions(); }),
      hasSelection() ? [sep(), h('button', { class: 'chip danger', onclick: deleteSelection }, 'Auswahl löschen')] : null];
  } else if (t === 'text') {
    parts = [colorSlots(cfg), sep(), h('div', { class: 'stepper' },
      h('button', { class: 'iconbtn', title: 'Kleiner', onclick: () => { cfg.size = Math.max(10, cfg.size - 2); saveTools(); renderOptions(); resizeSelectionText(cfg.size); } }, icon('minus', 18)),
      h('span', { class: 'mono' }, cfg.size + ' pt'),
      h('button', { class: 'iconbtn', title: 'Größer', onclick: () => { cfg.size = Math.min(96, cfg.size + 2); saveTools(); renderOptions(); resizeSelectionText(cfg.size); } }, icon('plus', 18))),
    sep(), h('span', { class: 'opt-hint' }, 'Auf die Seite tippen, um ein Textfeld zu erstellen')];
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
function resizeSelectionText(size) {
  if (ed.editing) { ed.editing.setSize(size); return; }
  if (!ed.sel) return;
  const page = ed.sel.page;
  commit(page, page.elements.map(e => ed.sel.ids.has(e.id) && e.type === 'text' ? { ...e, size } : e));
}

export function initEditor() {
  buildToolbar();
  selectTool(ed.tool);
}
