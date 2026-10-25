// Google Drive sync. Every record (notebook or folder) is stored as <id>.json in a
// "BadNotes" folder (formerly "Notizen-App"); per record the newer version (by `updated`) wins.
import { store, settings, saveSettings, emit } from './store.js';
import { uid } from './util.js';

const drive = { token: null, exp: 0, busy: false };
export const tokenValid = () => drive.token && Date.now() < drive.exp - 60000;
let beforeSync = async () => {};
let isLocked = () => false;
// Editor hooks: flush pending saves first; skip records being edited right now.
export function configureSync(opts) { beforeSync = opts.beforeSync; isLocked = opts.isLocked; }

function setStatus(msg) { settings.syncStatus = msg; emit('sync', msg); }

function getToken(interactive) {
  return new Promise((res, rej) => {
    if (tokenValid()) return res(drive.token);
    if (!interactive) return rej(new Error('Zum Verbinden auf Sync tippen'));
    if (!settings.clientId) return rej(new Error('Client-ID in den Einstellungen fehlt'));
    if (!window.google?.accounts?.oauth2) return rej(new Error('Google-Login nicht geladen (offline?)'));
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: settings.clientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
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

async function gapi(path, opts = {}) {
  const url = path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3/' + path;
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + drive.token, ...(opts.headers || {}) } });
  if (!r.ok) { if (r.status === 401) drive.token = null; throw new Error(`Drive ${r.status}`); }
  return r;
}

// Rules:
// - Exactly one Drive file per record (named <id>.json). If copies exist, the newest wins and
//   the others are moved to Drive's trash.
// - A record is uploaded only if its edit time ("updated") is newer than the copy on Drive —
//   re-checked right before writing, so a newer upload from another device is never overwritten.
// - Downloads likewise only replace local data with a newer version.
// - Duplicate folders (same name, same place) and identical duplicate notebooks are merged.
const enc = encodeURIComponent;
const rUpd = f => +(f?.appProperties?.updated || 0);
const recId = f => f.name.replace(/\.json$/, '');

// All app folders ("BadNotes" / old "Notizen-App"), oldest first (two devices may each have created one on first sync).
// The oldest is where new files go; files in all of them are read.
async function findFolders() {
  // "Notizen-App" is the folder name used before the app was called BadNotes; it stays readable.
  const q = "(name='BadNotes' or name='Notizen-App') and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const r = await (await gapi(`files?q=${enc(q)}&orderBy=createdTime&fields=files(id,createdTime)`)).json();
  if (r.files.length) return r.files.map(f => f.id);
  const f = await (await gapi('files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'BadNotes', mimeType: 'application/vnd.google-apps.folder' }),
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

// Uploads rec only if it is newer than the current Drive copy. Looks the copy up again right
// before writing (another device may have written in the meantime). Returns true if written.
async function pushIfNewer(rec, folders) {
  const { byId } = pickNewest(await listFiles(`name='${rec.id}.json' and ${inFolders(folders)} and trashed=false`));
  const cur = byId.get(rec.id);
  if (cur && rUpd(cur) >= rec.updated) return false;
  const meta = cur
    ? { appProperties: { updated: String(rec.updated) } }
    : { name: rec.id + '.json', parents: [folders[0]], appProperties: { updated: String(rec.updated) } };
  const b = 'bnd' + uid();
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(rec)}\r\n--${b}--`;
  await gapi(`https://www.googleapis.com/upload/drive/v3/files${cur ? '/' + cur.id : ''}?uploadType=multipart&fields=id`, {
    method: cur ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + b },
    body,
  });
  return true;
}

// ---------- Duplicate merging (pure, deterministic) ----------
// Both devices must make the same decision, so the record with the smallest id is always kept.
const contentKey = pages => JSON.stringify(pages, (k, v) => (k === 'id' ? undefined : v));
const tombstone = (r, now) => ({ kind: r.kind, id: r.id, name: r.name, deleted: true, updated: now, pages: [] });

export function mergeDuplicates(records, now = Date.now()) {
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
  for (const [, ...rest] of groupBy('notebook', r => `${r.parent || ''}|${r.name.trim().toLowerCase()}|${contentKey(r.pages)}`)) {
    for (const d of rest) { live.delete(d.id); changed.set(d.id, tombstone(d, now)); }
  }
  return [...changed.values()];
}

export async function sync(interactive) {
  if (drive.busy) return;
  drive.busy = true;
  try {
    await getToken(interactive);
    if (!settings.driveUsed) { settings.driveUsed = true; saveSettings(); }
    setStatus('Synchronisiere…');
    await beforeSync();
    const folders = await findFolders();
    const { byId: remote, dupes } = pickNewest(await listFiles(`${inFolders(folders)} and trashed=false`));

    const local = new Map((await store.all()).map(n => [n.id, n]));
    let down = 0, up = 0;
    // Download whatever is newer on Drive.
    for (const [id, f] of remote) {
      const l = local.get(id);
      if (l && rUpd(f) <= l.updated) continue;
      if (isLocked(id)) continue;
      const rec = await (await gapi(`files/${f.id}?alt=media`)).json();
      if (local.get(id) && rec.updated <= local.get(id).updated) continue; // file content older than its label
      await store.put(rec); local.set(id, rec); down++;
      emit('remote', id);
    }
    // Upload whatever is newer here (checked again against Drive right before writing).
    for (const [id, l] of local) {
      if (remote.has(id) && rUpd(remote.get(id)) >= l.updated) continue;
      if (await pushIfNewer(l, folders)) up++;
    }
    // Merge duplicates (e.g. sample notebooks created separately on two devices) and share the result.
    const merged = mergeDuplicates([...local.values()]);
    if (merged.length) {
      await store.putMany(merged);
      for (const r of merged) { emit('remote', r.id); if (await pushIfNewer(r, folders)) up++; }
    }
    // Older duplicate copies of a file go to Drive's trash.
    for (const d of dupes) if (rUpd(d) <= rUpd(remote.get(recId(d)))) {
      await gapi(`files/${d.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    }
    const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const fixed = merged.length ? ` · ${merged.filter(r => r.deleted).length} Duplikat(e) zusammengeführt` : '';
    setStatus(`Synchronisiert ${time}${up || down ? ` · ↑${up} ↓${down}` : ''}${fixed}`);
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
