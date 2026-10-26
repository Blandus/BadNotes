// Google Drive sync. Every record (notebook, text document, folder) is stored as <id>.json in a
// "Folio" folder (older installs: "BadNotes" / "Notizen-App"). Per record, changes made on this
// device and on Drive since the last common version (the "base") are merged (merge.js).
import { store, settings, saveSettings, emit, migrate, light } from './store.js';
import { uid } from './util.js';
import { merge3, mergeable } from './merge.js';
import { makeStub, withMeta, runOffload, configureOffload } from './offload.js';

const drive = { token: null, exp: 0, busy: false };
export const tokenValid = () => drive.token && Date.now() < drive.exp - 60000;
let beforeSync = async () => {};
let isLocked = () => false;
// Editor hooks: flush pending saves first; skip records being edited right now.
export function configureSync(opts) {
  beforeSync = opts.beforeSync; isLocked = opts.isLocked;
  configureOffload({ fetchRecord, signedIn, isOpen: opts.isOpen || (() => false) });
}

// One record straight from Drive (for documents kept only there, see offload.js).
async function fetchRecord(id) {
  await getToken(true);
  const folders = await findFolders();
  const f = pickNewest(await listFiles(`name='${id}.json' and ${inFolders(folders)} and trashed=false`)).byId.get(id);
  return f ? migrate(await (await gapi(`files/${f.id}?alt=media`)).json()) : null;
}

function setStatus(msg) { settings.syncStatus = msg; emit('sync', msg); }

// ---------- Sign-in ----------
// One OAuth client for everyone: it only identifies the app (allowed origin: the GitHub Pages
// site). Each person signs in with their own Google account and Folio gets a token for *their*
// Drive, limited to files Folio itself created (drive.file). No server; tokens last ~1 hour.
// settings.driveUsed = signed in on this device; settings.account = { email, name }.
export const CLIENT_ID = '498289443227-8pajeudml34vv14m2u7gc6t6li4o0n35.apps.googleusercontent.com';
const clientId = () => CLIENT_ID;
export const signedIn = () => !!settings.driveUsed;

function getToken(interactive) {
  return new Promise((res, rej) => {
    if (tokenValid()) return res(drive.token);
    if (!interactive) return rej(new Error('Zum Verbinden antippen'));
    if (!window.google?.accounts?.oauth2) return rej(new Error('Google-Login nicht geladen (offline?)'));
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: 'https://www.googleapis.com/auth/drive.file',
      ...(settings.account?.email ? { login_hint: settings.account.email } : {}),
      callback: r => {
        if (r.error) return rej(new Error(r.error));
        drive.token = r.access_token;
        drive.exp = Date.now() + r.expires_in * 1000;
        res(drive.token);
      },
      error_callback: err => rej(new Error(err.message || err.type)),
    });
    tc.requestAccessToken({ prompt: settings.driveUsed ? '' : 'consent' });
  });
}

// "Mit Google anmelden": consent once, remember the account, sync right away.
export async function signIn() {
  try {
    await getToken(true);
    settings.driveUsed = true;
    const about = await (await gapi('about?fields=user(emailAddress,displayName)')).json();
    settings.account = { email: about.user?.emailAddress || '', name: about.user?.displayName || '' };
    saveSettings(); emit('account');
    await sync(false);
  } catch (err) { setStatus('⚠ Anmeldung: ' + err.message); }
}
export function signOut() {
  if (drive.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(drive.token, () => {});
  drive.token = null; drive.exp = 0;
  settings.driveUsed = false; settings.account = null; settings.syncStatus = '';
  saveSettings(); emit('account'); setStatus('');
}
// After the ~1 h token expires, the next tap anywhere renews it (Google needs a user gesture for
// its sign-in window; with consent already given it closes by itself) and syncs.
document.addEventListener('click', () => {
  if (!signedIn() || tokenValid() || drive.busy || drive.renewing) return;
  drive.renewing = true;
  getToken(true).then(() => sync(false)).catch(() => {}).finally(() => { drive.renewing = false; });
}, true);

async function gapi(path, opts = {}) {
  const url = path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3/' + path;
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + drive.token, ...(opts.headers || {}) } });
  if (!r.ok) { if (r.status === 401) drive.token = null; throw new Error(`Drive ${r.status}`); }
  return r;
}

