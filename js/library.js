import { $, h, fmtDate, pickFile } from './util.js';
import { icon, folioMark } from './icons.js';
import { store, settings, saveSettings, bus, newNotebook, newFolder, cloneNotebook, newPage, COVERS, TEMPLATES, TEMPLATE_SECTIONS, PAPERS, FORMATS, PAGE_W, APP_VERSION } from './store.js';
import { renderCover, renderThumb } from './render.js';
import { menu, sheet, promptText, confirmBox, toast, segmented, toggle } from './ui.js';
import { pdfToPages, loadImageFile, exportPdf } from './pdf.js';
import { openDoc } from './editor.js';
import { suggestNames } from './suggest.js';
import { sync, signIn, signOut, signedIn } from './sync.js';
import { newTextDoc, openTextDoc, renderTextThumb, plainText, printDoc } from './textdoc.js';
import { renderCalendar, CAL_KINDS } from './calendar.js';

const SECTIONS = {
  docs: { label: 'Alle Notizen', icon: 'notes' },
  favorites: { label: 'Favoriten', icon: 'favorites' },
  recent: { label: 'Zuletzt geöffnet', icon: 'clock' },
  trash: { label: 'Papierkorb', icon: 'trash' },
  calendar: { label: 'Kalender', icon: 'calendar' },
};
const SORTS = [['date', 'Datum', 'Änderungsdatum'], ['created', 'Erstellt', 'Erstellungsdatum'], ['name', 'Name', 'Name']];

const lib = {
  section: settings.section || 'docs', folder: null,
  view: settings.view || 'grid', sort: settings.sort || 'date',
  query: '', selecting: false, selected: new Set(), filter: settings.filter || 'all',
};
let records = [];
const root = $('#library');
const compactLibrary = matchMedia('(max-width: 700px)');
let mobileSidebarOpen = false;
const sidebarBackdrop = h('button', {
  class: 'sidebar-backdrop', type: 'button', hidden: true, tabindex: '-1',
  'aria-label': 'Navigation schließen', onclick: () => setMobileSidebar(false),
});
root.append(sidebarBackdrop);

function updateSidebar() {
  const modal = compactLibrary.matches && mobileSidebarOpen;
  const hidden = compactLibrary.matches ? !modal : settings.sidebarHidden === true;
  root.classList.toggle('sidebar-hidden', hidden);
  root.classList.toggle('sidebar-open', modal);
  sidebarBackdrop.hidden = !modal;
  const sidebar = $('#sidebar');
  sidebar.inert = hidden;
  sidebar.setAttribute('aria-hidden', String(hidden));
  sidebar.setAttribute('aria-label', 'Bibliotheksnavigation');
  if (modal) {
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
  } else {
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
  }
  $('.lib-main', root).inert = modal;
  $('#sidebarToggle')?.setAttribute('aria-expanded', String(!hidden));
}
function setMobileSidebar(open) {
  mobileSidebarOpen = open;
  updateSidebar();
  $(open ? '#sidebarClose' : '#sidebarToggle')?.focus();
}
function toggleSidebar() {
  if (compactLibrary.matches) return setMobileSidebar(!mobileSidebarOpen);
  settings.sidebarHidden = !settings.sidebarHidden;
  saveSettings(); updateSidebar();
}
compactLibrary.addEventListener('change', () => {
  mobileSidebarOpen = false;
  updateSidebar();
});
document.addEventListener('keydown', e => {
  if (root.hidden || !compactLibrary.matches || !mobileSidebarOpen || document.querySelector('.backdrop, .popover')) return;
  if (e.key === 'Escape') { e.preventDefault(); setMobileSidebar(false); }
  if (e.key !== 'Tab') return;
  const buttons = [...$('#sidebar').querySelectorAll('button:not(:disabled), a[href], input, [tabindex="0"]')];
  const first = buttons[0], last = buttons[buttons.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
});
const byId = id => records.find(r => r.id === id);
const live = () => records.filter(r => !r.deleted);

function folderPath(id) {
  const out = [];
  for (let f = byId(id); f; f = byId(f.parent)) out.unshift(f);
  return out;
}
const descendants = id => live().filter(r => r.parent === id).flatMap(r => [r, ...(r.kind === 'folder' ? descendants(r.id) : [])]);
const containsText = (r, q) => r.kind === 'textdoc' ? plainText(r).toLowerCase().includes(q) : r.kind === 'notebook' && r.pages.some(p => (p.pdfText || '').toLowerCase().includes(q) || p.elements.some(e => e.type === 'text' && e.text.toLowerCase().includes(q)));

const kindOk = r => lib.filter === 'all' || r.kind === lib.filter; // filter tabs

function items() {
  const all = live();
  let list;
  if (lib.query) {
    const q = lib.query.toLowerCase();
    list = all.filter(r => !r.trashed && (r.name.toLowerCase().includes(q) || containsText(r, q)));
  } else if (lib.section === 'recent') {
    return all.filter(r => !r.trashed && r.kind !== 'folder' && kindOk(r)).sort((a, b) => (b.opened || b.updated) - (a.opened || a.updated)).slice(0, 30);
  } else if (lib.section === 'favorites') list = all.filter(r => !r.trashed && r.favorite);
  else if (lib.section === 'trash') list = all.filter(r => r.trashed && !r.trashedBy);
  else list = all.filter(r => !r.trashed && (r.parent || null) === lib.folder);
  const cmp = {
    date: (a, b) => b.updated - a.updated,
    created: (a, b) => (b.created || 0) - (a.created || 0),
    name: (a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }),
  }[lib.sort];
  return list.filter(kindOk).sort((a, b) => (a.kind === b.kind ? cmp(a, b) : a.kind === 'folder' ? -1 : 1));
}

