import { $, h, fmtDate, pickFile } from './util.js';
import { icon, folioMark } from './icons.js';
import { store, light, settings, saveSettings, bus, newNotebook, newFolder, cloneNotebook, newPage, COVERS, TEMPLATES, TEMPLATE_SECTIONS, PAPERS, FORMATS, PAGE_W, APP_VERSION } from './store.js';
import { renderCover, renderThumb } from './render.js';
import { menu, sheet, promptText, confirmBox, toast, segmented, toggle } from './ui.js';
import { pdfToPages, loadImageFile, exportPdf } from './pdf.js';
import { openDoc } from './editor.js';
import { suggestNames } from './suggest.js';
import { sync, signIn, signOut, signedIn } from './sync.js';
import { newTextDoc, openTextDoc, renderTextThumb, plainText, printDoc } from './textdoc.js';
import { newDeck, openDeck, deckArt, deckText, importCardsSheet, exportDeck } from './deck.js';
import { renderLearnPlan, todayCount } from './learnplan.js';
import { renderCalendar, CAL_KINDS } from './calendar.js';
import { ensureLocal, offload, runOffload, recordSize, offloadOn, offloadMin, OFFLOAD_SIZES, keepFilesLocal, offloadFolder } from './offload.js';
import { recording, setRecording } from './pencilrec.js';

const SECTIONS = {
  docs: { label: 'Alle Notizen', icon: 'notes' },
  favorites: { label: 'Favoriten', icon: 'favorites' },
  recent: { label: 'Zuletzt geöffnet', icon: 'clock' },
  trash: { label: 'Papierkorb', icon: 'trash' },
  calendar: { label: 'Kalender', icon: 'calendar' },
  learn: { label: 'Lernen', icon: 'cards' },
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
const containsText = (r, q) => r.kind === 'textdoc' ? plainText(r).toLowerCase().includes(q) : r.kind === 'deck' ? deckText(r).toLowerCase().includes(q) : r.kind === 'notebook' && r.pages.some(p => (p.pdfText || '').toLowerCase().includes(q) || p.elements.some(e => e.type === 'text' && e.text.toLowerCase().includes(q)));

const kindOk = r => lib.filter === 'all' || r.kind === lib.filter; // filter tabs

// Search in the text of documents (PDF text, text boxes, text documents): the library only has
// light records, so the documents are read one at a time in the background; titles match at once.
let searchT;
function searchContent(query) {
  clearTimeout(searchT);
  const q = query.trim().toLowerCase();
  if (q.length < 2) { lib.hits = null; return; }
  searchT = setTimeout(async () => {
    const ids = new Set();
    await store.each(r => { if (!r.deleted && !r.trashed && containsText(r, q)) ids.add(r.id); });
    if (lib.query.trim().toLowerCase() !== q) return; // typed on meanwhile
    lib.hits = { q, ids };
    renderContent();
  }, 300);
}

function items() {
  const all = live();
  let list;
  if (lib.query) {
    const q = lib.query.toLowerCase();
    list = all.filter(r => !r.trashed && (r.name.toLowerCase().includes(q) || (lib.hits?.q === q.trim() && lib.hits.ids.has(r.id))));
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
  records = (await store.list()).filter(r => !CAL_KINDS.has(r.kind)); // calendar records live in the calendar view
  if (lib.folder && (!byId(lib.folder) || byId(lib.folder).trashed)) lib.folder = null;
  renderSidebar();
  if (lib.section === 'learn') { // all flashcard decks at a glance (learnplan.js)
    $('#libHead').replaceChildren(h('div', { class: 'lib-titlebar' }, sidebarBtn(), h('div', { class: 'lib-title' }, h('h1', { id: 'libTitle' }, 'Lernen'))));
    updateSidebar();
    return renderLearnPlan($('#libContent'), { newDeck: newCardDeck, importCards: () => importCardsSheet({}) });
  }
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

export const goSection = section => go(section); // (deck.js: back to the learning overview)
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
const FOLDER_ICONS = ['book', 'school', 'work', 'idea', 'flask', 'music', 'heart', 'code', 'calendar', 'home', 'star', 'camera', 'palette', 'doc', 'pencil', 'globe', 'plane', 'sport', 'leaf', 'money', 'chart', 'person', 'people', 'food', 'health', 'car', 'game', 'flag', 'lock', 'archive', 'sun', 'coffee'];
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
      learnItem(),
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
        ? h('button', {
          id: 'sbSync', class: 'sb-sync', title: 'Jetzt synchronisieren',
          // the sidebar cuts long messages: a tap on a warning shows it in full, then syncs again
          onclick: () => { if ((settings.syncStatus || '').startsWith('⚠')) toast(settings.syncStatus, 8000); sync(true); },
        },
          h('span', { class: 'sb-avatar' }, (settings.account?.name || settings.account?.email || 'G')[0].toUpperCase()),
          h('span', { class: 'sb-acc' },
            h('b', {}, settings.account?.name || settings.account?.email || 'Google Drive'),
            h('span', { id: 'sbStatus' }, settings.syncStatus || 'Synchronisieren')))
        : h('button', { class: 'sb-signin', onclick: signIn }, googleG(), h('span', {}, 'Mit Google anmelden')),
      h('button', { class: 'sb-gear', title: 'Einstellungen', 'aria-label': 'Einstellungen', onclick: () => { if (compactLibrary.matches) setMobileSidebar(false); openSettings(); } }, icon('gear', 18))));
}
// "Lernen": the learning overview of all flashcard decks, with the number of cards due today
function learnItem() {
  const badge = h('b', { class: 'sb-badge', hidden: true });
  todayCount().then(n => { if (n) { badge.textContent = n > 999 ? '999+' : n; badge.hidden = false; badge.title = `${n} Karten heute`; } }).catch(() => {});
  return h('button', {
    class: 'sb-item' + (lib.section === 'learn' && !lib.query ? ' active' : ''), onclick: () => go('learn'),
  }, icon('cards', 20), h('span', {}, SECTIONS.learn.label), badge);
}

