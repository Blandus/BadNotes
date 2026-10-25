import { $, h, fmtDate, pickFile } from './util.js';
import { icon } from './icons.js';
import { store, settings, saveSettings, bus, newNotebook, newFolder, cloneNotebook, newPage, COVERS, TEMPLATES, TEMPLATE_SECTIONS, PAPERS, FORMATS, PAGE_W, APP_VERSION } from './store.js';
import { renderCover, renderThumb } from './render.js';
import { menu, sheet, promptText, confirmBox, toast, segmented, toggle } from './ui.js';
import { pdfToPages, loadImageFile, exportPdf } from './pdf.js';
import { openDoc } from './editor.js';
import { suggestNames } from './suggest.js';
import { sync } from './sync.js';

const SECTIONS = {
  docs: { label: 'Dokumente', icon: 'folder' },
  favorites: { label: 'Favoriten', icon: 'favorites' },
  recent: { label: 'Zuletzt geöffnet', icon: 'clock' },
  trash: { label: 'Papierkorb', icon: 'trash' },
};
const SORTS = [['date', 'Datum', 'Änderungsdatum'], ['created', 'Erstellt', 'Erstellungsdatum'], ['name', 'Name', 'Name']];

const lib = {
  section: settings.section || 'docs', folder: null,
  view: settings.view || 'grid', sort: settings.sort || 'date',
  query: '', selecting: false, selected: new Set(),
};
let records = [];
const root = $('#library');
const byId = id => records.find(r => r.id === id);
const live = () => records.filter(r => !r.deleted);

function folderPath(id) {
  const out = [];
  for (let f = byId(id); f; f = byId(f.parent)) out.unshift(f);
  return out;
}
const descendants = id => live().filter(r => r.parent === id).flatMap(r => [r, ...(r.kind === 'folder' ? descendants(r.id) : [])]);
const containsText = (r, q) => r.kind === 'notebook' && r.pages.some(p => (p.pdfText || '').toLowerCase().includes(q) || p.elements.some(e => e.type === 'text' && e.text.toLowerCase().includes(q)));

function items() {
  const all = live();
  let list;
  if (lib.query) {
    const q = lib.query.toLowerCase();
    list = all.filter(r => !r.trashed && (r.name.toLowerCase().includes(q) || containsText(r, q)));
  } else if (lib.section === 'recent') {
    return all.filter(r => !r.trashed && r.kind === 'notebook').sort((a, b) => (b.opened || b.updated) - (a.opened || a.updated)).slice(0, 30);
  } else if (lib.section === 'favorites') list = all.filter(r => !r.trashed && r.favorite);
  else if (lib.section === 'trash') list = all.filter(r => r.trashed && !r.trashedBy);
  else list = all.filter(r => !r.trashed && (r.parent || null) === lib.folder);
  const cmp = {
    date: (a, b) => b.updated - a.updated,
    created: (a, b) => (b.created || 0) - (a.created || 0),
    name: (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }),
  }[lib.sort];
  return list.sort((a, b) => (a.kind === b.kind ? cmp(a, b) : a.kind === 'folder' ? -1 : 1));
}

export async function renderLibrary() {
  records = await store.all();
  if (lib.folder && (!byId(lib.folder) || byId(lib.folder).trashed)) lib.folder = null;
  root.classList.toggle('sidebar-hidden', settings.sidebarHidden === true);
  renderSidebar();
  renderHeader();
  renderContent();
}
bus.addEventListener('change', () => { if (!root.hidden) renderLibrary(); });
bus.addEventListener('sync', () => { const s = $('#sbSync span'); if (s) s.textContent = settings.syncStatus || ''; });

function go(section, folder = null) {
  lib.section = section; lib.folder = folder; lib.query = '';
  lib.selecting = false; lib.selected.clear();
  settings.section = section; saveSettings();
  renderLibrary();
}

// ---------- Sidebar ----------
function renderSidebar() {
  const sb = $('#sidebar');
  const folders = live().filter(r => r.kind === 'folder' && !r.trashed && !r.parent).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const item = (key, s) => h('button', {
    class: 'sb-item' + (lib.section === key && !lib.folder && !lib.query ? ' active' : ''),
    'data-drop': key === 'docs' ? '' : null, // dropping on "Dokumente" moves to the top level
    onclick: () => go(key),
  }, icon(s.icon, 24), h('span', {}, s.label));
  sb.replaceChildren(
    h('div', { class: 'sb-head' }, h('img', { src: 'logo.png', alt: '', width: 32, height: 32 }), h('span', {}, 'Notizen')),
    h('nav', { class: 'sb-nav' },
      item('docs', SECTIONS.docs),
      ...folders.map(f => h('button', {
        class: 'sb-item sub' + (lib.folder && folderPath(lib.folder)[0]?.id === f.id ? ' active' : ''),
        'data-drop': f.id,
        onclick: () => go('docs', f.id),
      }, icon('folder', 20), h('span', {}, f.name))),
      item('favorites', SECTIONS.favorites),
      item('recent', SECTIONS.recent),
      h('div', { class: 'sb-sep' }),
      item('trash', SECTIONS.trash)),
    h('div', { class: 'sb-foot' },
      h('button', { id: 'sbSync', class: 'sb-sync', title: 'Jetzt synchronisieren', onclick: () => sync(true) },
        icon('sync', 16), h('span', {}, settings.syncStatus || (settings.clientId ? 'Synchronisieren' : 'Sync nicht eingerichtet')))));
}