export async function renderLibrary() {
  records = (await store.all()).filter(r => !CAL_KINDS.has(r.kind)); // calendar records live in the calendar view
  if (lib.folder && (!byId(lib.folder) || byId(lib.folder).trashed)) lib.folder = null;
  renderSidebar();
  if (lib.section === 'calendar') {
    $('#libHead').replaceChildren(h('div', { class: 'lib-titlebar' }, sidebarBtn(), h('div', { class: 'lib-title' }, h('h1', { id: 'libTitle' }, 'Kalender'))));
    updateSidebar();
    return renderCalendar($('#libHead'), $('#libContent'));
  }
  renderHeader();
  renderContent();
  updateSidebar();
}
const sidebarBtn = () => h('button', {
  class: 'iconbtn plain', title: 'Seitenleiste', 'aria-label': 'Seitenleiste',
  id: 'sidebarToggle', 'aria-controls': 'sidebar',
  'aria-expanded': String(compactLibrary.matches ? mobileSidebarOpen : !settings.sidebarHidden), onclick: toggleSidebar,
}, icon('sidebar', 20));
bus.addEventListener('change', () => { if (!root.hidden) renderLibrary(); });
bus.addEventListener('sync', () => { const s = $('#sbStatus'); if (s) s.textContent = settings.syncStatus || 'Synchronisieren'; });
bus.addEventListener('account', () => renderSidebar());

function go(section, folder = null) {
  mobileSidebarOpen = false;
  lib.section = section; lib.folder = folder; lib.query = '';
  lib.selecting = false; lib.selected.clear();
  settings.section = section; saveSettings();
  renderLibrary();
}

// ---------- Sidebar ----------
// Folder dots cycle through the brand's quiet colours
// Folder look: colour from the Folio palette (or any custom colour) and an optional symbol.
// Folders without a colour keep the default sage (theme variable, so dark mode still fits).
const FOLDER_ICONS = ['book', 'school', 'work', 'idea', 'flask', 'music', 'heart', 'code', 'calendar', 'home', 'star', 'camera', 'palette', 'doc'];
const folderColor = f => (/^#[0-9a-f]{6}$/i.test(f?.color || '') ? f.color : 'var(--sage)');
const folderIcon = f => (FOLDER_ICONS.includes(f?.icon) ? f.icon : null);
// dark ink on light folder colours, white on dark ones
function folderInk(c) {
  if (!c.startsWith('#')) return 'rgba(255, 255, 255, .95)';
  const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(v => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4));
  return .2126 * r + .7152 * g + .0722 * b > .45 ? 'rgba(15, 39, 71, .85)' : 'rgba(255, 255, 255, .95)';
}
function folderArt(f, count) {
  const c = folderColor(f);
  return h('div', { class: 'folder-art', style: { '--fc': c, '--fi': folderInk(c) } }, h('div', { class: 'folder-tab' }),
    h('div', { class: 'folder-body' }, folderIcon(f) ? h('i', { class: 'folder-icon' }, icon(folderIcon(f), 26)) : null, h('span', {}, count || '')));
}
function renderSidebar() {
  const sb = $('#sidebar');
  const folders = live().filter(r => r.kind === 'folder' && !r.trashed && !r.parent).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const item = (key, s) => h('button', {
    class: 'sb-item' + (lib.section === key && !lib.folder && !lib.query ? ' active' : ''),
    'data-drop': key === 'docs' ? '' : null, // dropping on "Alle Notizen" moves to the top level
    onclick: () => go(key),
  }, icon(s.icon, 20), h('span', {}, s.label));
  sb.replaceChildren(
    h('div', { class: 'sb-head' }, folioMark(30), h('span', {}, 'Folio'),
      h('button', { id: 'sidebarClose', class: 'iconbtn plain sidebar-close', type: 'button',
        title: 'Navigation schließen', 'aria-label': 'Navigation schließen', onclick: () => setMobileSidebar(false) }, icon('close', 20))),
    h('nav', { class: 'sb-nav' },
      item('docs', SECTIONS.docs),
      item('recent', SECTIONS.recent),
      item('favorites', SECTIONS.favorites),
      item('trash', SECTIONS.trash),
      item('calendar', SECTIONS.calendar),
      folders.length ? h('div', { class: 'sb-label' }, 'Ordner') : null,
      ...folders.map(f => h('button', {
        class: 'sb-item sub' + (lib.folder && folderPath(lib.folder)[0]?.id === f.id ? ' active' : ''),
        'data-drop': f.id,
        onclick: () => go('docs', f.id),
      }, folderIcon(f)
        ? h('i', { class: 'sb-ficon', style: { color: folderColor(f) } }, icon(folderIcon(f), 18))
        : h('i', { class: 'sb-dot', style: { background: folderColor(f) } }), h('span', {}, f.name)))),
    h('div', { class: 'sb-foot' },
      signedIn()
        ? h('button', { id: 'sbSync', class: 'sb-sync', title: 'Jetzt synchronisieren', onclick: () => sync(true) },
          h('span', { class: 'sb-avatar' }, (settings.account?.name || settings.account?.email || 'G')[0].toUpperCase()),
          h('span', { class: 'sb-acc' },
            h('b', {}, settings.account?.name || settings.account?.email || 'Google Drive'),
            h('span', { id: 'sbStatus' }, settings.syncStatus || 'Synchronisieren')))
        : h('button', { class: 'sb-signin', onclick: signIn }, googleG(), h('span', {}, 'Mit Google anmelden')),
      h('button', { class: 'sb-gear', title: 'Einstellungen', 'aria-label': 'Einstellungen', onclick: () => { if (compactLibrary.matches) setMobileSidebar(false); openSettings(); } }, icon('gear', 18))));
}
// Google's "G" (official brand colours, as Google's sign-in guidelines ask for on sign-in buttons)
function googleG() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('width', 18); s.setAttribute('height', 18); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>';
  return s;
}