// Rules:
// - Exactly one Drive file per record (named <id>.json). If copies exist, the newest wins and
//   the others are moved to Drive's trash.
// - Each device keeps, per record, the version it last agreed on with Drive (base; its `updated`
//   is the version marker, stored in the file's appProperties too).
//   Changed only here → upload; changed only on Drive → download; changed on both → three-way
//   merge, result stored and uploaded; without a base (first sync of a record) the newer wins.
// - An upload only happens if the Drive copy is still the one this run read (re-checked right
//   before writing); otherwise the next run merges again. Records being edited are skipped.
// - Duplicate folders (same name, same place) and identical duplicate notebooks are merged.
const enc = encodeURIComponent;
const rUpd = f => +(f?.appProperties?.updated || 0);
const recId = f => f.name.replace(/\.json$/, '');

// All app folders ("Folio" / older "BadNotes", "Notizen-App"), oldest first (two devices may each have created one on first sync).
// The oldest is where new files go; files in all of them are read.
async function findFolders() {
  // "BadNotes" and "Notizen-App" are folder names of earlier versions; they stay in use where they exist.
  const q = "(name='Folio' or name='BadNotes' or name='Notizen-App') and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const r = await (await gapi(`files?q=${enc(q)}&orderBy=createdTime&fields=files(id,createdTime)`)).json();
  if (r.files.length) return r.files.map(f => f.id);
  const f = await (await gapi('files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Folio', mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  return [f.id];
}

const inFolders = folders => `(${folders.map(id => `'${id}' in parents`).join(' or ')})`;

async function listFiles(q) {
  const files = [];
  let pageToken = '';
  do {
    const r = await (await gapi(`files?q=${enc(q)}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${pageToken ? '&pageToken=' + pageToken : ''}`)).json();
    files.push(...r.files);
    pageToken = r.nextPageToken;
  } while (pageToken);
  return files;
}

// Newest file per record id; all other copies are duplicates.
function pickNewest(files) {
  const byId = new Map(), dupes = [];
  for (const f of files) {
    const id = recId(f), cur = byId.get(id);
    if (!cur) { byId.set(id, f); continue; }
    const newer = rUpd(f) > rUpd(cur) || (rUpd(f) === rUpd(cur) && f.id < cur.id);
    dupes.push(newer ? cur : f);
    if (newer) byId.set(id, f);
  }
  return { byId, dupes };
}

// Uploads rec only if the Drive copy is still the version this sync run started from
// (expected: its `updated`, or null for "no copy yet"). Looks the copy up again right before
// writing; if another device wrote in the meantime, nothing is written and the next run merges.
// Returns true if written.
async function pushIfUnchanged(rec, folders, expected) {
  const { byId } = pickNewest(await listFiles(`name='${rec.id}.json' and ${inFolders(folders)} and trashed=false`));
  const cur = byId.get(rec.id);
  if (cur && rUpd(cur) !== expected) return false;
  const meta = cur
    ? { appProperties: { updated: String(rec.updated) } }
    : { name: rec.id + '.json', parents: [folders[0]], appProperties: { updated: String(rec.updated) } };
  const b = 'bnd' + uid();
  // Blob parts instead of one concatenated string: a large document is held as text only once
  const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${b}\r\nContent-Type: application/json\r\n\r\n`, JSON.stringify(rec), `\r\n--${b}--`]);
  await gapi(`https://www.googleapis.com/upload/drive/v3/files${cur ? '/' + cur.id : ''}?uploadType=multipart&fields=id`, {
    method: cur ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + b },
    body,
  });
  return true;
}

const trash = id => gapi(`files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });

// ---------- Goodnotes copies ----------
// Optional (settings.gnCopies, on by default): one .goodnotes file per notebook in the Drive
// folder "<app folder>/Goodnotes", for opening in Goodnotes (Files app → Google Drive). Each copy
// remembers its notebook and version (appProperties gnFor / updated). A copy is rebuilt once its
// notebook has not changed for a minute, renamed with it, and trashed when the notebook is
// deleted. Building is slow (backgrounds are rendered), so only a few are built per sync run.
const GN_FOLDER = 'Goodnotes', GN_QUIET_MS = 60000, GN_PER_RUN = 3;
const gnName = r => (r.name || 'Folio').replace(/[\\/:*?"<>|]/g, '_') + '.goodnotes';

async function gnFolder(parent) {
  const q = `name='${GN_FOLDER}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`;
  const r = await (await gapi(`files?q=${enc(q)}&orderBy=createdTime&fields=files(id)`)).json();
  if (r.files.length) return r.files[0].id;
  const f = await (await gapi('files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: GN_FOLDER, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
  })).json();
  return f.id;
}

