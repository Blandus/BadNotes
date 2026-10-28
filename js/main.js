import { uid } from './util.js';
import { store, settings, saveSettings, bus, newNotebook, newFolder, newPage, COVERS } from './store.js';
import { toast } from './ui.js';
import { renderLibrary, applyTheme, importPdfFile, importFromClipboard } from './library.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { initEditor, activateTab, flushSave, isLocked, ed } from './editor.js';
import { initTools } from './tools.js';
import { configureSync, scheduleSync } from './sync.js';
import { openTextDoc, textLocked } from './textdoc.js';
import { openDeck, deckLocked, importCardsSheet } from './deck.js';

// Sample content on first start, so every view has something to show.
async function seed() {
  if (settings.seeded || await store.count()) { settings.seeded = true; saveSettings(); return; }
  const uni = newFolder('Uni');
  const text = (x, y, s, size = 24, color = '#1A1A1A', w = 760) => ({ id: uid(), type: 'text', x, y, w, size, color, text: s });
  const wave = (y, color) => ({
    id: uid(), type: 'stroke', tool: 'pen', pen: 'fountain', color, width: 3,
    points: Array.from({ length: 60 }, (_, i) => [130 + i * 12, y + Math.sin(i / 4) * 18, 0.35 + 0.4 * Math.abs(Math.sin(i / 7))]),
  });
  const p1 = newPage('lined');
  p1.elements = [
    text(130, 70, 'Erste Schritte', 44),
    text(130, 160, 'Wähle oben ein Werkzeug: Stift, Radierer, Textmarker, Formen, Lasso, Bild, Text oder Laserpointer. Tippe die aktive Farbe oder Stärke noch einmal an, um sie anzupassen.', 22, '#3A3A3C'),
    wave(330, '#1F4FD1'),
    { id: uid(), type: 'stroke', tool: 'highlighter', pen: 'ball', color: '#FFE14D', width: 20, points: [[130, 172, .5], [560, 172, .5]] },
    text(130, 420, 'Gesten auf dem iPad: Ein Finger scrollt, zwei Finger zoomen. Der Apple Pencil zeichnet.', 22, '#3A3A3C'),
    text(130, 520, 'Tastenkürzel am PC: P Stift · E Radierer · H Textmarker · S Formen · L Lasso · T Text · K Laser · Strg+Z/Y · Strg+C/X/V · Entf', 20, '#6E6E73'),
    { id: uid(), type: 'stroke', tool: 'pen', pen: 'ball', color: '#D12F2F', width: 3, shape: true, closed: true, points: [[130, 640, .5], [400, 640, .5], [400, 800, .5], [130, 800, .5]] },
    { id: uid(), type: 'stroke', tool: 'pen', pen: 'ball', color: '#1F8A4C', width: 3, shape: true, closed: true, points: Array.from({ length: 72 }, (_, i) => [600 + 110 * Math.cos(i / 72 * Math.PI * 2), 720 + 80 * Math.sin(i / 72 * Math.PI * 2), .5]) },
  ];
  const p2 = newPage('grid');
  p2.elements = [text(60, 50, 'Seite 2 – kariert', 32)];
  const welcome = newNotebook({ name: 'Willkommen', cover: COVERS[1], pages: [p1, p2] });
  const math = newNotebook({ name: 'Mathematik', cover: COVERS[6], template: 'grid', parent: uni.id });
  const cornell = newNotebook({ name: 'Vorlesungsnotizen', cover: COVERS[2], template: 'cornell', parent: uni.id });
  // Fixed ids and an old edit time: every device creates the *same* sample records, so sync
  // sees one record each (no duplicates), and any real edit or deletion elsewhere wins.
  const SEED_TIME = Date.UTC(2025, 0, 1);
  const ids = { [uni.id]: 'seed-ordner-uni', [welcome.id]: 'seed-willkommen', [math.id]: 'seed-mathematik', [cornell.id]: 'seed-vorlesungsnotizen' };
  for (const r of [uni, welcome, math, cornell]) {
    r.id = ids[r.id];
    if (r.parent) r.parent = ids[r.parent];
    r.created = r.updated = r.opened = SEED_TIME;
  }
  await store.putMany([uni, welcome, math, cornell]);
  settings.seeded = true; saveSettings();
}