// ---------- Header ----------
const FILTERS = [['all', 'Alle'], ['notebook', 'Notizbücher'], ['textdoc', 'Textdokumente'], ['folder', 'Ordner']];
function renderHeader() {
  const head = $('#libHead');
  const path = lib.folder ? folderPath(lib.folder) : [];
  const title = lib.query ? 'Suche' : path.length ? path[path.length - 1].name : SECTIONS[lib.section].label;

  const search = h('input', {
    class: 'searchfield', type: 'search', placeholder: 'Notizen durchsuchen…', value: lib.query, 'aria-label': 'Suchen',
    oninput: e => { lib.query = e.target.value; renderContent(); renderHeaderTitle(); },
    onkeydown: e => { if (e.key === 'Escape') { lib.query = ''; e.target.value = ''; e.target.blur(); renderContent(); renderHeaderTitle(); } },
  });
  const titlebar = h('div', { class: 'lib-titlebar' },
    sidebarBtn(),
    h('div', { class: 'lib-title' },
      path.length && !lib.query ? h('button', { class: 'backbtn', title: 'Zurück', 'data-drop': path[path.length - 2]?.id || '', onclick: () => go('docs', path[path.length - 2]?.id || null) }, icon('chevronLeft', 24)) : null,
      h('h1', { id: 'libTitle' }, title)),
    search,
    lib.section === 'docs' && !lib.query
      ? h('button', { class: 'fab', title: 'Neu', 'aria-label': 'Neu', onclick: e => newMenu(e.currentTarget) }, icon('plus', 22)) : null);

  let right;
  if (lib.selecting) {
    const n = lib.selected.size, ids = [...lib.selected];
    right = [
      h('span', { class: 'sel-count' }, n === 1 ? '1 Objekt' : `${n} Objekte`),
      lib.section === 'trash'
        ? [h('button', { class: 'pill-btn', disabled: !n, onclick: () => restore(ids) }, 'Wiederherstellen'),
          h('button', { class: 'pill-btn danger', disabled: !n, onclick: () => purge(ids) }, 'Löschen')]
        : [h('button', { class: 'pill-btn', disabled: !n, onclick: () => moveItems(ids) }, icon('move', 16), 'Verschieben'),
          h('button', { class: 'pill-btn', disabled: !n, onclick: () => duplicate(ids) }, icon('copy', 16), 'Duplizieren'),
          h('button', { class: 'pill-btn danger', disabled: !n, onclick: () => trash(ids) }, icon('trash', 16), 'Löschen')],
      h('button', { class: 'pill-btn primary', onclick: () => { lib.selecting = false; lib.selected.clear(); renderHeader(); renderContent(); } }, 'Fertig'),
    ];
  } else {
    const sort = SORTS.find(s => s[0] === lib.sort) || SORTS[0];
    const setView = v => { lib.view = v; settings.view = v; saveSettings(); renderHeader(); renderContent(); };
    right = [
      lib.section === 'trash' && live().some(r => r.trashed)
        ? h('button', { class: 'pill-btn danger', onclick: () => purge(live().filter(r => r.trashed && !r.trashedBy).map(r => r.id)) }, 'Papierkorb leeren') : null,
      lib.section === 'recent' ? null : h('button', {
        class: 'pill-btn', title: 'Sortieren',
        onclick: e => menu(e.currentTarget, SORTS.map(([k, , l]) => ({
          label: l, checked: lib.sort === k, action: () => { lib.sort = k; settings.sort = k; saveSettings(); renderHeader(); renderContent(); },
        }))),
      }, icon('sort', 16), h('span', {}, sort[1])),
      h('div', { class: 'seg-icons' },
        h('button', { class: lib.view === 'grid' ? 'on' : '', title: 'Rasteransicht', 'aria-label': 'Rasteransicht', onclick: () => setView('grid') }, icon('grid', 18)),
        h('button', { class: lib.view === 'list' ? 'on' : '', title: 'Listenansicht', 'aria-label': 'Listenansicht', onclick: () => setView('list') }, icon('list', 18))),
      h('button', { class: 'iconbtn plain', title: 'Auswählen', 'aria-label': 'Auswählen', onclick: () => { lib.selecting = true; renderHeader(); renderContent(); } }, icon('selectCircle', 20)),
    ];
  }
  const tabs = h('div', { class: 'filter-tabs', role: 'tablist' }, FILTERS.map(([k, label]) => h('button', {
    class: 'filter-tab' + (lib.filter === k ? ' on' : ''), role: 'tab', 'aria-selected': lib.filter === k ? 'true' : 'false',
    onclick: () => { lib.filter = k; settings.filter = k; saveSettings(); renderHeader(); renderContent(); },
  }, label)));
  head.replaceChildren(titlebar, h('div', { class: 'lib-toolbar' }, tabs, h('div', { class: 'spacer' }), h('div', { class: 'lib-actions' }, ...right.flat())));
}
function renderHeaderTitle() { $('#libTitle').textContent = lib.query ? 'Suche' : (lib.folder ? byId(lib.folder).name : SECTIONS[lib.section].label); }