// ---------- Header ----------
function renderHeader() {
  const head = $('#libHead');
  const path = lib.folder ? folderPath(lib.folder) : [];
  const title = lib.query ? 'Suche' : path.length ? path[path.length - 1].name : SECTIONS[lib.section].label;

  // Top row: search and settings, right-aligned (as in Goodnotes)
  const search = h('input', {
    class: 'searchfield', type: 'search', placeholder: 'Suchen', value: lib.query,
    oninput: e => { lib.query = e.target.value; renderContent(); renderHeaderTitle(); },
    onkeydown: e => { if (e.key === 'Escape') { lib.query = ''; lib.searchOpen = false; renderHeader(); renderContent(); } },
  });
  const top = h('div', { class: 'lib-top' },
    h('button', {
      class: 'iconbtn plain', title: 'Seitenleiste',
      onclick: () => { settings.sidebarHidden = !settings.sidebarHidden; saveSettings(); root.classList.toggle('sidebar-hidden', settings.sidebarHidden); },
    }, icon('sidebar', 22)),
    h('div', { class: 'spacer' }),
    lib.searchOpen || lib.query ? search : null,
    h('button', {
      class: 'iconbtn plain', title: 'Suchen',
      onclick: () => { lib.searchOpen = !(lib.searchOpen || lib.query); if (!lib.searchOpen) lib.query = ''; renderHeader(); renderContent(); if (lib.searchOpen) $('#libHead .searchfield').focus(); },
    }, icon('search', 22)),
    h('button', { class: 'iconbtn plain', title: 'Einstellungen', onclick: openSettings }, icon('gear', 22)));

  let right;
  if (lib.selecting) {
    const n = lib.selected.size, ids = [...lib.selected];
    right = [
      h('span', { class: 'sel-count' }, n === 1 ? '1 Objekt' : `${n} Objekte`),
      lib.section === 'trash'
        ? [h('button', { class: 'pill-btn', disabled: !n, onclick: () => restore(ids) }, 'Wiederherstellen'),
          h('button', { class: 'pill-btn danger', disabled: !n, onclick: () => purge(ids) }, 'Löschen')]
        : [h('button', { class: 'pill-btn', disabled: !n, onclick: () => moveItems(ids) }, icon('move', 18), 'Verschieben'),
          h('button', { class: 'pill-btn', disabled: !n, onclick: () => duplicate(ids) }, icon('copy', 18), 'Duplizieren'),
          h('button', { class: 'pill-btn danger', disabled: !n, onclick: () => trash(ids) }, icon('trash', 18), 'Löschen')],
      h('button', { class: 'pill-btn primary', onclick: () => { lib.selecting = false; lib.selected.clear(); renderHeader(); renderContent(); } }, 'Fertig'),
    ];
  } else {
    const sort = SORTS.find(s => s[0] === lib.sort) || SORTS[0];
    right = [
      lib.section === 'docs' && !lib.query
        ? h('button', { class: 'new-btn', onclick: e => newMenu(e.currentTarget) }, icon('plus', 20), h('span', {}, 'Neu'), icon('chevronDown', 16)) : null,
      lib.section === 'trash' && live().some(r => r.trashed)
        ? h('button', { class: 'pill-btn danger', onclick: () => purge(live().filter(r => r.trashed && !r.trashedBy).map(r => r.id)) }, 'Papierkorb leeren') : null,
      h('span', { class: 'head-sep' }),
      lib.section === 'recent' ? null : h('button', {
        class: 'pill-btn', title: 'Sortieren',
        onclick: e => menu(e.currentTarget, SORTS.map(([k, , l]) => ({
          label: l, checked: lib.sort === k, action: () => { lib.sort = k; settings.sort = k; saveSettings(); renderHeader(); renderContent(); },
        }))),
      }, h('span', {}, sort[1]), icon('chevronDown', 16)),
      h('button', {
        class: 'iconbtn plain', title: lib.view === 'grid' ? 'Listenansicht' : 'Rasteransicht',
        onclick: () => { lib.view = lib.view === 'grid' ? 'list' : 'grid'; settings.view = lib.view; saveSettings(); renderHeader(); renderContent(); },
      }, icon(lib.view === 'grid' ? 'list' : 'grid', 22)),
      h('button', { class: 'iconbtn plain', title: 'Auswählen', onclick: () => { lib.selecting = true; renderHeader(); renderContent(); } }, icon('selectCircle', 22)),
    ];
  }
  head.replaceChildren(top,
    h('div', { class: 'lib-titlebar' },
      h('div', { class: 'lib-title' },
        path.length && !lib.query ? h('button', { class: 'backbtn', title: 'Zurück', 'data-drop': path[path.length - 2]?.id || '', onclick: () => go('docs', path[path.length - 2]?.id || null) }, icon('chevronLeft', 26)) : null,
        h('h1', { id: 'libTitle' }, title)),
      h('div', { class: 'lib-actions' }, ...right.flat())));
}
function renderHeaderTitle() { $('#libTitle').textContent = lib.query ? 'Suche' : (lib.folder ? byId(lib.folder).name : SECTIONS[lib.section].label); }

