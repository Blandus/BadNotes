// "Speicher optimieren": large documents are kept only in Google Drive.
//
// A document that is fully synced (its local version equals the sync base, i.e. what is on
// Drive) can be replaced locally by a stub: all fields except the content (pages / blocks), plus
//   offloaded: true, remoteUpd (the Drive version the stub stands for), size (bytes of the full
//   record), pageCount, thumb (small JPEG of the first page for the library).
// Opening, duplicating or exporting a stub loads the full document from Drive first (ensureLocal).
// Changes to a stub (rename, move, favourite, trash) are metadata only; sync.js puts them onto
// the Drive version and uploads that — a stub itself is never uploaded.
// Automatic rule (after a sync, at most once per hour): notebooks and text documents larger than
// the threshold, not a favourite, not opened in the last 3 days, not open in a tab.
// Favourites always stay on the device; marking a stub as favourite downloads it.
import { store, settings, emit } from './store.js';
import { renderThumb } from './render.js';
import { toast } from './ui.js';

export const CONTENT = { notebook: 'pages', textdoc: 'blocks' };
// fields a stub keeps in sync with the full document (everything except the content)
export const META = ['name', 'parent', 'favorite', 'trashed', 'trashedBy', 'cover', 'color', 'icon', 'opened', 'conflicts'];
const STUB_ONLY = ['offloaded', 'remoteUpd', 'size', 'pageCount', 'thumb'];
const RECENT_MS = 3 * 86400000;
export const OFFLOAD_SIZES = [2e6, 5e6, 20e6];
export const offloadOn = () => settings.offload !== false;
export const offloadMin = () => (OFFLOAD_SIZES.includes(settings.offloadMin) ? settings.offloadMin : 5e6);

// Hooks from sync.js (avoids a circular import): fetchRecord(id) → full record from Drive.
let hooks = { fetchRecord: null, signedIn: () => false, isOpen: () => false };
export function configureOffload(h) { hooks = { ...hooks, ...h }; }

export const recordSize = r => JSON.stringify(r).length;

async function thumbOf(r) {
  try {
    const c = document.createElement('canvas');
    if (r.kind === 'notebook') {
      if (r.cover || !r.pages?.[0]) return null; // covers are drawn from their colour
      await renderThumb(c, r.pages[0], 240);
    } else if (r.kind === 'textdoc') {
      const { renderTextThumb } = await import('./textdoc.js');
      renderTextThumb(c, r, 240);
    } else return null;
    return c.toDataURL('image/jpeg', 0.72);
  } catch { return null; }
}

export async function makeStub(r) {
  const key = CONTENT[r.kind];
  const stub = { ...r, [key]: [], offloaded: true, remoteUpd: r.updated, size: recordSize(r), thumb: await thumbOf(r) };
  if (r.kind === 'notebook') stub.pageCount = r.pages.length;
  return stub;
}
// Metadata changes of a stub, put onto the full version from Drive.
export function withMeta(full, stub) {
  const out = { ...full };
  for (const k of META) { if (stub[k] === undefined) delete out[k]; else out[k] = stub[k]; }
  for (const k of STUB_ONLY) delete out[k];
  return out;
}

// Replace r by a stub if it is fully synced. Returns true if done.
export async function offload(r) {
  if (!CONTENT[r.kind] || r.offloaded || r.deleted) return false;
  const base = await store.getBase(r.id);
  if (!base || base.updated !== r.updated) return false; // not (yet) identical with Drive
  const full = await store.get(r.id); // r may be a light record (no content)
  if (full?.updated !== r.updated || full.offloaded) return false; // edited in the meantime
  await store.put(await makeStub(full));
  await store.deleteBase(r.id);
  return true;
}

// Full document for r: from the device (r may be a light record) or, for a stub, from Drive.
// Null if it can't be loaded now.
const loading = new Map();
export function ensureLocal(r) {
  if (!r) return Promise.resolve(null);
  if (!r.offloaded) return r.light ? store.get(r.id) : Promise.resolve(r);
  if (loading.has(r.id)) return loading.get(r.id);
  const p = (async () => {
    if (!hooks.signedIn()) { toast('„' + r.name + '“ liegt nur in Google Drive – bitte mit Google anmelden.', 4000); return null; }
    if (!navigator.onLine) { toast('„' + r.name + '“ liegt nur in Google Drive – zum Öffnen wird Internet gebraucht.', 4000); return null; }
    toast(`„${r.name}“ wird aus Google Drive geladen …`, 0);
    try {
      const remote = await hooks.fetchRecord(r.id);
      if (!remote || remote.deleted) { toast('In Google Drive nicht gefunden', 4000); return null; }
      const stub = (await store.get(r.id)) || r;
      if (!stub.offloaded) return stub; // loaded by someone else meanwhile
      await store.putBase(remote);
      let full = remote;
      // renamed/moved/favourited while it was only in Drive: keep those changes (sync uploads them)
      if (stub.updated !== stub.remoteUpd) full = { ...withMeta(remote, stub), updated: Math.max(Date.now(), remote.updated + 1) };
      await store.put(full);
      toast(`„${r.name}“ ist jetzt auf diesem Gerät`, 2000);
      return full;
    } catch (err) { toast('Laden fehlgeschlagen: ' + err.message, 5000); return null; }
  })().finally(() => loading.delete(r.id));
  loading.set(r.id, p);
  return p;
}

// Automatic rule. Candidates come from the light list; each is loaded and measured on its own,
// so the whole library is never in memory at once. Returns the number of stubs made.
let lastRun = 0;
export async function runOffload({ force = false } = {}) {
  if (!offloadOn() || !hooks.signedIn()) return 0;
  if (!force && Date.now() - lastRun < 3600000) return 0;
  lastRun = Date.now();
  const min = offloadMin();
  let n = 0;
  for (const r of await store.list()) {
    if (!CONTENT[r.kind] || r.offloaded || r.deleted || r.favorite) continue;
    if (hooks.isOpen(r.id) || Date.now() - (r.opened || 0) < RECENT_MS) continue;
    const full = await store.get(r.id);
    if (!full || recordSize(full) < min) continue;
    if (await offload(full)) n++;
  }
  if (n) emit('change', null);
  return n;
}