// ---------- Content ----------
function thumbFor(r, width) {
  if (r.kind === 'folder') {
    const count = live().filter(x => x.parent === r.id && !x.trashed).length;
    return folderArt(r, count);
  }
  const c = h('canvas', { class: r.cover ? 'cover' : 'paper' });
  if (r.kind === 'textdoc') { renderTextThumb(c, r, width * 2); return c; }
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
    lib.query ? 'Keine Treffer.' : lib.section === 'trash' ? 'Der Papierkorb ist leer.' : lib.section === 'favorites' ? 'Noch keine Favoriten. Markiere Dokumente über das ···-Menü.' : lib.section === 'recent' ? 'Noch keine Dokumente geöffnet.' : 'Hier ist noch nichts. Tippe oben auf +.');
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
  else if (r.kind === 'textdoc') openTextDoc(r.id);
  else openDoc(r.id);
}

// Card: preview on a quiet stone panel, then title, date and the options button
function tile(r) {
  const more = h('button', { class: 'chev', title: 'Optionen', 'aria-label': 'Optionen', onclick: e => { e.stopPropagation(); itemMenu(r, e.currentTarget); } }, icon('dots', 18));
  const t = h('div', { class: 'tile' + (lib.selected.has(r.id) ? ' selected' : '') + (r.kind === 'folder' ? ' is-folder' : '') },
    h('button', { class: 'thumb', onclick: () => activate(r), 'aria-label': r.name }, thumbFor(r, 125),
      lib.selecting ? h('span', { class: 'checkmark' }, lib.selected.has(r.id) ? icon('check', 16) : '') : null,
      r.favorite ? h('span', { class: 'fav-badge' }, icon('starFill', 14)) : null,
      r.conflicts?.length ? h('span', { class: 'conflict-badge', title: 'Sync-Hinweis: auf mehreren Geräten geändert' }, '!') : null),
    h('div', { class: 'tile-meta' },
      h('div', { class: 'tile-text' },
        h('div', { class: 'tile-title' }, h('span', { title: r.name }, r.name)),
        h('div', { class: 'tile-sub' }, sub(r))),
      lib.selecting ? null : more));
  if (r.kind === 'folder' && !r.trashed) t.dataset.drop = r.id;
  dragToFolder(t, r);
  return t;
}