// Returns the number of copies written.
export async function syncGoodnotesCopies(folders, local) {
  const dir = await gnFolder(folders[0]);
  const copies = new Map();
  for (const f of await listFiles(`'${dir}' in parents and trashed=false`)) {
    const id = f.appProperties?.gnFor;
    if (!id) continue;
    const cur = copies.get(id);
    if (cur && rUpd(cur) >= rUpd(f)) { await trash(f.id); continue; } // two devices wrote one each
    if (cur) await trash(cur.id);
    copies.set(id, f);
  }
  const { notebookToGoodnotes } = await import('./goodnotes-export.js');
  let built = 0;
  for (const r of local.values()) {
    if (r.kind !== 'notebook' && r.kind !== 'textdoc') continue;
    const copy = copies.get(r.id);
    if (r.deleted || r.trashed) { if (copy) await trash(copy.id); continue; }
    if (copy && (rUpd(copy) >= r.updated || r.offloaded)) {
      if (copy.name !== gnName(r)) {
        await gapi(`files/${copy.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: gnName(r) }) });
      }
      continue;
    }
    if (r.offloaded || Date.now() - r.updated < GN_QUIET_MS || built >= GN_PER_RUN) continue; // stubs have no content to build from
    const full = r.light ? await store.get(r.id) : r; // loaded only for building, dropped afterwards
    if (!full || full.offloaded) continue;
    const blob = await notebookToGoodnotes(full, { quiet: true });
    const props = { gnFor: r.id, updated: String(r.updated) };
    const meta = copy ? { name: gnName(r), appProperties: props } : { name: gnName(r), parents: [dir], appProperties: props };
    const b = 'bnd' + uid();
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      blob, `\r\n--${b}--`]);
    await gapi(`https://www.googleapis.com/upload/drive/v3/files${copy ? '/' + copy.id : ''}?uploadType=multipart&fields=id`, {
      method: copy ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body,
    });
    built++;
  }
  return built;
}

// ---------- Duplicate merging (pure, deterministic) ----------
// Both devices must make the same decision, so the record with the smallest id is always kept.
const contentKey = pages => JSON.stringify(pages, (k, v) => (k === 'id' ? undefined : v));
const tombstone = (r, now) => ({ kind: r.kind, id: r.id, name: r.name, deleted: true, updated: now, pages: [] });

// Notebook content equality: records may be light (no pages), then both are loaded one at a time.
const samePages = (a, b) => contentKey(a.pages) === contentKey(b.pages);
async function sameContent(a, b) {
  if (!a.light && !b.light) return samePages(a, b);
  const fa = await store.get(a.id), fb = await store.get(b.id);
  return !!fa && !!fb && samePages(fa, fb);
}

export async function mergeDuplicates(records, now = Date.now(), same = samePages) {
  const live = new Map(records.filter(r => !r.deleted && !r.trashed).map(r => [r.id, r]));
  const changed = new Map();
  const groupBy = (kind, key) => {
    const g = new Map();
    for (const r of live.values()) if (r.kind === kind) { const k = key(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    return [...g.values()].filter(x => x.length > 1).map(x => x.sort((a, b) => (a.id < b.id ? -1 : 1)));
  };
  // Folders: same name at the same level → one folder; contents move into the kept one.
  // Repeat, since merging can bring sub-folders of the same name together.
  for (let groups = groupBy('folder', r => `${r.parent || ''}|${r.name.trim().toLowerCase()}`); groups.length;
    groups = groupBy('folder', r => `${r.parent || ''}|${r.name.trim().toLowerCase()}`)) {
    for (const [keep, ...rest] of groups) for (const d of rest) {
      for (const c of live.values()) if (c.parent === d.id) { c.parent = keep.id; c.updated = now; changed.set(c.id, c); }
      live.delete(d.id);
      changed.set(d.id, tombstone(d, now));
    }
  }
  // Notebooks: only exact copies (same name, same place, same content) are merged.
  // (stubs of documents kept only in Drive have no content to compare: never merged)
  // Candidates by name, place and page count; the content itself is compared per pair.
  for (const [keep, ...rest] of groupBy('notebook', r => (r.offloaded ? 'stub|' + r.id : `${r.parent || ''}|${r.name.trim().toLowerCase()}|${r.pageCount ?? r.pages?.length}`))) {
    for (const d of rest) if (await same(keep, d)) { live.delete(d.id); changed.set(d.id, tombstone(d, now)); }
  }
  return [...changed.values()];
}

export async function sync(interactive) {
  if (drive.busy) return;
  drive.busy = true;
  try {
    await getToken(interactive);
    if (!settings.driveUsed) { settings.driveUsed = true; saveSettings(); }
    if (!settings.account) { // signed in with an older version: look the account up once
      try { const u = (await (await gapi('about?fields=user(emailAddress,displayName)')).json()).user; settings.account = { email: u?.emailAddress || '', name: u?.displayName || '' }; saveSettings(); emit('account'); } catch {}
    }
    setStatus('Synchronisiere…');
    await beforeSync();
    const folders = await findFolders();
    // only record files (the folder also holds the "Goodnotes" sub-folder)
    const { byId: remote, dupes } = pickNewest((await listFiles(`${inFolders(folders)} and trashed=false`)).filter(f => f.name.endsWith('.json')));

    // Light records only (no pages/images): a full document is loaded just when it has to be
    // uploaded or merged, and dropped again right after — never the whole library at once.
    // Bases are likewise read one at a time.
    const local = new Map((await store.list()).map(n => [n.id, n]));
    const remoteUpd = new Map([...remote].map(([id, f]) => [id, rUpd(f)]));
    let down = 0, up = 0, mergedN = 0, conflictN = 0;
    const download = async f => migrate(await (await gapi(`files/${f.id}?alt=media`)).json());
    // local copy still the one read at the start? (an edit in the meantime is handled next run)
    const untouched = async (id, l) => (await store.getMeta(id))?.updated === l?.updated;
    const push = async rec => {
      if (rec.offloaded) return false; // a stub is never uploaded (its changes go onto the Drive version below)
      if (rec.light) rec = await store.get(rec.id);
      if (!rec || rec.offloaded) return false;
      if (!(await pushIfUnchanged(rec, folders, remoteUpd.has(rec.id) ? remoteUpd.get(rec.id) : null))) return false;
      remoteUpd.set(rec.id, rec.updated); await store.putBase(rec); up++;
      return true;
    };
    // Per record: what changed since the base (the version both sides last agreed on)?
    for (const id of new Set([...remote.keys(), ...local.keys()])) {
      const f = remote.get(id), l = local.get(id);
      const rU = f ? rUpd(f) : null;
      // Only in Drive (offload.js): the stub stands for Drive version remoteUpd. Its own changes are
      // metadata (name, folder, favourite …): put them onto the Drive version and upload that.
      // A newer Drive version just refreshes the stub. The content is never kept locally here.
      if (l?.offloaded) {
        if (!f) continue;
        const metaChanged = l.updated !== l.remoteUpd;
        if (!metaChanged && rU === l.remoteUpd) continue;
        if (isLocked(id)) continue;
        const rec = await download(f);
        if (!(await untouched(id, l))) continue;
        if (rec.deleted) { await store.put(rec); await store.putBase(rec); local.set(id, light(rec)); down++; emit('remote', id); continue; }
        let full = rec;
        if (metaChanged) {
          full = { ...withMeta(rec, l), updated: Math.max(Date.now(), rU + 1, l.updated + 1) };
          if (!(await pushIfUnchanged(full, folders, rU))) continue; // Drive changed meanwhile: next run
          remoteUpd.set(id, full.updated); up++;
        } else down++;
        const stub = await makeStub(full);
        if (!(await untouched(id, l))) continue;
        await store.put(stub); await store.deleteBase(id); local.set(id, light(stub));
        continue;
      }
      if (l && f && l.updated === rU) { // in step
        const bm = await store.getBase(id);
        if (bm?.updated !== rU) { const full = await store.get(id); if (full?.updated === rU) await store.putBase(full); }
        continue;
      }
      const b = await store.getBase(id);
      let lChanged = !!l && (!b || l.updated !== b.updated);
      let rChanged = !!f && (!b || rU !== b.updated);
      // No base yet (first sync of this record with this version): nothing to merge against —
      // as before, the newer version wins; from then on changes are merged.
      if (!b && l && f) { lChanged = l.updated > rU; rChanged = !lChanged; }
      if (!lChanged && !rChanged) continue;
      if (isLocked(id)) continue; // being edited right now: next run
      if (!lChanged) { // only Drive changed → take it
        const rec = await download(f);
        if (!(await untouched(id, l))) continue;
        await store.put(rec); await store.putBase(rec); local.set(id, light(rec)); down++;
        emit('remote', id);
        continue;
      }
      if (!rChanged) { await push(l); continue; } // only here changed → upload
      // Both changed: merge against the base.
      const rec = await download(f);
      const lFull = await store.get(id);
      if (!lFull || lFull.updated !== l.updated) continue; // edited meanwhile: next run
      let result;
      if (mergeable(b) && mergeable(lFull) && mergeable(rec)) {
        const { rec: m, notes } = merge3(b, lFull, rec);
        m.updated = Math.max(Date.now(), l.updated + 1, rU + 1);
        result = m; conflictN += notes.length;
      } else {
        // cannot be merged item by item: keep this version, add the other one as a separate copy
        const copy = { ...structuredClone(rec), id: uid(), name: `${rec.name || 'Dokument'} (Konflikt-Kopie)`, updated: Date.now() };
        await store.put(copy); local.set(copy.id, light(copy)); await push(copy);
        result = { ...lFull, updated: Math.max(Date.now(), rU + 1), conflicts: [...(lFull.conflicts || []), { at: Date.now(), text: `Auf zwei Geräten geändert – die andere Fassung liegt als „${copy.name}“ daneben.` }] };
        conflictN++;
      }
      if (!(await untouched(id, l))) continue;
      await store.put(result); local.set(id, light(result)); mergedN++; down++;
      emit('remote', id);
      await push(result);
    }
    // Merge duplicates (e.g. sample notebooks created separately on two devices) and share the result.
    const merged = await mergeDuplicates([...local.values()], Date.now(), sameContent);
    if (merged.length) {
      await store.putMany(merged);
      for (const r of merged) { emit('remote', r.id); await push(r); }
    }
    // Older duplicate copies of a file go to Drive's trash.
    for (const d of dupes) if (rUpd(d) <= rUpd(remote.get(recId(d)))) await trash(d.id);
    // Large documents only in Drive (Einstellungen → Speicher), at most once an hour.
    let offNote = '';
    try { const n = await runOffload(); if (n) offNote = ` · ${n} nur noch in Drive`; } catch {}
    let gnNote = '';
    if (settings.gnCopies !== false) {
      setStatus('Goodnotes-Kopien…');
      try { const n = await syncGoodnotesCopies(folders, local); if (n) gnNote = ` · ${n} Goodnotes-Kopie(n)`; }
      catch (err) { gnNote = ' · ⚠ Goodnotes-Kopie: ' + err.message; }
    }
    const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const fixed = merged.length ? ` · ${merged.filter(r => r.deleted).length} Duplikat(e) zusammengeführt` : '';
    const mergeNote = mergedN ? ` · ${mergedN} zusammengeführt${conflictN ? `, ${conflictN} Konflikt-Hinweis(e)` : ''}` : '';
    setStatus(`Synchronisiert ${time}${up || down ? ` · ↑${up} ↓${down}` : ''}${mergeNote}${fixed}${offNote}${gnNote}`);
    if (conflictN) emit('conflicts', conflictN);
  } catch (err) {
    setStatus('⚠ ' + err.message);
  } finally {
    drive.busy = false;
  }
}

let syncT;
export function scheduleSync() {
  if (!tokenValid()) return;
  clearTimeout(syncT);
  syncT = setTimeout(() => sync(false), 3000);
}
setInterval(() => { if (document.visibilityState === 'visible' && tokenValid()) sync(false); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && tokenValid()) sync(false); });