// Google's "G" (official brand colours, as Google's sign-in guidelines ask for on sign-in buttons)
function googleG() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('width', 18); s.setAttribute('height', 18); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>';
  return s;
}

// ---------- Header ----------
const FILTERS = [['all', 'Alle'], ['notebook', 'Notizbücher'], ['textdoc', 'Textdokumente'], ['deck', 'Karteikarten'], ['folder', 'Ordner']];
function renderHeader() {
  const head = $('#libHead');
  const path = lib.folder ? folderPath(lib.folder) : [];
  const title = lib.query ? 'Suche' : path.length ? path[path.length - 1].name : SECTIONS[lib.section].label;

  const search = h('input', {
    class: 'searchfield', type: 'search', placeholder: 'Notizen durchsuchen…', value: lib.query, 'aria-label': 'Suchen',
    oninput: e => { lib.query = e.target.value; renderContent(); renderHeaderTitle(); searchContent(lib.query); },
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
  if (r.kind === 'deck') return deckArt(r, width < 60); // flashcards: a stack of cards, no page preview
  if (r.offloaded && !r.cover) { // kept only in Drive: the small preview saved with the stub
    return r.thumb ? h('img', { class: 'paper stub-thumb', src: r.thumb, alt: '' }) : h('div', { class: 'paper stub-thumb empty' }, icon('cloud', 28));
  }
  if (r.cover) { const c = h('canvas', { class: 'cover' }); renderCover(c, r.cover, width * 2); return c; }
  // first page / text preview: rendered once from the full document, then kept in the 'thumbs'
  // store, so listing the library never loads document content (see queueThumb)
  const img = h('img', { class: 'paper lazy-thumb', alt: '' });
  queueThumb(r, img);
  return img;
}

// Previews are made one at a time: each needs its document loaded (a long PDF can be large).
const thumbJobs = [];
let thumbRunning = false;
const madeThumbs = new Map(); // id → { updated, src } of this session (no store round trip on re-render)
function queueThumb(r, img) {
  const known = madeThumbs.get(r.id);
  if (known?.updated === r.updated) { img.src = known.src; return; }
  thumbJobs.push([r, img]);
  if (!thumbRunning) runThumbJobs();
}
async function runThumbJobs() {
  thumbRunning = true;
  while (thumbJobs.length) {
    const [r, img] = thumbJobs.shift();
    if (!img.isConnected && thumbJobs.length) continue; // re-rendered meanwhile
    try {
      let t = madeThumbs.get(r.id);
      if (t?.updated !== r.updated) t = await store.getThumb(r.id);
      if (t?.updated !== r.updated) {
        const full = await store.get(r.id);
        if (!full) continue;
        const c = document.createElement('canvas');
        if (full.kind === 'textdoc') renderTextThumb(c, full, 250);
        else if (full.pages?.[0]) await renderThumb(c, full.pages[0], 250);
        else continue;
        t = { id: r.id, updated: r.updated, src: c.toDataURL('image/jpeg', 0.8) };
        c.width = c.height = 0;
        await store.putThumb(t);
      }
      madeThumbs.set(r.id, t);
      img.src = t.src;
    } catch {}
  }
  thumbRunning = false;
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
  // The editable background lets iPadOS offer its real 'Einsetzen' callout on empty space.
  // Cards stay non-editable and keep their own pointer and context-menu handling.
  content.classList.add('library-paste-enabled');
  wrap.setAttribute('contenteditable', 'false');
  if (empty) empty.setAttribute('contenteditable', 'false');
  content.replaceChildren(clipboardArea('library-paste-space', message => pasteSheet(message)), list.length ? wrap : '', empty || '');
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
  else if (r.kind === 'deck') openDeck(r.id);
  else openDoc(r.id);
}

// Card: preview on a quiet stone panel, then title, date and the options button
function tile(r) {
  const more = h('button', { class: 'chev', title: 'Optionen', 'aria-label': 'Optionen', onclick: e => { e.stopPropagation(); itemMenu(r, e.currentTarget); } }, icon('dots', 18));
  const t = h('div', { class: 'tile' + (lib.selected.has(r.id) ? ' selected' : '') + (r.kind === 'folder' ? ' is-folder' : '') },
    h('button', { class: 'thumb', onclick: () => activate(r), 'aria-label': r.name }, thumbFor(r, 125),
      lib.selecting ? h('span', { class: 'checkmark' }, lib.selected.has(r.id) ? icon('check', 16) : '') : null,
      r.favorite ? h('span', { class: 'fav-badge' }, icon('starFill', 14)) : null,
      r.conflicts?.length ? h('span', { class: 'conflict-badge', title: 'Sync-Hinweis: auf mehreren Geräten geändert' }, '!') : null,
      r.offloaded ? h('span', { class: 'cloud-badge', title: 'Nur in Google Drive – wird beim Öffnen geladen' }, icon('cloud', 15)) : null),
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
        h('div', { class: 'row-title' }, r.name, r.favorite ? icon('starFill', 12) : '', r.offloaded ? h('span', { class: 'cloud-inline', title: 'Nur in Google Drive' }, icon('cloud', 14)) : '', r.conflicts?.length ? h('span', { class: 'conflict-badge inline', title: 'Sync-Hinweis: auf mehreren Geräten geändert' }, '!') : ''),
        h('div', { class: 'row-sub' }, sub(r) + (r.kind === 'notebook' ? ` · ${r.pageCount ?? r.pages.length} ${(r.pageCount ?? r.pages.length) === 1 ? 'Seite' : 'Seiten'}` : r.kind === 'textdoc' ? ' · Textdokument' : r.kind === 'deck' ? ` · ${r.cardCount ?? 0} Karten` : '') + (r.offloaded ? ' · nur in Google Drive' : ''))),
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
    { label: 'Karteikarten', icon: 'cards', action: newCardDeck },
    { label: 'Ordner', icon: 'folder', action: createFolder },
    '-',
    { label: 'PDF importieren', icon: 'pdf', action: importPdf },
    { label: 'Goodnotes importieren', icon: 'doc', action: importGoodnotes },
    { label: 'Goodnotes-Ordner (ZIP) importieren', icon: 'folder', action: importGoodnotes },
    { label: 'PDF/Goodnotes aus Zwischenablage', icon: 'paste', action: importFromClipboard },
    { label: 'Bild importieren', icon: 'image', action: importImage },
    { label: 'Karteikarten importieren', icon: 'cards', action: () => importCardsSheet({ parent: lib.section === 'docs' ? lib.folder : null }) },
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
  const nb = r.kind === 'notebook', text = r.kind === 'textdoc', deck = r.kind === 'deck', doc = nb || text || deck;
  // actions that need the content: load it from Drive first if the document is kept only there
  const full = fn => async () => { const d = await ensureLocal(r); if (d) fn(d); };
  menu(at, [
    doc && { label: 'Öffnen', icon: 'doc', action: () => activate(r) },
    { label: 'Umbenennen', icon: 'rename', action: () => rename(r) },
    doc && { label: 'Duplizieren', icon: 'copy', action: () => duplicate([r.id]) },
    { label: 'Verschieben', icon: 'move', action: () => moveItems([r.id]) },
    { label: r.favorite ? 'Aus Favoriten entfernen' : 'Zu Favoriten', icon: r.favorite ? 'starFill' : 'star', action: () => update(r, { favorite: !r.favorite }) },
    doc && r.offloaded && { label: 'Auf dieses Gerät laden', icon: 'cloudDown', action: () => ensureLocal(r) },
    doc && !r.offloaded && !r.favorite && signedIn() && { label: 'Nur in Google Drive behalten', icon: 'cloud', action: () => offloadNow(r) },
    nb && { label: 'Cover ändern', icon: 'palette', action: () => changeCover(r) },
    r.kind === 'folder' && { label: 'Farbe & Symbol', icon: 'palette', action: () => changeFolderLook(r) },
    r.kind === 'folder' && signedIn() && { label: 'Ordner nur in Google Drive behalten', icon: 'cloud', action: () => offloadFolderNow(r) },
    r.conflicts?.length && { label: `Sync-Hinweise (${r.conflicts.length})`, icon: 'sync', action: () => clearConflicts(r) },
    nb && { label: 'Als PDF exportieren', icon: 'share', action: full(d => exportPdf(d)) },
    text && { label: 'Als PDF (Drucken)', icon: 'share', action: full(d => printDoc(d)) },
    deck && { label: 'Karten importieren', icon: 'paste', action: full(d => importCardsSheet({ deck: d })) },
    deck && { label: 'Als Text exportieren', icon: 'share', action: full(d => exportDeck(d)) },
    (nb || text) && { label: 'Als Goodnotes-Datei (Beta)', icon: 'doc', action: full(async d => (await import('./goodnotes-export.js')).exportGoodnotes(d)) },
    '-',
    { label: 'In Papierkorb', icon: 'trash', danger: true, action: () => trash([r.id]) },
  ]);
}

// ---------- Actions ----------
async function update(r, patch) {
  Object.assign(r, patch, { updated: Date.now() });
  await store.put(r);
  // favourites stay on the device: one that was kept only in Drive is loaded now, with its PDFs
  if (patch.favorite) (r.offloaded ? ensureLocal(r) : Promise.resolve()).then(() => keepFilesLocal(r));
}
async function offloadFolderNow(r) {
  toast('Ordner wird mit Google Drive abgeglichen …', 0);
  try { await sync(false); } catch {}
  const { done, kept } = await offloadFolder(r.id);
  const rest = [kept.favorite && `${kept.favorite} Favorit(en)`, kept.open && `${kept.open} geöffnet`, kept.unsynced && `${kept.unsynced} noch nicht synchronisiert`].filter(Boolean).join(', ');
  toast(done ? `${done} Dokument(e) liegen jetzt nur in Google Drive` + (rest ? ` – geblieben: ${rest}` : '') : rest ? `Nichts verschoben – ${rest}` : 'Der Ordner enthält nichts zum Auslagern', 5000);
}
async function offloadNow(r) {
  if (await offload(r)) toast(`„${r.name}“ liegt jetzt nur in Google Drive (${fmtBytes((await store.getMeta(r.id))?.size || 0)} frei)`, 3500);
  else toast('Geht erst, wenn die neueste Fassung mit Google Drive synchronisiert ist.', 4000);
}

async function rename(r) {
  // the library holds light records: the content (name suggestions, a text document's title) comes from the full one
  const doc = r.offloaded ? r : (await store.get(r.id)) || r;
  const name = await promptText('Umbenennen', r.name, '', r.kind === 'notebook' && doc.pages ? suggestNames(doc) : []);
  if (!name) return;
  // a text document's name is its title block
  const title = r.kind === 'textdoc' && doc.blocks?.find(b => b.type === 'title');
  if (title) { title.children = [{ text: name }]; Object.assign(doc, { name, updated: Date.now() }); return store.put(doc); }
  update(r, { name });
}

async function duplicate(ids) {
  // one document at a time: each copy is loaded, cloned and saved before the next
  let n = 0;
  for (const r of ids.map(byId)) {
    if (r?.kind !== 'notebook' && r?.kind !== 'textdoc' && r?.kind !== 'deck') continue;
    const d = await ensureLocal(r);
    if (!d) return;
    const copy = d.kind === 'deck'
      ? { ...structuredClone(d), id: newDeck().id, name: d.name + ' Kopie', created: Date.now(), updated: Date.now(), opened: Date.now(), favorite: false, cards: d.cards.map(c => ({ ...structuredClone(c), id: newDeck().id })) }
      : d.kind === 'textdoc'
      ? { ...structuredClone(d), id: newTextDoc().id, name: d.name + ' Kopie', created: Date.now(), updated: Date.now(), opened: Date.now(), favorite: false }
      : cloneNotebook(d, d.name + ' Kopie');
    for (const k of ['offloaded', 'remoteUpd', 'size', 'pageCount', 'thumb', 'conflicts', 'light']) delete copy[k];
    await store.put(copy); n++;
  }
  if (!n) return toast('Ordner können nicht dupliziert werden');
  lib.selecting = false; lib.selected.clear();
  toast(n === 1 ? 'Dupliziert' : `${n} Dokumente dupliziert`);
}

// Folder picker sheet. Resolves to a folder id, null for the top level, or undefined when cancelled.
async function pickFolder(title, doneLabel, { exclude = new Set(), preselect } = {}) {
  records = (await store.list()).filter(r => !CAL_KINDS.has(r.kind)); // calendar records live in the calendar view
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
    const base = (FORMATS[o.format] || FORMATS.a4).h;
    return o.orient === 'landscape' ? Math.round(PAGE_W * PAGE_W / base) : base;
  };
  // "Unendlich": one page that grows with its content in every direction (see fitInfinite in render.js)
  const INF = 2000;
  const samplePage = template => (o.format === 'inf' ? { template, inf: true, w: INF, h: INF, paper: o.paper, elements: [] } : { template, h: pageHeight(), paper: o.paper, elements: [] });
  const firstPage = () => (o.format === 'inf' ? { ...newPage(o.template, INF, o.paper), inf: true, w: INF, x0: 0, y0: 0 } : newPage(o.template, pageHeight(), o.paper));

  const back = h('div', { class: 'backdrop' });
  const close = () => { document.removeEventListener('keydown', onKey); back.classList.add('closing'); setTimeout(() => back.remove(), 200); };
  const create = async () => {
    settings.lastCover = o.cover; settings.lastTemplate = o.template; settings.lastPaper = o.paper; saveSettings();
    const nb = newNotebook({
      name: o.name.trim() || 'Unbenanntes Notizbuch', cover: o.cover,
      parent: lib.section === 'docs' ? lib.folder : null,
      pages: [firstPage()],
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
      dropdown(o.format === 'inf' ? 'Unendlich' : FORMATS[o.format].label.replace(' Hoch', ''), [['a4', 'A4'], ['letter', 'Letter'], ['inf', 'Unendlich']].map(([k, l]) => ({ label: l, checked: o.format === k, action: set('format', k) }))),
      dropdown(PAPERS[o.paper].label, Object.entries(PAPERS).map(([k, p]) => ({ label: p.label, swatch: p.color, action: set('paper', k) }))),
      h('div', { class: 'spacer' }),
      ...(o.format === 'inf' ? [] : [h('div', { class: 'nb-orient', role: 'group', 'aria-label': 'Ausrichtung' },
        h('button', { class: o.orient === 'portrait' ? 'active' : '', title: 'Hochformat', onclick: set('orient', 'portrait') }, icon('portrait', 20)),
        h('button', { class: o.orient === 'landscape' ? 'active' : '', title: 'Querformat', onclick: set('orient', 'landscape') }, icon('landscape', 20)))]));
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
      gallery.replaceChildren(...(o.format === 'inf' ? [[TEMPLATE_SECTIONS[0][0], ['blank', 'dots', 'narrow', 'lined', 'grid']]] : TEMPLATE_SECTIONS).map(([name, keys]) => section(name, keys.map(k => {
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

async function newCardDeck() {
  const name = await promptText('Neue Karteikarten', '', 'Name des Stapels');
  if (!name) return;
  const d = newDeck({ name, parent: lib.section === 'docs' ? lib.folder : null });
  await store.put(d);
  openDeck(d.id);
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
  if (!(await isGoodnotes(f))) return toast('Das ist keine .goodnotes-Datei und kein Goodnotes-Ordner (ZIP)', 3000);
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
      const { unzipBlob } = await import('./goodnotes.js');
      const zip = await unzipBlob(file); // reads only the ZIP's directory, entries later one by one
      if (!zip.has('index.events.pb') && [...zip.keys()].some(k => ZIP_DOC.test(k))) return importGoodnotesFolder(file, zip);
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
// rebuilt as real Folio folders; each document goes through the normal .goodnotes import, PDFs
// in the ZIP through the normal PDF import (so any zipped folder of PDFs works too).
// Nothing is overwritten: folders that already exist can be merged into, documents with a name
// that already exists there get a number; everything not imported is listed at the end.
const ZIP_DOC = /^(?!__MACOSX\/).*\.(goodnotes|pdf)$/i;
const GN_COLORS = { blue: '#3E6E9F', lightBlue: '#8EB8E6', teal: '#8EB8E6', green: '#4F7A66', mint: '#6B8F7E', yellow: '#C9A35B', orange: '#B8A68A', brown: '#B8A68A', purple: '#7D6B91', pink: '#7D6B91', red: '#7D6B91', gray: '#A7B4C6', grey: '#A7B4C6', black: '#3A3F4A' };
async function importGoodnotesFolder(file, zip) {
  const entries = [...zip.keys()];
  const docs = entries.filter(k => ZIP_DOC.test(k));
  const skipped = entries.filter(k => !docs.includes(k) && !k.endsWith('/') && k !== '.goodnotesmeta' && !/(^|\/)(\.DS_Store|__MACOSX\/.*)$/.test(k))
    .map(k => [k, 'weder Goodnotes-Dokument noch PDF']);
  let meta = {};
  try { if (zip.has('.goodnotesmeta')) for (const it of JSON.parse(new TextDecoder().decode(await zip.get('.goodnotesmeta')())).items || []) meta[it.path] = it; } catch {}
  const dirOf = k => k.split('/').slice(0, -1).join('/');
  const paths = [...new Set([...Object.keys(meta), ...docs.map(dirOf).filter(Boolean)].flatMap(p => p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort();
  const roots = [...new Set(paths.map(p => p.split('/')[0]))];
  // documents at the top of the ZIP (no folder) go straight into the chosen target folder
  const label = roots.length === 1 && docs.every(k => dirOf(k)) ? `„${roots[0]}“` : roots.length ? `${roots.length} Ordner` : `${docs.length} Dokument${docs.length === 1 ? '' : 'e'}`;

  const parent = await pickFolder(`${label} importieren nach`, 'Weiter', { preselect: lib.section === 'docs' ? lib.folder : null });
  if (parent === undefined) return;
  records = (await store.list()).filter(r => !CAL_KINDS.has(r.kind));
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
  if (!(await sheet({ title: 'Ordner importieren', body: summary, done: 'Importieren' }))) return;

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
      const isPdfEntry = /\.pdf$/i.test(k);
      const base = k.split('/').pop().replace(/\.(goodnotes|pdf)$/i, '');
      toast(`Importiere ${i}/${docs.length}: ${base}…`, 0);
      const par = folderIds.get(dirOf(k)) ?? parent;
      try {
        const bytes = await zip.get(k)();
        const doc = isPdfEntry
          ? { pages: await pdfToPages(new File([bytes], base + '.pdf', { type: 'application/pdf' })) }
          : await goodnotesToNotebook(new File([bytes], base + '.goodnotes'));
        const want = doc.name || base;
        const kind = doc.blocks ? 'textdoc' : 'notebook';
        const name = uniqueName(want, par, kind);
        if (name !== want) renamed.push(`${want} → ${name}`);
        const rec = doc.blocks ? { ...newTextDoc({ name, parent: par }), blocks: doc.blocks } : newNotebook({ name, parent: par, pages: doc.pages });
        await store.put(rec); records.push(light(rec)); // only the light copy stays in memory
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

// Clipboard payloads are decoded locally. Never fetch copied URLs or upload clipboard data.
async function documentKind(blob) {
  if (!blob?.size) return null;
  const bytes = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  const head = String.fromCharCode(...bytes);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b &&
      ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) return 'goodnotes';
  if (head.includes('%PDF-')) return 'pdf';
  return null;
}

async function documentFromBlob(blob, name = blob?.name || '') {
  const kind = await documentKind(blob);
  if (!kind) return null;
  name = String(name || '').trim().split(/[\\/]/).pop();
  if (!name || /^(image|datei|file|blob)(\.[^.]+)?$/i.test(name)) {
    name = kind === 'pdf' ? 'Eingefügtes PDF.pdf' : 'Eingefügtes Goodnotes.goodnotes';
  } else if (kind === 'pdf' && !/\.pdf$/i.test(name)) name += '.pdf';
  else if (kind === 'goodnotes' && !/\.(goodnotes|zip)$/i.test(name)) name += '.goodnotes';
  return new File([blob], name, { type: kind === 'pdf' ? 'application/pdf' : 'application/zip' });
}

// New shortcuts use FOLIO-FILE|<name>|<base64>. Existing NOTIZEN-PDF shortcuts still work.
// Also accept data URLs and plain base64 for either supported file type.
async function documentFromText(text) {
  let data = String(text || '').trim(), name = '';
  const prefix = /^(?:FOLIO-(?:FILE|PDF|GOODNOTES)|NOTIZEN-PDF)\|/i.exec(data);
  if (prefix) {
    data = data.slice(prefix[0].length);
    const divider = data.lastIndexOf('|');
    if (divider < 0) throw new Error('Die kopierten Dateidaten sind unvollständig.');
    name = data.slice(0, divider);
    data = data.slice(divider + 1);
  }
  const url = /^data:[^,]*;base64,/i.exec(data);
  if (url) data = data.slice(url[0].length);
  data = data.replace(/\s+/g, '');
  if (!prefix && !url && !/^(JVBER|UEs)/.test(data)) return null;
  let binary;
  try { binary = atob(data); }
  catch { throw new Error('Die kopierten Dateidaten sind keine gültige Base64-Datei.'); }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = await documentFromBlob(new Blob([bytes]), name);
  if (!file && (prefix || url)) throw new Error('Die kopierten Daten enthalten keine PDF- oder Goodnotes-Datei.');
  return file;
}

// DataTransfer can become unreadable once the event handler awaits: capture all data first.
function snapshotPaste(data) {
  const files = [];
  for (const item of Array.from(data?.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  for (const file of Array.from(data?.files || [])) if (!files.includes(file)) files.push(file);
  const texts = ['text/plain', 'text/uri-list'].map(type => data?.getData(type) || '').filter(Boolean);
  return { files, texts };
}

async function documentFromPaste({ files = [], texts = [] }) {
  // Prefer an actual file over alternate text/preview representations of the same clipboard.
  for (const blob of files) {
    const file = await documentFromBlob(blob);
    if (file) return file;
  }
  for (const text of texts) {
    const file = await documentFromText(text);
    if (file) return file;
  }
  return null;
}

async function readClipboardDocument() {
  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read();
    // Try file representations across all items before inspecting encoded text.
    for (const item of items) for (const type of item.types) {
      if (!/pdf|goodnotes|zip|octet-stream/i.test(type)) continue;
      try {
        const file = await documentFromBlob(await item.getType(type));
        if (file) return file;
      } catch { /* another advertised representation may be usable */ }
    }
    for (const item of items) if (item.types.includes('text/plain')) {
      const file = await documentFromText(await (await item.getType('text/plain')).text());
      if (file) return file;
    }
    return null;
  }
  if (navigator.clipboard?.readText) return documentFromText(await navigator.clipboard.readText());
  return null;
}

// Clipboard import: files exposed by iPadOS, or locally decoded shortcut/base64 data.
// Reading a clipboard is always triggered by a paste or an explicit button press.
let clipboardImporting = false;
const CLIPBOARD_HELP = 'Safari hat keine PDF- oder Goodnotes-Datei übergeben. Kopiere in Goodnotes einen Export als PDF oder Goodnotes – einzelne kopierte Striche oder Vorschaubilder sind kein vollständiges Dokument.';

async function importClipboard(read, onFailure, beforeImport) {
  if (clipboardImporting) return;
  clipboardImporting = true;
  try {
    const file = await read();
    if (!file) return onFailure(CLIPBOARD_HELP);
    if (beforeImport && beforeImport() === false) return;
    document.querySelector('.clip-hint')?.remove();
    settings.clipImport = true; saveSettings();
    await importPdfFile(file);
  } catch (err) {
    onFailure(err.name === 'NotAllowedError' ? 'Bitte im Einfügebereich lange drücken und „Einsetzen“ wählen.' : 'Einfügen fehlgeschlagen: ' + err.message);
  } finally { clipboardImporting = false; }
}

function clipboardArea(className, onFailure, beforeImport) {
  const zone = h('div', {
    class: className, contenteditable: 'true', role: 'textbox', inputmode: 'none',
    'aria-label': 'PDF oder Goodnotes einsetzen', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off',
    'data-placeholder': 'Hier lange drücken und „Einsetzen“ wählen',
  });
  zone.addEventListener('paste', e => {
    e.preventDefault();
    const snapshot = snapshotPaste(e.clipboardData); // must run before the first await
    zone.textContent = '';
    importClipboard(() => documentFromPaste(snapshot), onFailure, beforeImport);
  });
  // This is an import target, not a text editor. Never insert pasted HTML into the library.
  zone.addEventListener('beforeinput', e => e.preventDefault());
  zone.addEventListener('input', () => { zone.textContent = ''; });
  return zone;
}

export function importFromClipboard() {
  return pasteSheet();
}

function pasteSheet(message = '') {
  document.querySelector('.clip-hint')?.remove();
  const status = h('div', { class: 'paste-status', role: 'status' }, message);
  let close, active = true;
  const report = text => { if (active) status.textContent = text; };
  const finish = () => { if (!active) return false; close(); return true; };
  const zone = clipboardArea('paste-zone', report, finish);
  const paste = () => {
    zone.focus(); // keep the focus and paste call in the user's tap, required by iPad Safari
    if (/Apple/i.test(navigator.vendor || '')) {
      try { document.execCommand('paste'); } catch {}
      report('Wenn iPadOS nachfragt, tippe auf „Einsetzen“. Du kannst auch direkt im Feld lange drücken und „Einsetzen“ wählen.');
    } else {
      importClipboard(readClipboardDocument, report, finish);
    }
  };
  const body = h('div', { class: 'form' },
    h('div', { class: 'hint' }, 'Auch ohne diesen Dialog: In der Bibliothek auf eine freie Fläche lange drücken → Einsetzen.'),
    zone,
    h('button', { class: 'pill-btn primary', onclick: paste }, icon('paste', 18), 'Einsetzen'),
    h('div', { class: 'hint' }, 'PDF- und .goodnotes-Dateien werden anhand ihres Inhalts erkannt, auch wenn iPadOS keinen Dateityp oder Dateinamen mitliefert.'),
    status,
    h('details', { class: 'paste-help' },
      h('summary', {}, 'Wenn iPadOS die Datei nicht weitergibt'),
      h('p', {}, 'Dann kann Folio sie nicht aus der Zwischenablage lesen. Nutze „In Dateien sichern“ und wähle sie hier aus – oder den Kurzbefehl „In Folio öffnen“.'),
      h('p', {}, 'Kurzbefehl: Dateien aus dem Teilen-Menü empfangen → Namen abrufen → Eingabedatei als Base64 codieren → Text FOLIO-FILE|Name|Base64-codiert zusammensetzen → In Zwischenablage kopieren. In Folio auf freie Fläche lange drücken und einsetzen.')),
    h('div', { class: 'paste-file-actions' },
      h('button', { class: 'pill-btn', onclick: () => { close(); importPdf(); } }, icon('pdf', 16), 'PDF-Datei auswählen'),
      h('button', { class: 'pill-btn', onclick: () => { close(); importGoodnotes(); } }, icon('doc', 16), 'Goodnotes-Datei auswählen')));
  const result = sheet({ title: 'PDF oder Goodnotes einsetzen', body, done: null, className: 'clipboard-sheet' });
  close = () => zone.closest('.sheet')?.querySelector('.sheet-head .textbtn')?.click();
  result.then(() => { active = false; });
  zone.focus();
  return result;
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

// "Speicher" in the settings: the browser's estimate for everything Folio stores on this device,
// plus a breakdown measured from the data itself (records as JSON, the sync bases, the offline
// copy of the app). Filled in after the sheet opens, measuring can take a moment.
const fmtBytes = n => (n >= 1e9 ? (n / 1e9).toFixed(1).replace('.', ',') + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB');
function storageBox() {
  const box = h('div', { class: 'group-box storage-box' }, h('div', { class: 'hint' }, 'Wird berechnet …'));
  (async () => {
    const row = (label, value, sub) => h('div', { class: 'storage-row' }, h('span', {}, label, sub ? h('span', { class: 'hint' }, ' ' + sub) : null), h('b', {}, value));
    const size = r => JSON.stringify(r).length;
    // measured one record at a time (the whole library at once could exceed the device's memory)
    const docs = [], sizes = new Map();
    let docBytes = 0, calBytes = 0, baseBytes = 0;
    await store.each(r => {
      if (r.deleted) return;
      const n = size(r);
      if (CAL_KINDS.has(r.kind)) { calBytes += n; return; }
      docBytes += n; sizes.set(r.id, n);
      docs.push({ id: r.id, name: r.name, kind: r.kind, offloaded: r.offloaded, size: r.size });
    });
    try { await store.each(r => { baseBytes += size(r); }, 'bases'); } catch {}
    let pdfLocal = 0, pdfDrive = 0, pdfN = 0;
    try { for (const f of await store.listFiles()) { pdfN++; if (f.blob) pdfLocal += f.size || 0; else pdfDrive += f.size || 0; } } catch {}
    let appBytes = 0;
    try { for (const k of await caches.keys()) { const c = await caches.open(k); for (const req of await c.keys()) appBytes += (await (await c.match(req)).blob()).size; } } catch {}
    let est = null;
    try { est = await navigator.storage?.estimate?.(); } catch {}
    const biggest = docs.filter(r => r.kind !== 'folder' && !r.offloaded).map(r => [r, sizes.get(r.id)]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const stubs = docs.filter(r => r.offloaded);
    box.replaceChildren(...[
      stubs.length ? row('Nur in Google Drive', fmtBytes(stubs.reduce((s, r) => s + (r.size || 0), 0)), `(${stubs.length} Dokument${stubs.length === 1 ? '' : 'e'}, hier nicht belegt)`) : null,
      est?.usage != null ? row('Belegt auf diesem Gerät', fmtBytes(est.usage), est.quota ? `(von max. ${fmtBytes(est.quota)})` : '') : row('Belegt auf diesem Gerät', 'nicht verfügbar'),
      row('Notizen und Dokumente', fmtBytes(docBytes), `(${docs.filter(r => r.kind !== 'folder').length})`),
      pdfLocal ? row('Original-PDFs', fmtBytes(pdfLocal), `(${pdfN} Datei${pdfN === 1 ? '' : 'en'})`) : null,
      pdfDrive ? row('PDFs nur in Google Drive', fmtBytes(pdfDrive), '(hier nicht belegt)') : null,
      baseBytes ? row('Sync-Abgleichstand', fmtBytes(baseBytes)) : null,
      calBytes ? row('Kalender', fmtBytes(calBytes)) : null,
      appBytes ? row('App (offline)', fmtBytes(appBytes)) : null,
      biggest.length ? h('div', { class: 'form-label' }, 'Größte Dokumente') : null,
      ...biggest.map(([r, n]) => row(r.name, fmtBytes(n))),
      h('div', { class: 'hint' }, 'Der Gesamtwert ist eine Schätzung des Browsers (Safari rundet, manche Browser komprimieren); die Einzelwerte sind die Größe der gespeicherten Daten. Importierte PDFs brauchen am meisten Platz, weil ihre Seiten als Bilder gespeichert werden. Der Sync-Abgleichstand ist die lokale Kopie für das Zusammenführen zwischen Geräten.'),
    ].filter(Boolean)); // replaceChildren would turn null into the text "null"
  })();
  return box;
}

// "Große Dokumente nur in Google Drive" (offload.js)
function offloadBox() {
  const sizeCtl = h('div', { class: 'offload-size', hidden: !offloadOn() },
    h('div', { class: 'hint' }, 'Ab Größe:'),
    segmented(OFFLOAD_SIZES.map(n => [n, fmtBytes(n)]), offloadMin(), v => { settings.offloadMin = v; saveSettings(); }));
  return h('div', { class: 'group-box', style: { marginBottom: '10px' } },
    toggle('Große Dokumente nur in Google Drive', offloadOn(), v => { settings.offload = v; saveSettings(); sizeCtl.hidden = !v; }),
    sizeCtl,
    h('div', { class: 'hint' }, signedIn()
      ? 'Große Notizbücher und Dokumente (z. B. Literatur-PDFs), die du 3 Tage nicht geöffnet hast, bleiben nur in deinem Google Drive und werden beim Öffnen geladen (braucht Internet). Favoriten bleiben immer auf diesem Gerät. Einzeln steuerbar über ··· → „Nur in Google Drive behalten“ / „Auf dieses Gerät laden“.'
      : 'Wirkt nur mit Google-Drive-Sync: Große Dokumente bleiben dann nur in Drive, Favoriten immer auf dem Gerät.'),
    signedIn() && offloadOn() ? h('button', { class: 'pill-btn', onclick: async e => {
      e.currentTarget.disabled = true;
      const n = await runOffload({ force: true });
      toast(n ? `${n} Dokument(e) liegen jetzt nur in Google Drive` : 'Nichts zum Auslagern (zu klein, Favorit, kürzlich geöffnet oder noch nicht synchronisiert)', 4000);
      e.currentTarget.disabled = false;
    } }, icon('cloud', 16), 'Jetzt aufräumen') : null);
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
      h('div', { class: 'hint' }, 'An: Finger scrollen und zoomen, nur der Apple Pencil zeichnet.'),
      toggle('Pencil-Aufzeichnung (Diagnose)', recording(), v => setRecording(v)),
      h('div', { class: 'hint' }, 'Zeichnet die Rohdaten deiner Stiftstriche auf (Positionen, Druck, Neigung, Zeiten), damit die Handschrift am Computer nachgestellt und mit Goodnotes verglichen werden kann. Unten erscheint eine Leiste: Testsatz schreiben, dann „Sichern“ → Datei teilen oder in Dateien sichern. Bleibt nur auf diesem Gerät, bis du sie teilst.')),
    h('div', { class: 'form-label' }, 'Synchronisation'),
    account,
    h('div', { class: 'group-box', style: { marginTop: '10px' } },
      toggle('Goodnotes-Kopien in Drive', settings.gnCopies !== false, v => { settings.gnCopies = v; saveSettings(); }),
      h('div', { class: 'hint' }, 'Legt zu jedem Notizbuch eine .goodnotes-Datei im Drive-Ordner der App unter „Goodnotes“ ab (aktualisiert eine Minute nach der letzten Änderung). Öffnen in Goodnotes: Dateien-App → Google Drive.')),
    h('div', { class: 'form-label' }, 'Speicher'),
    offloadBox(),
    storageBox(),
    h('div', { class: 'about' }, folioMark(40), h('div', {}, h('div', { class: 'about-name' }, 'Folio'), h('div', { class: 'hint' }, `Make space for ideas. · Version ${APP_VERSION} · `, h('a', { href: 'datenschutz.html', target: '_blank', rel: 'noopener' }, 'Datenschutz')))));
  const ok = await sheet({ title: 'Einstellungen', body });
  if (ok) renderSidebar();
}
