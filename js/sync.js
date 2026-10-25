// Google Drive sync. Every record (notebook or folder) is stored as <id>.json in a
// "Notizen-App" folder; per record the newer version (by `updated`) wins.
import { store, settings, saveSettings, emit } from './store.js';
import { uid } from './util.js';

const drive = { token: null, exp: 0, folderId: null, busy: false };
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

async function ensureFolder() {
  if (drive.folderId) return;
  const q = encodeURIComponent("name='Notizen-App' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await (await gapi(`files?q=${q}&fields=files(id)`)).json();
  if (r.files.length) { drive.folderId = r.files[0].id; return; }
  const f = await (await gapi('files?fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Notizen-App', mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  drive.folderId = f.id;
}

async function upload(rec, fileId) {
  const meta = fileId
    ? { appProperties: { updated: String(rec.updated) } }
    : { name: rec.id + '.json', parents: [drive.folderId], appProperties: { updated: String(rec.updated) } };
  const b = 'bnd' + uid();
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(rec)}\r\n--${b}--`;
  await gapi(`https://www.googleapis.com/upload/drive/v3/files${fileId ? '/' + fileId : ''}?uploadType=multipart&fields=id`, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'multipart/related; boundary=' + b },
    body,
  });
}

export async function sync(interactive) {
  if (drive.busy) return;
  drive.busy = true;
  try {
    await getToken(interactive);
    if (!settings.driveUsed) { settings.driveUsed = true; saveSettings(); }
    setStatus('Synchronisiere…');
    await beforeSync();
    await ensureFolder();

    const remote = new Map();
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${drive.folderId}' in parents and trashed=false`);
      const r = await (await gapi(`files?q=${q}&pageSize=1000&fields=nextPageToken,files(id,name,appProperties)${pageToken ? '&pageToken=' + pageToken : ''}`)).json();
      for (const f of r.files) remote.set(f.name.replace(/\.json$/, ''), f);
      pageToken = r.nextPageToken;
    } while (pageToken);

    const local = new Map((await store.all()).map(n => [n.id, n]));
    let down = 0, up = 0;
    for (const [id, f] of remote) {
      const ru = +(f.appProperties?.updated || 0);
      const l = local.get(id);
      if (!l || ru > l.updated) {
        if (isLocked(id)) continue;
        const rec = await (await gapi(`files/${f.id}?alt=media`)).json();
        await store.put(rec); down++;
        emit('remote', id);
      } else if (l.updated > ru) {
        await upload(l, f.id); up++;
      }
    }
    for (const [id, l] of local) if (!remote.has(id)) { await upload(l); up++; }
    const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    setStatus(`Synchronisiert ${time}${up || down ? ` · ↑${up} ↓${down}` : ''}`);
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