// ---------- Content ----------
function thumbFor(r, width) {
  if (r.kind === 'folder') {
    const count = live().filter(x => x.parent === r.id && !x.trashed).length;
    return h('div', { class: 'folder-art' }, h('div', { class: 'folder-tab' }), h('div', { class: 'folder-body' }, h('span', {}, count || '')));
  }
  const c = h('canvas', { class: r.cover ? 'cover' : 'paper' });
  if (r.cover) renderCover(c, r.cover, width * 2);
  else if (r.pages[0]) renderThumb(c, r.pages[0], width * 2);
  return c;
}

// "25. Okt. 2026 um 13:38"
function sub(r) {
  const d = new Date(r.updated);
  return `${d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' })} um ${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderContent() {
  const content = $('#libContent');
  const list = items();
  const wrap = h('div', { class: lib.view === 'grid' ? 'lib-grid' : 'lib-list' });
  for (const r of list) wrap.append(lib.view === 'grid' ? tile(r) : row(r));
  const empty = !list.length && h('div', { class: 'empty' },
    lib.query ? 'Keine Treffer.' : lib.section === 'trash' ? 'Der Papierkorb ist leer.' : lib.section === 'favorites' ? 'Noch keine Favoriten. Markiere Dokumente über das ⌄-Menü.' : lib.section === 'recent' ? 'Noch keine Dokumente geöffnet.' : 'Hier ist noch nichts. Tippe oben auf „Neu“.');
  content.replaceChildren(list.length ? wrap : '', empty || '');
}

function activate(r) {
  if (lib.selecting) {
    lib.selected.has(r.id) ? lib.selected.delete(r.id) : lib.selected.add(r.id);
    renderHeader(); renderContent();
    return;
  }
  if (r.trashed) return itemMenu(r, null);
  if (r.kind === 'folder') go('docs', r.id);
  else openDoc(r.id);
}

function tile(r) {
  const chev = h('button', { class: 'chev', title: 'Optionen', onclick: e => { e.stopPropagation(); itemMenu(r, e.currentTarget); } }, icon('chevronDown', 16));
  const t = h('div', { class: 'tile' + (lib.selected.has(r.id) ? ' selected' : '') + (r.kind === 'folder' ? ' is-folder' : '') },
    h('button', { class: 'thumb', onclick: () => activate(r) }, thumbFor(r, 125),
      lib.selecting ? h('span', { class: 'checkmark' }, lib.selected.has(r.id) ? icon('check', 16) : '') : null,
      r.favorite ? h('span', { class: 'fav-badge' }, icon('starFill', 14)) : null),
    h('div', { class: 'tile-title' }, h('span', { title: r.name }, r.name), lib.selecting ? null : chev),
    h('div', { class: 'tile-sub' }, sub(r)));
  if (r.kind === 'folder' && !r.trashed) t.dataset.drop = r.id;
  dragToFolder(t, r);
  return t;
}

function row(r) {
  const el = h('div', { class: 'row' + (lib.selected.has(r.id) ? ' selected' : '') },
    h('button', { class: 'row-hit', onclick: () => activate(r) },
      h('div', { class: 'row-thumb' }, thumbFor(r, 40)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, r.name, r.favorite ? icon('starFill', 12) : ''),
        h('div', { class: 'row-sub' }, sub(r) + (r.kind === 'notebook' ? ` · ${r.pages.length} ${r.pages.length === 1 ? 'Seite' : 'Seiten'}` : ''))),
      lib.selecting ? h('span', { class: 'checkmark' }, lib.selected.has(r.id) ? icon('check', 16) : '') : null),
    lib.selecting ? null : h('button', { class: 'chev', title: 'Optionen', onclick: e => itemMenu(r, e.currentTarget) }, icon('chevronDown', 16)));
  if (r.kind === 'folder' && !r.trashed) el.dataset.drop = r.id;
  dragToFolder(el, r);
  return el;
}

// ---------- Drag into folders ----------
// Touch/pen: press ~0.45 s, then drag; releasing over a folder moves the item there.
// Releasing without dragging opens the item menu (the previous long-press behaviour).
// Mouse: drag right away; right-click opens the menu.
const LIFT_MS = 450;
function dragToFolder(el, r) {
  el.addEventListener('contextmenu', e => { e.preventDefault(); if (!drag) itemMenu(r, { x: e.clientX, y: e.clientY }); });
  if (r.trashed) return;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || drag || e.target.closest('.chev')) return;
    const st = { el, r, id: e.pointerId, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse', lifted: false };
    pending = st;
    if (!st.mouse) st.timer = setTimeout(() => lift(st, st.x, st.y), LIFT_MS);
  });
}

let pending = null, drag = null, swallowClick = false;
function lift(st, x, y) {
  if (pending !== st) return;
  pending = null;
  st.lifted = true; drag = st;
  navigator.vibrate?.(10);
  // Drag everything selected if the pressed item is part of the selection.
  st.ids = lib.selecting && lib.selected.has(st.r.id) ? [...lib.selected] : [st.r.id];
  const art = st.el.querySelector('canvas, .folder-art');
  const ghost = h('div', { class: 'drag-ghost' });
  if (art?.tagName === 'CANVAS') { const c = h('canvas'); c.width = art.width; c.height = art.height; c.getContext('2d').drawImage(art, 0, 0); ghost.append(c); }
  else if (art) ghost.append(art.cloneNode(true));
  ghost.append(h('span', {}, st.ids.length > 1 ? `${st.ids.length} Objekte` : st.r.name));
  document.body.append(ghost);
  st.ghost = ghost;
  st.el.classList.add('drag-source');
  moveGhost(x, y);
}
function moveGhost(x, y) {
  drag.ghost.style.transform = `translate(${x}px, ${y}px)`;
  const target = document.elementFromPoint(x, y)?.closest('[data-drop]');
  const valid = target && canDrop(target.dataset.drop || null);
  document.querySelectorAll('.drop-target').forEach(n => n !== target && n.classList.remove('drop-target'));
  if (valid) target.classList.add('drop-target');
  drag.target = valid ? target : null;
}
// No dropping into itself, into one of its own subfolders, or where it already is.
function canDrop(folderId) {
  return drag.ids.every(id => {
    if (id === folderId) return false;
    if (folderId && folderPath(folderId).some(f => f.id === id)) return false;
    return (byId(id).parent || null) !== folderId;
  });
}
async function endDrag(cancelled) {
  const st = drag; drag = null;
  st.ghost.remove();
  st.el.classList.remove('drag-source');
  document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
  swallowClick = true; setTimeout(() => { swallowClick = false; }, 50);
  if (cancelled) return;
  if (!st.target) {
    if (!st.moved && !st.mouse) itemMenu(st.r, { x: st.x, y: st.y }); // plain long press → menu
    return;
  }
  const folderId = st.target.dataset.drop || null;
  const now = Date.now();
  await store.putMany(st.ids.map(byId).map(x => Object.assign(x, { parent: folderId, updated: now })));
  lib.selecting = false; lib.selected.clear();
  toast(`Verschoben nach „${folderId ? byId(folderId).name : 'Dokumente'}“`);
}

document.addEventListener('pointermove', e => {
  if (pending && e.pointerId === pending.id) {
    const d = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
    if (pending.mouse && d > 6) lift(pending, e.clientX, e.clientY);
    else if (!pending.mouse && d > 10) { clearTimeout(pending.timer); pending = null; } // it's a scroll
  }
  if (drag && e.pointerId === drag.id) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = true;
    moveGhost(e.clientX, e.clientY);
  }
});
document.addEventListener('pointerup', e => {
  if (pending && e.pointerId === pending.id) { clearTimeout(pending.timer); pending = null; }
  if (drag && e.pointerId === drag.id) endDrag(false);
});
document.addEventListener('pointercancel', e => {
  if (pending && e.pointerId === pending.id) { clearTimeout(pending.timer); pending = null; }
  if (drag && e.pointerId === drag.id) endDrag(true);
});
// While dragging, stop the page from scrolling under the finger.
document.addEventListener('touchmove', e => { if (drag) e.preventDefault(); }, { passive: false });
// The click that ends a drag must not open the item.
document.addEventListener('click', e => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);

// ---------- Menus ----------
function newMenu(anchor) {
  menu(anchor, [
    { label: 'Notizbuch', icon: 'doc', action: newNotebookSheet },
    { label: 'Schnellnotiz', icon: 'quick', action: quickNote },
    { label: 'Ordner', icon: 'folder', action: createFolder },
    '-',
    { label: 'PDF importieren', icon: 'pdf', action: importPdf },
    { label: 'PDF aus Zwischenablage', icon: 'paste', action: importFromClipboard },
    { label: 'Bild importieren', icon: 'image', action: importImage },
  ]);
}

function itemMenu(r, anchor) {
  const at = anchor || { x: innerWidth / 2, y: innerHeight / 2 };
  if (r.trashed) {
    return menu(at, [
      { label: 'Wiederherstellen', icon: 'restore', action: () => restore([r.id]) },
      { label: 'Endgültig löschen', icon: 'trash', danger: true, action: () => purge([r.id]) },
    ]);
  }
  const nb = r.kind === 'notebook';
  menu(at, [
    nb && { label: 'Öffnen', icon: 'doc', action: () => openDoc(r.id) },
    { label: 'Umbenennen', icon: 'rename', action: () => rename(r) },
    nb && { label: 'Duplizieren', icon: 'copy', action: () => duplicate([r.id]) },
    { label: 'Verschieben', icon: 'move', action: () => moveItems([r.id]) },
    { label: r.favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten', icon: r.favorite ? 'starFill' : 'star', action: () => update(r, { favorite: !r.favorite }) },
    nb && { label: 'Cover ändern', icon: 'palette', action: () => changeCover(r) },
    nb && { label: 'Als PDF exportieren', icon: 'share', action: () => exportPdf(r) },
    '-',
    { label: 'In Papierkorb', icon: 'trash', danger: true, action: () => trash([r.id]) },
  ]);
}

// ---------- Actions ----------
async function update(r, patch) { Object.assign(r, patch, { updated: Date.now() }); await store.put(r); }

async function rename(r) {
  const name = await promptText('Umbenennen', r.name, '', r.kind === 'notebook' ? suggestNames(r) : []);
  if (name) update(r, { name });
}

async function duplicate(ids) {
  const copies = ids.map(byId).filter(r => r?.kind === 'notebook').map(r => cloneNotebook(r, r.name + ' Kopie'));
  if (!copies.length) return toast('Ordner können nicht dupliziert werden');
  await store.putMany(copies);
  lib.selecting = false; lib.selected.clear();
  toast(copies.length === 1 ? 'Dupliziert' : `${copies.length} Dokumente dupliziert`);
}

// Folder picker sheet. Resolves to a folder id, null for the top level, or undefined when cancelled.
async function pickFolder(title, doneLabel, { exclude = new Set(), preselect } = {}) {
  records = await store.all();
  const folders = live().filter(r => r.kind === 'folder' && !r.trashed && !exclude.has(r.id));
  let target = preselect;
  const tree = (parent, depth) => folders.filter(f => (f.parent || null) === parent).sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .flatMap(f => [opt(f.id, f.name, depth), ...tree(f.id, depth + 1)]);
  const list = h('div', { class: 'pick-list' });
  function opt(id, name, depth) {
    return h('button', {
      class: 'pick-item' + (id === preselect ? ' active' : ''), style: { paddingLeft: 14 + depth * 22 + 'px' },
      onclick: e => { target = id; list.querySelectorAll('.pick-item').forEach(b => b.classList.toggle('active', b === e.currentTarget)); },
    }, icon('folder', 18), h('span', {}, name));
  }
  list.append(opt(null, 'Dokumente', 0), ...tree(null, 1));
  const ok = await sheet({ title, body: list, done: doneLabel, onDone: () => target !== undefined || (toast('Bitte einen Ordner wählen'), false) });
  return ok ? target : undefined;
}

async function moveItems(ids) {
  const moving = new Set(ids.flatMap(id => [id, ...descendants(id).map(d => d.id)]));
  const target = await pickFolder('Verschieben nach', 'Verschieben', { exclude: moving });
  if (target === undefined) return;
  const now = Date.now();
  await store.putMany(ids.map(byId).map(r => Object.assign(r, { parent: target, updated: now })));
  lib.selecting = false; lib.selected.clear();
  toast('Verschoben');
}

async function trash(ids) {
  const now = Date.now(), recs = [];
  for (const id of ids) {
    const r = byId(id);
    recs.push(Object.assign(r, { trashed: now, trashedBy: null, updated: now }));
    for (const d of descendants(id)) if (!d.trashed) recs.push(Object.assign(d, { trashed: now, trashedBy: id, updated: now }));
  }
  await store.putMany(recs);
  lib.selecting = false; lib.selected.clear();
  toast(ids.length === 1 ? 'In den Papierkorb gelegt' : `${ids.length} Objekte in den Papierkorb gelegt`);
}

async function restore(ids) {
  const now = Date.now(), recs = [];
  for (const id of ids) {
    const r = byId(id);
    const parent = byId(r.parent);
    recs.push(Object.assign(r, { trashed: null, updated: now, parent: parent && !parent.trashed ? r.parent : null }));
    for (const d of live().filter(x => x.trashedBy === id)) recs.push(Object.assign(d, { trashed: null, trashedBy: null, updated: now }));
  }
  await store.putMany(recs);
  lib.selecting = false; lib.selected.clear();
  toast('Wiederhergestellt');
}

async function purge(ids) {
  if (!ids.length) return;
  if (!await confirmBox(ids.length === 1 ? 'Endgültig löschen?' : `${ids.length} Objekte endgültig löschen?`, 'Das kann nicht rückgängig gemacht werden.', 'Löschen', true)) return;
  const now = Date.now();
  // Tombstones, so the deletion propagates through sync.
  const gone = ids.flatMap(id => [byId(id), ...live().filter(x => x.trashedBy === id)]);
  await store.putMany(gone.map(r => ({ kind: r.kind, id: r.id, name: r.name, deleted: true, updated: now, pages: [] })));
  lib.selecting = false; lib.selected.clear();
}

async function changeCover(r) {
  let cover = r.cover;
  const body = coverPicker(r.cover, v => { cover = v; });
  if (await sheet({ title: 'Cover ändern', body })) update(r, { cover });
}

function coverPicker(value, onChange) {
  const wrap = h('div', { class: 'cover-grid' });
  const render = v => wrap.replaceChildren(
    h('button', { class: 'cover-opt none' + (!v ? ' active' : ''), title: 'Ohne Cover', onclick: () => { onChange(null); render(null); } }, h('span', {}, 'Kein')),
    ...COVERS.map(c => {
      const cv = h('canvas'); renderCover(cv, c, 88);
      return h('button', { class: 'cover-opt' + (v === c ? ' active' : ''), onclick: () => { onChange(c); render(c); } }, cv);
    }));
  render(value);
  return wrap;
}

function templatePicker(value, onChange, h0 = 1414) {
  const wrap = h('div', { class: 'tmpl-grid' });
  const render = v => wrap.replaceChildren(...Object.entries(TEMPLATES).map(([k, label]) => {
    const cv = h('canvas'); renderThumb(cv, { template: k, h: h0, elements: [] }, 140);
    return h('button', { class: 'tmpl-opt' + (v === k ? ' active' : ''), onclick: () => { onChange(k); render(k); } }, cv, h('span', {}, label));
  }));
  render(value);
  return wrap;
}
export { templatePicker };

// Two-column "new notebook" window modelled on Goodnotes: title and previews of
// cover and paper on the left, a gallery for whichever of the two is selected on the right.
const COVER_NAMES = ['Marine', 'Blau', 'Petrol', 'Grün', 'Senf', 'Orange', 'Rot', 'Beere', 'Violett', 'Graphit', 'Grau', 'Sand'];
const coverName = c => c ? COVER_NAMES[COVERS.indexOf(c)] || 'Eigene Farbe' : 'Kein Umschlag';

function newNotebookSheet() {
  const o = {
    name: '', cover: settings.lastCover === undefined ? COVERS[1] : settings.lastCover,
    template: settings.lastTemplate in TEMPLATES ? settings.lastTemplate : 'lined',
    paper: settings.lastPaper || 'white', format: 'a4', orient: 'portrait', panel: 'paper',
  };
  const collapsed = new Set();
  const pageHeight = () => {
    const base = FORMATS[o.format].h;
    return o.orient === 'landscape' ? Math.round(PAGE_W * PAGE_W / base) : base;
  };
  const samplePage = template => ({ template, h: pageHeight(), paper: o.paper, elements: [] });

  const back = h('div', { class: 'backdrop' });
  const close = () => { document.removeEventListener('keydown', onKey); back.classList.add('closing'); setTimeout(() => back.remove(), 200); };
  const create = async () => {
    settings.lastCover = o.cover; settings.lastTemplate = o.template; settings.lastPaper = o.paper; saveSettings();
    const nb = newNotebook({
      name: o.name.trim() || 'Unbenanntes Notizbuch', cover: o.cover,
      parent: lib.section === 'docs' ? lib.folder : null,
      pages: [newPage(o.template, pageHeight(), o.paper)],
    });
    close();
    await store.put(nb);
    openDoc(nb.id);
  };
  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); create(); }
  };
  document.addEventListener('keydown', onKey);

  const title = h('input', { class: 'field', placeholder: 'Unbenanntes Notizbuch', oninput: e => { o.name = e.target.value; } });
  const left = h('div', { class: 'nb-left' });
  const filters = h('div', { class: 'nb-filters' });
  const gallery = h('div', { class: 'nb-gallery' });

  function previewCard(panel, label, canvas, caption) {
    return [h('div', { class: 'nb-label' }, label),
      h('button', { class: 'nb-card' + (o.panel === panel ? ' active' : ''), onclick: () => { o.panel = panel; render(); } }, canvas, h('span', {}, caption))];
  }
  function renderLeft() {
    const cover = h('canvas');
    if (o.cover) renderCover(cover, o.cover, 220, 286); else renderThumb(cover, samplePage(o.template), 220);
    const paper = h('canvas');
    renderThumb(paper, samplePage(o.template), 220);
    left.replaceChildren(
      h('div', { class: 'nb-label' }, 'Titel'), title,
      ...previewCard('cover', 'Umschlag', cover, coverName(o.cover)),
      ...previewCard('paper', 'Papier', paper, TEMPLATES[o.template]));
  }

  const dropdown = (label, items) => h('button', { class: 'pill-btn', onclick: e => menu(e.currentTarget, items) }, h('span', {}, label), icon('chevronDown', 16));
  function renderFilters() {
    if (o.panel === 'cover') {
      filters.replaceChildren(h('div', { class: 'nb-filter-title' }, 'Umschlag wählen'));
      return;
    }
    const set = (k, v) => () => { o[k] = v; render(); };
    filters.replaceChildren(
      dropdown(FORMATS[o.format].label.replace(' Hoch', ''), [['a4', 'A4'], ['letter', 'Letter']].map(([k, l]) => ({ label: l, checked: o.format === k, action: set('format', k) }))),
      dropdown(PAPERS[o.paper].label, Object.entries(PAPERS).map(([k, p]) => ({ label: p.label, swatch: p.color, action: set('paper', k) }))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'nb-orient', role: 'group', 'aria-label': 'Ausrichtung' },
        h('button', { class: o.orient === 'portrait' ? 'active' : '', title: 'Hochformat', onclick: set('orient', 'portrait') }, icon('portrait', 20)),
        h('button', { class: o.orient === 'landscape' ? 'active' : '', title: 'Querformat', onclick: set('orient', 'landscape') }, icon('landscape', 20))));
  }

  function section(name, tiles) {
    const open = !collapsed.has(name);
    return h('section', { class: 'nb-section' },
      h('button', { class: 'nb-section-head' + (open ? '' : ' collapsed'), onclick: () => { open ? collapsed.add(name) : collapsed.delete(name); renderGallery(); } },
        icon('chevronDown', 16), name),
      open ? h('div', { class: 'nb-grid' + (o.orient === 'landscape' && o.panel === 'paper' ? ' landscape' : '') }, tiles) : null);
  }
  function tileBtn(active, canvas, label, onclick) {
    return h('button', { class: 'nb-tile' + (active ? ' active' : ''), onclick }, h('div', { class: 'nb-tile-art' }, canvas), h('span', {}, label));
  }
  function renderGallery() {
    const top = gallery.scrollTop;
    if (o.panel === 'paper') {
      gallery.replaceChildren(...TEMPLATE_SECTIONS.map(([name, keys]) => section(name, keys.map(k => {
        const cv = h('canvas'); renderThumb(cv, samplePage(k), 200);
        return tileBtn(o.template === k, cv, TEMPLATES[k], () => { o.template = k; renderLeft(); renderGallery(); });
      }))));
    } else {
      const none = h('canvas'); renderThumb(none, samplePage(o.template), 200);
      gallery.replaceChildren(
        section('Einfach', COVERS.map((c, i) => {
          const cv = h('canvas'); renderCover(cv, c, 200, 260);
          return tileBtn(o.cover === c, cv, COVER_NAMES[i], () => { o.cover = c; renderLeft(); renderGallery(); });
        })),
        section('Ohne Umschlag', [tileBtn(!o.cover, none, 'Kein Umschlag', () => { o.cover = null; renderLeft(); renderGallery(); })]));
    }
    gallery.scrollTop = top;
  }
  function render() { renderLeft(); renderFilters(); renderGallery(); }

  back.append(h('div', { class: 'nb-dialog', role: 'dialog', 'aria-label': 'Neues Notizbuch' },
    left,
    h('div', { class: 'nb-right' }, filters, gallery),
    h('div', { class: 'nb-foot' },
      h('button', { class: 'pill-btn', onclick: close }, 'Abbrechen'),
      h('button', { class: 'pill-btn primary', onclick: create }, 'Notizbuch erstellen'))));
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  render();
  document.body.append(back);
  title.focus();
}

async function quickNote() {
  const nb = newNotebook({ name: 'Schnellnotiz ' + new Date().toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }), template: 'lined', parent: lib.folder });
  await store.put(nb);
  openDoc(nb.id);
}

async function createFolder() {
  const name = await promptText('Neuer Ordner', '', 'Ordnername');
  if (!name) return;
  await store.put(newFolder(name, lib.section === 'docs' ? lib.folder : null));
}

async function importPdf() {
  const f = await pickFile('application/pdf');
  if (f) importPdfFile(f);
}

// Shared PDF import (file picker, drag & drop, clipboard): ask where to save, then convert and open.
export async function importPdfFile(file, name = file.name) {
  const title = (name || 'Importiertes PDF').replace(/\.pdf$/i, '');
  const parent = await pickFolder(`„${title}“ speichern in`, 'Speichern', { preselect: lib.section === 'docs' ? lib.folder : null });
  if (parent === undefined) return;
  try {
    const nb = newNotebook({ name: title, parent, pages: await pdfToPages(file) });
    await store.put(nb);
    openDoc(nb.id);
  } catch (err) { toast('Import fehlgeschlagen: ' + err.message, 5000); }
}

// Clipboard import. Two kinds of content are understood:
// - a copied PDF *file* (e.g. Goodnotes "Exportieren → Kopieren", Files "Kopieren")
// - text from the iOS shortcut "In Notizen öffnen": "NOTIZEN-PDF|<file name>|<base64>" (or plain base64)
// Safari's clipboard API only hands out text and images, so for files we fall back to a paste
// field: the system "Einfügen" (long press / Cmd+V) does deliver copied files to the page.
const looksLikePdf = f => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));

async function pdfFromText(text) {
  let name = 'Importiertes PDF', b64 = (text || '').trim();
  const m = b64.match(/^NOTIZEN-PDF\|([^|]*)\|([\s\S]+)$/);
  if (m) { name = m[1] || name; b64 = m[2]; }
  b64 = b64.replace(/\s+/g, '');
  if (!b64.startsWith('JVBER')) return null; // "%PDF" in base64
  return { blob: await (await fetch('data:application/pdf;base64,' + b64)).blob(), name };
}

async function pdfFromClipboardAPI() {
  try {
    for (const item of await navigator.clipboard.read()) {
      if (item.types.includes('application/pdf')) return { blob: await item.getType('application/pdf'), name: 'Eingefügtes PDF' };
      if (item.types.includes('text/plain')) {
        const r = await pdfFromText(await (await item.getType('text/plain')).text());
        if (r) return r;
      }
    }
  } catch {}
  try { return await pdfFromText(await navigator.clipboard.readText()); } catch { return null; }
}

function gotPdf({ blob, name }) {
  if (!settings.clipImport) { settings.clipImport = true; saveSettings(); } // from now on offer it when the app is opened
  importPdfFile(blob, name);
}

export async function importFromClipboard() {
  const direct = await pdfFromClipboardAPI();
  if (direct) return gotPdf(direct);
  pasteSheet();
}

// Paste field: tap it, then "Einfügen" from the iOS menu (or Cmd/Ctrl+V).
function pasteSheet() {
  const zone = h('div', {
    class: 'paste-zone', contenteditable: 'true', role: 'textbox', 'aria-label': 'Hier einfügen',
    'data-placeholder': 'Hier tippen und „Einfügen“ wählen',
  });
  let close;
  zone.addEventListener('paste', async e => {
    e.preventDefault();
    const files = [...(e.clipboardData?.files || [])];
    const items = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile());
    const pdf = [...files, ...items].find(looksLikePdf);
    if (pdf) { close(); return gotPdf({ blob: pdf, name: pdf.name || 'Eingefügtes PDF' }); }
    const fromText = await pdfFromText(e.clipboardData?.getData('text/plain'));
    if (fromText) { close(); return gotPdf(fromText); }
    const kinds = [...(e.clipboardData?.types || [])].join(', ') || 'nichts';
    zone.textContent = '';
    toast(`Keine PDF gefunden (Zwischenablage enthält: ${kinds})`, 5000);
  });
  zone.addEventListener('input', () => { zone.textContent = ''; });
  const body = h('div', { class: 'form' },
    zone,
    h('div', { class: 'hint' }, 'Kopiere vorher die PDF, z. B. in Goodnotes über Exportieren → PDF → Kopieren oder in der Dateien-App über Kopieren.'));
  const p = sheet({ title: 'PDF einfügen', body, done: null });
  // Close through the sheet's own cancel button so its listeners are cleaned up.
  close = () => zone.closest('.sheet')?.querySelector('.sheet-head .textbtn')?.click();
  setTimeout(() => zone.focus(), 300);
  return p;
}

async function importImage() {
  const f = await pickFile('image/*');
  if (!f) return;
  const img = await loadImageFile(f);
  const page = newPage('blank', Math.round(PAGE_W * img.h / img.w));
  page.bg = img.src;
  const nb = newNotebook({ name: f.name.replace(/\.[^.]+$/, ''), parent: lib.section === 'docs' ? lib.folder : null, pages: [page] });
  await store.put(nb);
  openDoc(nb.id);
}

// ---------- Settings ----------
export function applyTheme() {
  const t = settings.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

export async function openSettings() {
  const clientId = h('input', { class: 'field', value: settings.clientId || '', placeholder: 'xxxx.apps.googleusercontent.com' });
  const body = h('div', { class: 'form' },
    h('div', { class: 'form-label' }, 'Darstellung'),
    segmented([['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']], settings.theme || 'system', v => { settings.theme = v; saveSettings(); applyTheme(); }),
    h('div', { class: 'form-label' }, 'Stift'),
    h('div', { class: 'group-box' },
      toggle('Nur mit Stift zeichnen', !settings.fingerDraw, v => { settings.fingerDraw = !v; saveSettings(); }),
      h('div', { class: 'hint' }, 'An: Finger scrollen und zoomen, nur der Apple Pencil zeichnet.')),
    h('div', { class: 'form-label' }, 'Google-Drive-Synchronisation'),
    clientId,
    h('div', { class: 'hint' }, 'OAuth-Client-ID aus der Google Cloud Console (siehe README).'),
    h('div', { class: 'hint', style: { marginTop: '14px', textAlign: 'center' } }, `Notizen · Version ${APP_VERSION}`));
  const ok = await sheet({ title: 'Einstellungen', body });
  if (ok) { settings.clientId = clientId.value.trim(); saveSettings(); renderSidebar(); }
}