function row(r) {
  const el = h('div', { class: 'row' + (lib.selected.has(r.id) ? ' selected' : '') },
    h('button', { class: 'row-hit', onclick: () => activate(r) },
      h('div', { class: 'row-thumb' }, thumbFor(r, 40)),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, r.name, r.favorite ? icon('starFill', 12) : '', r.conflicts?.length ? h('span', { class: 'conflict-badge inline', title: 'Sync-Hinweis: auf mehreren Geräten geändert' }, '!') : ''),
        h('div', { class: 'row-sub' }, sub(r) + (r.kind === 'notebook' ? ` · ${r.pages.length} ${r.pages.length === 1 ? 'Seite' : 'Seiten'}` : r.kind === 'textdoc' ? ' · Textdokument' : ''))),
      lib.selecting ? h('span', { class: 'checkmark' }, lib.selected.has(r.id) ? icon('check', 16) : '') : null),
    lib.selecting ? null : h('button', { class: 'chev', title: 'Optionen', 'aria-label': 'Optionen', onclick: e => itemMenu(r, e.currentTarget) }, icon('dots', 18)));
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
    { label: 'Textdokument', icon: 'text', action: newTextDocument },
    { label: 'Ordner', icon: 'folder', action: createFolder },
    '-',
    { label: 'PDF importieren', icon: 'pdf', action: importPdf },
    { label: 'Goodnotes importieren', icon: 'doc', action: importGoodnotes },
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
  const nb = r.kind === 'notebook', text = r.kind === 'textdoc', doc = nb || text;
  menu(at, [
    doc && { label: 'Öffnen', icon: 'doc', action: () => activate(r) },
    { label: 'Umbenennen', icon: 'rename', action: () => rename(r) },
    doc && { label: 'Duplizieren', icon: 'copy', action: () => duplicate([r.id]) },
    { label: 'Verschieben', icon: 'move', action: () => moveItems([r.id]) },
    { label: r.favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten', icon: r.favorite ? 'starFill' : 'star', action: () => update(r, { favorite: !r.favorite }) },
    nb && { label: 'Cover ändern', icon: 'palette', action: () => changeCover(r) },
    r.kind === 'folder' && { label: 'Farbe & Symbol', icon: 'palette', action: () => changeFolderLook(r) },
    r.conflicts?.length && { label: `Sync-Hinweise (${r.conflicts.length})`, icon: 'sync', action: () => clearConflicts(r) },
    nb && { label: 'Als PDF exportieren', icon: 'share', action: () => exportPdf(r) },
    text && { label: 'Als PDF (Drucken)', icon: 'share', action: () => printDoc(r) },
    doc && { label: 'Als Goodnotes-Datei (Beta)', icon: 'doc', action: async () => (await import('./goodnotes-export.js')).exportGoodnotes(r) },
    '-',
    { label: 'In Papierkorb', icon: 'trash', danger: true, action: () => trash([r.id]) },
  ]);
}

// ---------- Actions ----------
async function update(r, patch) { Object.assign(r, patch, { updated: Date.now() }); await store.put(r); }

async function rename(r) {
  const name = await promptText('Umbenennen', r.name, '', r.kind === 'notebook' ? suggestNames(r) : []);
  if (!name) return;
  // a text document's name is its title block
  const title = r.kind === 'textdoc' && r.blocks.find(b => b.type === 'title');
  if (title) title.children = [{ text: name }];
  update(r, { name });
}

async function duplicate(ids) {
  const copies = ids.map(byId).filter(r => r?.kind === 'notebook' || r?.kind === 'textdoc').map(r => r.kind === 'textdoc'
    ? { ...structuredClone(r), id: newTextDoc().id, name: r.name + ' Kopie', created: Date.now(), updated: Date.now(), opened: Date.now(), favorite: false }
    : cloneNotebook(r, r.name + ' Kopie'));
  if (!copies.length) return toast('Ordner können nicht dupliziert werden');
  await store.putMany(copies);
  lib.selecting = false; lib.selected.clear();
  toast(copies.length === 1 ? 'Dupliziert' : `${copies.length} Dokumente dupliziert`);
}

