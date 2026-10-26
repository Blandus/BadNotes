import { uid } from './util.js';
import { toRadius } from './ink.js';

// Shown in the settings, to check which version a device is running. Raise with each update.
export const APP_VERSION = '42';

export const PAGE_W = 1000;
export const FORMATS = { a4: { label: 'A4 Hoch', h: 1414 }, a4l: { label: 'A4 Quer', h: 707 }, letter: { label: 'Letter', h: 1294 } };
export const TEMPLATES = {
  blank: 'Leer', dots: 'Gepunktet', narrow: 'Liniert schmal', lined: 'Liniert breit', grid: 'Kariert',
  cornell: 'Cornell', notepad: 'Notizblock', twocol: 'Zwei Spalten', threecol: 'Drei Spalten',
};
export const TEMPLATE_SECTIONS = [
  ['Herkömmlich', ['blank', 'dots', 'narrow', 'lined', 'grid']],
  ['Schreibpapier', ['cornell', 'notepad', 'twocol', 'threecol']],
];
export const PAPERS = { white: { label: 'Weißes Papier', color: '#FFFFFF' }, yellow: { label: 'Gelbes Papier', color: '#FBF8EC' }, dark: { label: 'Dunkles Papier', color: '#2B2A2A' } };
// Cover colours derived from the Folio palette (navy, mist, sage, stone) plus a few quiet accents — no red
export const COVERS = ['#0F2747', '#3E6E9F', '#8EB8E6', '#6B8F7E', '#4F7A66', '#A7B4C6', '#D9D2C6', '#B8A68A', '#C9A35B', '#7D6B91', '#3A3F4A', '#E8E3D8'];

// ---------- Settings (per device) ----------
export let settings = {};
try { settings = JSON.parse(localStorage.getItem('settings') || '{}'); } catch {}
export function saveSettings() { try { localStorage.setItem('settings', JSON.stringify(settings)); } catch {} }

// ---------- Change notifications ----------
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

// Upgrades records written by older versions of the app.
export function migrate(r) {
  if (!r.kind) r.kind = 'notebook';
  if (r.kind === 'textdoc') r.blocks ||= [];
  if (r.kind === 'notebook') {
    r.pages ||= [];
    for (const p of r.pages) {
      if (p.strokes) { p.elements = p.strokes.map(s => ({ type: 'stroke', pen: 'fountain', ...s })); delete p.strokes; }
      p.elements ||= [];
      for (const e of p.elements) e.id ||= uid();
      // pressure strokes from older versions → radius per point (same look, see ink.js)
      if (p.elements.some(e => e.type === 'stroke' && !e.rad && e.tool !== 'highlighter' && !e.shape)) p.elements = p.elements.map(toRadius);
    }
  }
  return r;
}

// ---------- IndexedDB ----------
// v1: 'notebooks' (all records). v2: 'bases' — per record the version this device last agreed
// on with Google Drive (base of the three-way merge in sync.js); never shown, never uploaded.
let db;
function tx(mode, fn, name = 'notebooks') {
  return new Promise((res, rej) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => res(req.result);
    t.onerror = () => rej(t.error);
  });
}
export const store = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('notizen', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('notebooks')) d.createObjectStore('notebooks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('bases')) d.createObjectStore('bases', { keyPath: 'id' });
      };
      r.onsuccess = () => {
        db = r.result;
        // a newer version of the app (other tab) needs the database: let go and reload
        db.onversionchange = () => { db.close(); location.reload(); };
        res();
      };
      r.onerror = () => rej(r.error);
      // an older version of Folio is still open in another tab/window and holds the database
      r.onblocked = () => emit('dbblocked');
    });
  },
  async all() { return (await tx('readonly', s => s.getAll())).map(migrate); },
  async get(id) { const r = await tx('readonly', s => s.get(id)); return r && migrate(r); },
  async put(r) { await tx('readwrite', s => s.put(r)); emit('change', r.id); },
  async putMany(rs) { await tx('readwrite', s => { let q; for (const r of rs) q = s.put(r); return q || { result: null }; }); emit('change', null); },
  // sync bases (no change events: they are bookkeeping, not edits)
  async allBases() { return tx('readonly', s => s.getAll(), 'bases'); },
  async putBase(r) { await tx('readwrite', s => s.put(structuredClone(r)), 'bases'); },
};

export const newPage = (template = 'lined', h = 1414, paper) => ({ id: uid(), template, h, elements: [], ...(paper && paper !== 'white' ? { paper } : {}) });

export function newNotebook({ name, cover = null, template = 'lined', format = 'a4', paper, parent = null, pages } = {}) {
  const now = Date.now();
  return {
    kind: 'notebook', id: uid(), name: name || 'Unbenannt', parent, cover,
    created: now, updated: now, opened: now,
    pages: pages || [newPage(template, FORMATS[format].h, paper)],
  };
}

export function newFolder(name, parent = null) {
  const now = Date.now();
  return { kind: 'folder', id: uid(), name, parent, created: now, updated: now };
}

// Deep copy with fresh ids (pages and elements too).
export function cloneNotebook(r, name) {
  const c = structuredClone(r);
  c.id = uid(); c.name = name; c.created = c.updated = c.opened = Date.now();
  c.favorite = false;
  for (const p of c.pages) { p.id = uid(); for (const e of p.elements) e.id = uid(); }
  return c;
}
