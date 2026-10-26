import { uid } from './util.js';
import { toRadius } from './ink.js';

// Shown in the settings, to check which version a device is running. Raise with each update.
export const APP_VERSION = '50';

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

// ---------- Light records ----------
// Lists (library, sync, calendar) never need the content of documents: pages with their
// background images can be hundreds of MB. A light record is everything except the content
// (pages / blocks), plus pageCount and light: true. Saving a light record (store.put) only
// updates the fields it has; the stored content stays untouched.
const CONTENT_KEYS = ['pages', 'blocks'];
export function light(r) {
  const out = { light: true };
  for (const k in r) if (!CONTENT_KEYS.includes(k)) out[k] = r[k];
  if (r.kind === 'notebook' || (!r.kind && r.pages)) {
    out.pageCount = r.offloaded ? r.pageCount : (r.pages || []).length;
    // original PDF files the pages are drawn from (pdfdoc.js); a stub keeps its own list
    if (!r.offloaded) {
      const files = new Set();
      for (const p of r.pages || []) if (p.pdf?.file) files.add(p.pdf.file);
      if (files.size) out.pdfFiles = [...files]; else delete out.pdfFiles;
    }
  }
  return out;
}
// a light record put onto the stored full one
function applyLight(full, l) {
  const out = { ...full };
  for (const k in l) if (k !== 'light' && k !== 'pageCount' && !CONTENT_KEYS.includes(k)) out[k] = l[k];
  for (const k in full) if (!(k in l) && !CONTENT_KEYS.includes(k) && k !== 'kind' && k !== 'id') delete out[k]; // fields removed in the light copy
  return out;
}

// ---------- IndexedDB ----------
// v1: 'notebooks' (full records). v2: 'bases' — per record the version this device last agreed
// on with Google Drive (base of the three-way merge in sync.js); never shown, never uploaded.
// v3: 'meta' — light copy of every record (kept in step by put/putMany), 'thumbs' — rendered
// library previews { id, updated, src }. v4: 'files' — original PDFs (pdfdoc.js).
let db;
// iOS/iPadOS closes a web app's database connection while it is in the background (and Safari
// sometimes loses it otherwise): the next access fails with "Failed to execute 'transaction' on
// 'IDBDatabase': The database connection is closing" or "Connection to Indexed Database server
// lost". Then the database is opened again and the operation repeated once.
const lostConnection = e => e && (e.name === 'InvalidStateError' || e.name === 'UnknownError'
  || /closing|closed|connection.*lost|server lost/i.test(e.message || ''));
let reopening = null;
function reopen() {
  try { db?.close(); } catch {}
  db = null;
  reopening ||= store.open().finally(() => { reopening = null; });
  return reopening;
}
async function retrying(op) {
  if (!db) await reopen();
  try { return await op(); } catch (e) {
    if (!lostConnection(e)) throw e;
    await reopen();
    return op();
  }
}
const begin = (names, mode) => db.transaction(names, mode); // throws InvalidStateError on a closed connection

function tx(mode, fn, name = 'notebooks') {
  return retrying(() => new Promise((res, rej) => {
    const t = begin(name, mode);
    const req = fn(Array.isArray(name) ? name.map(n => t.objectStore(n)) : t.objectStore(name));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Speichern abgebrochen'));
  }));
}
// Writes full records (or light ones onto the stored full records) and their light copies.
function write(rs) {
  return retrying(() => writeOnce(rs));
}
function writeOnce(rs) {
  return new Promise((res, rej) => {
    const t = begin(['notebooks', 'meta'], 'readwrite');
    const full = t.objectStore('notebooks'), meta = t.objectStore('meta');
    for (const r of rs) {
      if (!r.light) { full.put(r); meta.put(light(r)); continue; }
      const g = full.get(r.id);
      g.onsuccess = () => {
        if (!g.result) return; // gone meanwhile
        const merged = applyLight(g.result, r);
        full.put(merged); meta.put(light(merged));
      };
    }
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('Speichern abgebrochen'));
  });
}
// Builds 'meta' from the full records once (first start with v3), one record at a time.
function buildMeta() {
  return new Promise((res, rej) => {
    const t = db.transaction(['notebooks', 'meta'], 'readwrite');
    const meta = t.objectStore('meta');
    const cur = t.objectStore('notebooks').openCursor();
    cur.onsuccess = () => { const c = cur.result; if (!c) return; meta.put(light(c.value)); c.continue(); };
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
export const store = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('notizen', 4);
      let needMeta = false;
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('notebooks')) d.createObjectStore('notebooks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('bases')) d.createObjectStore('bases', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) { d.createObjectStore('meta', { keyPath: 'id' }); needMeta = true; }
        if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
      };
      r.onsuccess = async () => {
        db = r.result;
        // a newer version of the app (other tab) needs the database: let go and reload
        db.onversionchange = () => { db.close(); location.reload(); };
        // closed by the system (e.g. iOS in the background): reopened on the next access
        const mine = db;
        db.onclose = () => { if (db === mine) db = null; };
        try { if (needMeta) await buildMeta(); res(); } catch (err) { rej(err); }
      };
      r.onerror = () => rej(r.error);
      // an older version of Folio is still open in another tab/window and holds the database
      r.onblocked = () => emit('dbblocked');
    });
  },
  // light records of everything (cheap: no pages, no images)
  async list() { return tx('readonly', s => s.getAll(), 'meta'); },
  async getMeta(id) { return tx('readonly', s => s.get(id), 'meta'); },
  async count() { return tx('readonly', s => s.count(), 'meta'); },
  // full records one at a time (search, storage overview): fn(record) for each
  each(fn, name = 'notebooks') {
    return retrying(() => new Promise((res, rej) => {
      const t = begin(name, 'readonly');
      const cur = t.objectStore(name).openCursor();
      cur.onsuccess = () => { const c = cur.result; if (!c) return; try { fn(name === 'notebooks' ? migrate(c.value) : c.value); } catch {} c.continue(); };
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    }));
  },
  async get(id) { const r = await tx('readonly', s => s.get(id)); return r && migrate(r); },
  async put(r) { await write([r]); emit('change', r.id); },
  async putMany(rs) { if (rs.length) await write(rs); emit('change', null); },
  // original PDF files { id, blob (null when kept only in Drive), size, name, uploaded, created }
  async getFile(id) { return tx('readonly', s => s.get(id), 'files'); },
  async putFile(f) { await tx('readwrite', s => s.put(f), 'files'); },
  async deleteFile(id) { await tx('readwrite', s => s.delete(id), 'files'); },
  async listFiles() { // without the bytes: the Blob handles stay on disk until read
    return tx('readonly', s => s.getAll(), 'files');
  },
  // rendered library previews
  async getThumb(id) { return tx('readonly', s => s.get(id), 'thumbs'); },
  async putThumb(t) { await tx('readwrite', s => s.put(t), 'thumbs'); },
  // sync bases (no change events: they are bookkeeping, not edits)
  async allBases() { return tx('readonly', s => s.getAll(), 'bases'); },
  async putBase(r) { await tx('readwrite', s => s.put(structuredClone(r)), 'bases'); },
  async getBase(id) { return tx('readonly', s => s.get(id), 'bases'); },
  async deleteBase(id) { await tx('readwrite', s => s.delete(id), 'bases'); },
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