// Folder picker sheet. Resolves to a folder id, null for the top level, or undefined when cancelled.
async function pickFolder(title, doneLabel, { exclude = new Set(), preselect } = {}) {
  records = (await store.all()).filter(r => !CAL_KINDS.has(r.kind)); // calendar records live in the calendar view
  const folders = live().filter(r => r.kind === 'folder' && !r.trashed && !exclude.has(r.id));
  let target = preselect;
  const tree = (parent, depth) => folders.filter(f => (f.parent || null) === parent).sort((a, b) => a.name.localeCompare(b.name, 'de'))
    .flatMap(f => [opt(f.id, f.name, depth), ...tree(f.id, depth + 1)]);
  const list = h('div', { class: 'pick-list' });
  function opt(id, name, depth) {
    return h('button', {
      class: 'pick-item' + (id === preselect ? ' active' : ''), style: { paddingLeft: 14 + depth * 22 + 'px' },
      onclick: e => { target = id; list.querySelectorAll('.pick-item').forEach(b => b.classList.toggle('active', b === e.currentTarget)); },
    }, h('i', { class: 'pick-ficon', style: id ? { color: folderColor(byId(id)) } : {} }, icon(id && folderIcon(byId(id)) || 'folder', 18)), h('span', {}, name));
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

// Notes left by the sync merge (merge.js). Resolves true when the user marks them as read.
export async function showConflicts(r) {
  const fmt = t => new Date(t).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  const body = h('div', { class: 'conflict-list' },
    h('p', { class: 'conflict-intro' }, 'Dieses Dokument wurde auf mehreren Geräten gleichzeitig geändert. Folio hat die Änderungen zusammengeführt; nichts wurde verworfen. Bitte prüfe die genannten Stellen.'),
    ...(r.conflicts || []).map(c => h('div', { class: 'conflict-item' }, h('span', { class: 'conflict-time' }, fmt(c.at)), h('span', {}, c.text))));
  return !!(await sheet({ title: 'Sync-Hinweise', body, done: 'Gelesen' }));
}
async function clearConflicts(r) {
  if (!(await showConflicts(r))) return;
  delete r.conflicts;
  await update(r, {});
}

// Colour (Folio palette + custom) and symbol for a folder, with a live preview.
async function changeFolderLook(f) {
  let color = folderColor(f).startsWith('#') ? f.color : null, ic = folderIcon(f);
  const isPalette = c => COVERS.some(x => x.toLowerCase() === c?.toLowerCase());
  const preview = h('div', { class: 'flook-preview' });
  const colors = h('div', { class: 'flook-colors' }), icons = h('div', { class: 'flook-icons' });
  const custom = h('input', { type: 'color', class: 'flook-custom-input', 'aria-label': 'Eigene Farbe', value: color || '#6B8F7E', oninput: e => { color = e.target.value; render(); } });
  const render = () => {
    preview.replaceChildren(folderArt({ color, icon: ic }, ''));
    colors.replaceChildren(
      h('button', { class: 'flook-swatch' + (!color ? ' active' : ''), title: 'Standard', 'aria-label': 'Standardfarbe', style: { background: 'var(--sage)' }, onclick: () => { color = null; render(); } }),
      ...COVERS.map(c => h('button', { class: 'flook-swatch' + (color?.toLowerCase() === c.toLowerCase() ? ' active' : ''), 'aria-label': 'Farbe ' + c, style: { background: c }, onclick: () => { color = c; render(); } })),
      h('label', { class: 'flook-swatch custom' + (color && !isPalette(color) ? ' active' : ''), title: 'Eigene Farbe', style: color && !isPalette(color) ? { background: color } : {} }, icon('plus', 16), custom));
    icons.replaceChildren(
      h('button', { class: 'flook-icon none' + (!ic ? ' active' : ''), title: 'Kein Symbol', onclick: () => { ic = null; render(); } }, h('span', {}, 'Kein')),
      ...FOLDER_ICONS.map(k => h('button', { class: 'flook-icon' + (ic === k ? ' active' : ''), 'aria-label': 'Symbol ' + k, onclick: () => { ic = k; render(); } }, icon(k, 22))));
  };
  render();
  const body = h('div', { class: 'flook' }, preview, h('div', { class: 'flook-label' }, 'Farbe'), colors, h('div', { class: 'flook-label' }, 'Symbol'), icons);
  if (await sheet({ title: 'Farbe & Symbol', body }) && (color !== (f.color || null) || ic !== (f.icon || null))) update(f, { color, icon: ic });
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
const COVER_NAMES = ['Ink Navy', 'Tiefblau', 'Mist Blue', 'Sage Green', 'Tannengrün', 'Schiefer', 'Warm Stone', 'Sand', 'Ocker', 'Pflaume', 'Graphit', 'Soft Ivory'];
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

async function newTextDocument() {
  const doc = newTextDoc({ parent: lib.section === 'docs' ? lib.folder : null });
  await store.put(doc);
  openTextDoc(doc.id);
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

async function importGoodnotes() {
  // No accept filter: iOS doesn't know the .goodnotes type and would grey the files out.
  const f = await pickFile('');
  if (!f) return;
  if (!(await isGoodnotes(f))) return toast('Das ist keine .goodnotes-Datei', 3000);
  importPdfFile(f);
}

// .goodnotes files are ZIP archives ("PK")
export async function isGoodnotes(file) {
  if (/\.goodnotes$/i.test(file.name || '')) return true;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b;
}

// Shared import (file picker, drag & drop, clipboard) for PDFs and Goodnotes documents:
// ask where to save, then convert and open.
export async function importPdfFile(file, name = file.name) {
  const gn = await isGoodnotes(file);
  if (gn) { // a ZIP of a whole Goodnotes folder ("Exportieren" on a folder) instead of one document?
    try {
      const { unzip } = await import('./goodnotes.js');
      const zip = await unzip(await file.arrayBuffer());
      if (!zip.has('index.events.pb') && [...zip.keys()].some(k => /\.goodnotes$/i.test(k))) return importGoodnotesFolder(file, zip);
    } catch { /* not readable as ZIP: the document import below reports it */ }
  }
  let title = (name || (gn ? 'Goodnotes-Import' : 'Importiertes PDF')).replace(/\.(pdf|goodnotes)$/i, '');
  const parent = await pickFolder(`„${title}“ speichern in`, 'Speichern', { preselect: lib.section === 'docs' ? lib.folder : null });
  if (parent === undefined) return;
  try {
    let pages;
    if (gn) {
      const { goodnotesToNotebook } = await import('./goodnotes.js');
      const doc = await goodnotesToNotebook(file);
      if (doc.name) title = doc.name;
      if (doc.blocks) { // Goodnotes text document
        const td = { ...newTextDoc({ name: title, parent }), blocks: doc.blocks };
        await store.put(td);
        return openTextDoc(td.id);
      }
      pages = doc.pages;
    } else pages = await pdfToPages(file);
    const nb = newNotebook({ name: title, parent, pages });
    await store.put(nb);
    openDoc(nb.id);
  } catch (err) { toast('Import fehlgeschlagen: ' + err.message, 6000); }
}

// ---------- Goodnotes folder export (ZIP) ----------
// Goodnotes exports a folder as a ZIP: "<Folder>/<Sub>/<Doc>.goodnotes" entries plus
// ".goodnotesmeta" (JSON: items [{ path, color, symbol }] for the folders). The folder tree is
// rebuilt as real Folio folders; each document goes through the normal .goodnotes import.
// Nothing is overwritten: folders that already exist can be merged into, documents with a name
// that already exists there get a number; everything not imported is listed at the end.
const GN_COLORS = { blue: '#3E6E9F', lightBlue: '#8EB8E6', teal: '#8EB8E6', green: '#4F7A66', mint: '#6B8F7E', yellow: '#C9A35B', orange: '#B8A68A', brown: '#B8A68A', purple: '#7D6B91', pink: '#7D6B91', red: '#7D6B91', gray: '#A7B4C6', grey: '#A7B4C6', black: '#3A3F4A' };
async function importGoodnotesFolder(file, zip) {
  const entries = [...zip.keys()];
  const docs = entries.filter(k => /\.goodnotes$/i.test(k) && !k.startsWith('__MACOSX/'));
  const skipped = entries.filter(k => !docs.includes(k) && !k.endsWith('/') && k !== '.goodnotesmeta' && !/(^|\/)(\.DS_Store|__MACOSX\/.*)$/.test(k))
    .map(k => [k, 'kein Goodnotes-Dokument']);
  let meta = {};
  try { if (zip.has('.goodnotesmeta')) for (const it of JSON.parse(new TextDecoder().decode(await zip.get('.goodnotesmeta')())).items || []) meta[it.path] = it; } catch {}
  const dirOf = k => k.split('/').slice(0, -1).join('/');
  const paths = [...new Set([...Object.keys(meta), ...docs.map(dirOf).filter(Boolean)].flatMap(p => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort();
  const roots = [...new Set(paths.map(p => p.split('/')[0]))];
  const label = roots.length === 1 ? `„${roots[0]}“` : `${roots.length} Ordner`;

  const parent = await pickFolder(`${label} importieren nach`, 'Weiter', { preselect: lib.section === 'docs' ? lib.folder : null });
  if (parent === undefined) return;
  records = (await store.all()).filter(r => !CAL_KINDS.has(r.kind));
  const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const existingFolder = (name, par) => live().find(r => r.kind === 'folder' && !r.trashed && (r.parent || null) === par && sameName(r.name, name));
  const clashes = roots.filter(n => existingFolder(n, parent));
  let mode = 'merge';
  const summary = h('div', { class: 'form' },
    h('p', { class: 'cal-hint' }, `${docs.length} Dokument${docs.length === 1 ? '' : 'e'} in ${paths.length} Ordner${paths.length === 1 ? '' : 'n'}${skipped.length ? `, ${skipped.length} andere Datei(en) werden übersprungen` : ''}.`),
    clashes.length ? h('div', {},
      h('p', { class: 'cal-hint' }, `Am Ziel gibt es schon: ${clashes.map(n => `„${n}“`).join(', ')}.`),
      segmented([['merge', 'Zusammenlegen'], ['new', 'Neuer Ordner']], mode, v => { mode = v; }),
      h('p', { class: 'cal-hint' }, 'Zusammenlegen: Dokumente kommen in den vorhandenen Ordner; gleichnamige werden nummeriert, nichts wird überschrieben.')) : null);
  if (!(await sheet({ title: 'Goodnotes-Ordner importieren', body: summary, done: 'Importieren' }))) return;

  const { goodnotesToNotebook } = await import('./goodnotes.js');
  const folderIds = new Map(); // zip path → Folio folder id
  const made = [], renamed = [], failed = [];
  const uniqueName = (name, par, kind) => {
    const taken = n => live().some(r => !r.trashed && r.kind === kind && (r.parent || null) === par && sameName(r.name, n));
    if (!taken(name)) return name;
    let i = 2; while (taken(`${name} (${i})`)) i++;
    return `${name} (${i})`;
  };
  try {
    for (const p of paths) {
      const parts = p.split('/'), name = parts[parts.length - 1], par = parts.length > 1 ? folderIds.get(parts.slice(0, -1).join('/')) : parent;
      const reuse = mode === 'merge' ? existingFolder(name, par) : null;
      if (reuse) { folderIds.set(p, reuse.id); continue; }
      const f = newFolder(uniqueName(name, par, 'folder'), par);
      const c = GN_COLORS[meta[p]?.color];
      if (c) f.color = c;
      await store.put(f); records.push(f); folderIds.set(p, f.id); made.push(f.name);
    }
    let i = 0;
    for (const k of docs) {
      i++;
      const base = k.split('/').pop().replace(/\.goodnotes$/i, '');
      toast(`Importiere ${i}/${docs.length}: ${base}…`, 0);
      const par = folderIds.get(dirOf(k)) ?? parent;
      try {
        const bytes = await zip.get(k)();
        const doc = await goodnotesToNotebook(new File([bytes], base + '.goodnotes'));
        const want = doc.name || base;
        const kind = doc.blocks ? 'textdoc' : 'notebook';
        const name = uniqueName(want, par, kind);
        if (name !== want) renamed.push(`${want} → ${name}`);
        const rec = doc.blocks ? { ...newTextDoc({ name, parent: par }), blocks: doc.blocks } : newNotebook({ name, parent: par, pages: doc.pages });
        await store.put(rec); records.push(rec);
      } catch (err) { failed.push([k, err.message]); }
    }
  } finally { toast(`Import fertig: ${docs.length - failed.length} von ${docs.length} Dokumenten`, 4000); }

  if (renamed.length || failed.length || skipped.length) {
    const list = (title, xs) => xs.length ? [h('div', { class: 'form-label' }, title), h('ul', { class: 'import-report' }, xs.map(x => h('li', {}, x)))] : [];
    await sheet({
      title: 'Import-Bericht', done: 'OK', cancel: false,
      body: h('div', { class: 'form' },
        h('p', { class: 'cal-hint' }, `${docs.length - failed.length} Dokument(e) importiert, ${made.length} Ordner angelegt.`),
        ...list('Umbenannt (Name gab es schon)', renamed),
        ...list('Fehlgeschlagen', failed.map(([k, m]) => `${k}: ${m}`)),
        ...list('Übersprungen', skipped.map(([k, m]) => `${k} (${m})`))),
    });
  }
  renderLibrary();
}

// Clipboard import. Two kinds of content are understood:
// - a copied PDF *file* (e.g. Goodnotes "Exportieren → Kopieren", Files "Kopieren")
// - text from the iOS shortcut "In Folio öffnen": "NOTIZEN-PDF|<file name>|<base64>" (or plain base64)
// Safari's clipboard API only hands out text and images, so for files we fall back to a paste
// field: the system "Einfügen" (long press / Cmd+V) does deliver copied files to the page.
const looksLikePdf = f => f && (f.type === 'application/pdf' || /\.(pdf|goodnotes)$/i.test(f.name || ''));

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
  const account = signedIn()
    ? h('div', { class: 'group-box acc-box' },
      h('div', { class: 'acc-row' },
        h('span', { class: 'sb-avatar big' }, (settings.account?.name || settings.account?.email || 'G')[0].toUpperCase()),
        h('div', { class: 'acc-text' }, h('b', {}, settings.account?.name || 'Google-Konto'), h('div', { class: 'hint' }, settings.account?.email || '')),
        h('button', { class: 'pill-btn', onclick: () => { signOut(); renderSidebar(); document.querySelector('.sheet-head .textbtn')?.click(); } }, 'Abmelden')),
      h('div', { class: 'hint' }, 'Deine Notizen liegen im Ordner „Folio“ in deinem Google Drive. Folio sieht nur Dateien, die es selbst angelegt hat.'))
    : h('div', { class: 'group-box acc-box' },
      h('button', { class: 'sb-signin wide', onclick: () => { document.querySelector('.sheet-head .textbtn')?.click(); signIn(); } }, googleG(), h('span', {}, 'Mit Google anmelden')),
      h('div', { class: 'hint' }, 'Synchronisiert deine Notizen über dein eigenes Google Drive zwischen allen Geräten.'));
  const body = h('div', { class: 'form' },
    h('div', { class: 'form-label' }, 'Darstellung'),
    segmented([['system', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']], settings.theme || 'system', v => { settings.theme = v; saveSettings(); applyTheme(); }),
    h('div', { class: 'form-label' }, 'Stift'),
    h('div', { class: 'group-box' },
      toggle('Nur mit Stift zeichnen', !settings.fingerDraw, v => { settings.fingerDraw = !v; saveSettings(); }),
      h('div', { class: 'hint' }, 'An: Finger scrollen und zoomen, nur der Apple Pencil zeichnet.')),
    h('div', { class: 'form-label' }, 'Synchronisation'),
    account,
    h('div', { class: 'group-box', style: { marginTop: '10px' } },
      toggle('Goodnotes-Kopien in Drive', settings.gnCopies !== false, v => { settings.gnCopies = v; saveSettings(); }),
      h('div', { class: 'hint' }, 'Legt zu jedem Notizbuch eine .goodnotes-Datei im Drive-Ordner der App unter „Goodnotes“ ab (aktualisiert eine Minute nach der letzten Änderung). Öffnen in Goodnotes: Dateien-App → Google Drive.')),
    h('div', { class: 'about' }, folioMark(40), h('div', {}, h('div', { class: 'about-name' }, 'Folio'), h('div', { class: 'hint' }, `Make space for ideas. · Version ${APP_VERSION} · `, h('a', { href: 'datenschutz.html', target: '_blank', rel: 'noopener' }, 'Datenschutz')))));
  const ok = await sheet({ title: 'Einstellungen', body });
  if (ok) renderSidebar();
}
