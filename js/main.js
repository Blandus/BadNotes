import { uid } from './util.js';
import { store, settings, saveSettings, bus, newNotebook, newFolder, newPage, COVERS } from './store.js';
import { renderLibrary, applyTheme } from './library.js';
import { initEditor, openDoc, flushSave, isLocked, ed } from './editor.js';
import { initTools } from './tools.js';
import { configureSync, scheduleSync } from './sync.js';

// Sample content on first start, so every view has something to show.
async function seed() {
  if (settings.seeded || (await store.all()).length) { settings.seeded = true; saveSettings(); return; }
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
  await store.putMany([uni, welcome, math, cornell]);
  settings.seeded = true; saveSettings();
}

(async () => {
  applyTheme();
  await store.open();
  initEditor();
  initTools();
  configureSync({ beforeSync: flushSave, isLocked });
  bus.addEventListener('change', scheduleSync);
  await seed();
  if (settings.activeTab && ed.tabs.includes(settings.activeTab)) openDoc(settings.activeTab);
  else renderLibrary();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