// Drag a PDF, a .goodnotes file or a Goodnotes folder export (.zip) from Files (or the desktop) onto the app to import it.
const isPdf = f => f.type === 'application/pdf' || f.type === 'application/zip' || /\.(pdf|goodnotes|zip)$/i.test(f.name);
document.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) e.preventDefault(); });
document.addEventListener('drop', e => {
  const pdfs = [...e.dataTransfer.files].filter(isPdf);
  // a text file (.txt, .md, .json, .csv, .tsv): flashcards — into the open deck or a new one
  const txt = [...e.dataTransfer.files].find(f => /\.(txt|md|markdown|json|csv|tsv)$/i.test(f.name) || f.type.startsWith('text/'));
  if (!pdfs.length && txt) {
    e.preventDefault();
    (async () => {
      const deck = !document.getElementById('deck').hidden && settings.openDeck ? await store.get(settings.openDeck) : null;
      importCardsSheet({ deck, text: await txt.text() });
    })();
    return;
  }
  if (!pdfs.length) return;
  e.preventDefault();
  importPdfFile(pdfs[0]);
});

// After the shortcut "In Folio öffnen" has been used once, coming back to the app shows a
// one-tap import button for a few seconds (reading the clipboard needs a tap on iOS).
let clipHint = null;
function offerClipboardImport() {
  if (!settings.clipImport || document.querySelector('.backdrop')) return;
  clipHint?.remove();
  clipHint = h('button', { class: 'clip-hint', onclick: () => { clipHint.remove(); clipHint = null; importFromClipboard(); } },
    icon('paste', 18), 'PDF/Goodnotes einsetzen');
  document.body.append(clipHint);
  const el = clipHint;
  setTimeout(() => { if (clipHint === el) { el.remove(); clipHint = null; } }, 7000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') offerClipboardImport(); });

(async () => {
  applyTheme();
  bus.addEventListener('dbblocked', () => toast('Folio ist noch in einem anderen Tab oder Fenster (ältere Version) geöffnet. Bitte dort schließen, dann startet Folio hier.', 8000));
  await store.open();
  initEditor();
  initTools();
  configureSync({ beforeSync: flushSave, isLocked: id => isLocked(id) || textLocked(id) || deckLocked(id), isOpen: id => ed.tabs.some(t => t.id === id) || settings.openText === id || settings.openDeck === id });
  bus.addEventListener('change', scheduleSync);
  await seed();
  if (settings.openDeck) openDeck(settings.openDeck);
  else if (settings.openText) openTextDoc(settings.openText);
  else if (ed.tab && settings.activeTab) activateTab(ed.tab);
  else renderLibrary();
  offerClipboardImport();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
})();

// If iPadOS still shifts the page (e.g. when the keyboard opens), put it back at once: a page
// scrolled under the status bar gets blurred by the system.
addEventListener('scroll', () => { if (scrollY || scrollX) scrollTo(0, 0); }, { passive: true });
// The on-screen keyboard can shift the view without a scroll event; reset it when the keyboard
// closes, the visible area changes, or the app comes back to the foreground.
// To bring a text field above the keyboard iOS also scrolls the visible area (visualViewport,
// while window.scrollY stays 0) and containers that are not meant to scroll (overflow: hidden,
// e.g. body), and may leave them there after the keyboard closes: put all of them back.
const unshift = (from = document.activeElement) => {
  scrollTo(0, 0);
  for (let el = from?.parentElement; el; el = el.parentElement) {
    if ((el.scrollTop || el.scrollLeft) && /hidden|clip/.test(getComputedStyle(el).overflow)) { el.scrollTop = 0; el.scrollLeft = 0; }
  }
  for (const el of [document.documentElement, document.body]) { el.scrollTop = 0; el.scrollLeft = 0; }
};
addEventListener('focusout', e => setTimeout(() => unshift(e.target), 50));
// keyboard closed (also with the text field still focused, e.g. the iPad's hide-keyboard key)
const keyboardOpen = () => visualViewport && innerHeight - visualViewport.height > 80;
visualViewport?.addEventListener('resize', () => setTimeout(() => { if (!keyboardOpen()) unshift(); }, 50));
visualViewport?.addEventListener('resize', () => setTimeout(() => { if (!keyboardOpen()) unshift(); }, 400));
visualViewport?.addEventListener('scroll', () => { if (!document.activeElement?.matches('input, textarea, [contenteditable="true"]')) unshift(); });
addEventListener('orientationchange', () => setTimeout(unshift, 300));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') unshift(); });
// Dialogs only use the area above the on-screen keyboard (the page itself doesn't move, see
// above), so a rename field is never hidden behind the keyboard: --kb = keyboard height.
const keyboardInset = () => {
  const vv = visualViewport;
  const kb = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
  document.documentElement.style.setProperty('--kb', kb + 'px');
};
visualViewport?.addEventListener('resize', keyboardInset);
visualViewport?.addEventListener('scroll', keyboardInset);
