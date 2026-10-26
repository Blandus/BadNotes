// Week calendar ("Kalender" in the library sidebar).
//
// Sources, each shown with its colour and named in the event details:
// - Folio: own events, stored as records { kind: 'event' } and synced with Google Drive like
//   documents. Times are wall-clock times in the zone of the device that created them (tz).
//   Weekly repetition (optionally until a date); single occurrences can be changed or cancelled
//   (exceptions, keyed by the original date).
// - ICS: subscriptions (URL, refreshed by hand) and imported .ics files, stored as records
//   { kind: 'calfeed' } with their parsed events (ics.js); re-importing replaces the events of
//   the same import, so changes and cancellations arrive without duplicates. Many calendar
//   servers don't allow reading from a web page (no CORS) — then the feed can be added to Google
//   Calendar ("Per URL") and shown here through the Google connection.
// - Google Calendar (optional, separate consent from Drive): calendars to show, events of the
//   visible week; create/edit/delete on calendars the user may write to. The token and events
//   live only in memory (nothing cached, nothing stored).
import { $, h, uid, pickFile } from './util.js';
import { icon } from './icons.js';
import { store, settings, saveSettings, bus } from './store.js';
import { sheet, toast, segmented, confirmBox, toggle } from './ui.js';
import { parseICS, expandEvents, wallToMs, validTz } from './ics.js';
import { CLIENT_ID } from './sync.js';

export const CAL_KINDS = new Set(['event', 'calfeed']);
const HOUR = 44; // px per hour
const FOLIO_COLOR = '#3E6E9F';
const FEED_COLORS = ['#6B8F7E', '#C9A35B', '#7D6B91', '#4F7A66', '#B8A68A', '#8EB8E6'];
const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || null;

// ---------- Dates ----------
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
const parseHm = s => { const [hh, mi] = s.split(':').map(Number); return { h: hh, mi }; };
const dayAt = (ws, i) => { const d = new Date(ws); d.setDate(d.getDate() + i); return d; };
function weekStartOf(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
function isoWeek(t) {
  const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
const fmtDay = d => d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
const fmtTime = t => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

const cal = { ws: weekStartOf(Date.now()), scroll: null, records: [], gcache: new Map(), gerr: '', loadingG: false };

// ---------- Own events ----------
function ownTimes(r, dateStr, start, end) {
  const tz = validTz(r.tz || '') ? r.tz : null;
  const s = wallToMs({ ...parseYmd(dateStr), ...parseHm(start) }, tz);
  let e = wallToMs({ ...parseYmd(dateStr), ...parseHm(end) }, tz);
  if (e <= s) e += 86400000; // ends after midnight
  return [s, e];
}
function expandOwn(r, from, to) {
  const out = [];
  const add = (dateStr, x, occDate) => {
    const [s, e] = ownTimes(r, x.date || dateStr, x.start || r.start, x.end || r.end);
    if (e > from && s < to) out.push({ key: `f|${r.id}|${occDate}`, source: 'folio', rec: r, occDate, title: x.title || r.title || '(ohne Titel)', start: s, end: e, color: FOLIO_COLOR, srcName: 'Folio', editable: true, recurring: !!r.weekly });
  };
  if (!r.weekly) { add(r.date, {}, r.date); return out; }
  const first = parseYmd(r.date);
  const until = r.until ? wallToMs({ ...parseYmd(r.until), h: 23, mi: 59 }, null) : Infinity;
  const base = Date.UTC(first.y, first.m - 1, first.d);
  // start a little before the window instead of at the first occurrence
  const k0 = Math.max(0, Math.floor((from - wallToMs(first, null)) / (7 * 86400000)) - 1);
  for (let k = k0; k < k0 + 60; k++) {
    const d = new Date(base + k * 7 * 86400000);
    const ds = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const [s] = ownTimes(r, ds, r.start, r.end);
    if (s > until || s >= to + 86400000) break;
    const x = r.exceptions?.[ds];
    if (x?.cancelled) continue;
    add(ds, x || {}, ds);
  }
  return out;
}

// ---------- Google Calendar ----------
// Separate token with only the calendar scopes; Drive sign-in is not affected (and works without it).
const G_SCOPES = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events';
const g = { token: null, exp: 0 };
const gValid = () => g.token && Date.now() < g.exp - 60000;
function gToken() { // must run in a user gesture (tap)
  return new Promise((res, rej) => {
    if (gValid()) return res(g.token);
    if (!window.google?.accounts?.oauth2) return rej(new Error('Google-Login nicht geladen (offline?)'));
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID, scope: G_SCOPES, include_granted_scopes: false,
      ...(settings.account?.email ? { login_hint: settings.account.email } : {}),
      callback: r => {
        if (r.error) return rej(new Error(r.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(r, ...G_SCOPES.split(' '))) return rej(new Error('Kalender-Zugriff nicht vollständig erlaubt'));
        g.token = r.access_token; g.exp = Date.now() + r.expires_in * 1000; res(g.token);
      },
      error_callback: err => rej(new Error(err.message || err.type)),
    });
    tc.requestAccessToken({ prompt: settings.gcal?.on ? '' : 'consent' });
  });
}
async function gapi(path, opts = {}) {
  const r = await fetch('https://www.googleapis.com/calendar/v3/' + path, {
    ...opts, cache: 'no-store', headers: { Authorization: 'Bearer ' + g.token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (r.status === 401) { g.token = null; throw new Error('Google-Sitzung abgelaufen'); }
  if (!r.ok) throw new Error(`Google Kalender ${r.status}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}
const gcfg = () => (settings.gcal ||= { on: false, cals: {}, target: 'folio' });
// Calendars added in Google "per URL" are often named after their address (with secret tokens): show only the server
const calName = c => { if (!/^(https?|webcal):\/\//i.test(c.name)) return c.name; try { return 'Abo von ' + new URL(c.name.replace(/^webcal:/i, 'https:')).hostname; } catch { return 'Abo per URL'; } };
const writable = c => c && (c.role === 'writer' || c.role === 'owner');

async function gListCalendars() {
  const items = [];
  let tok = '';
  do {
    const r = await gapi(`users/me/calendarList?maxResults=250${tok ? '&pageToken=' + encodeURIComponent(tok) : ''}`);
    items.push(...(r.items || [])); tok = r.nextPageToken;
  } while (tok);
  const cfg = gcfg(), cals = {};
  for (const c of items) {
    if (c.accessRole === 'freeBusyReader') continue;
    cals[c.id] = { name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#8EB8E6', role: c.accessRole, primary: !!c.primary, on: cfg.cals[c.id] ? cfg.cals[c.id].on : !!(c.primary || c.selected) };
  }
  cfg.cals = cals;
  if (cfg.target !== 'folio' && !writable(cals[cfg.target])) cfg.target = 'folio';
  saveSettings();
}

async function gLoadWeek(force) {
  const cfg = gcfg();
  if (!cfg.on || !gValid()) return;
  const key = cal.ws;
  if (!force && cal.gcache.has(key)) return;
  const from = new Date(cal.ws), to = dayAt(cal.ws, 7);
  const out = [];
  cal.loadingG = true;
  try {
    for (const [id, c] of Object.entries(cfg.cals)) {
      if (!c.on) continue;
      let tok = '';
      do {
        const q = `timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}&singleEvents=true&orderBy=startTime&maxResults=2500${tok ? '&pageToken=' + encodeURIComponent(tok) : ''}`;
        const r = await gapi(`calendars/${encodeURIComponent(id)}/events?${q}`);
        for (const e of r.items || []) {
          if (e.status === 'cancelled' || !e.start) continue;
          const allDay = !!e.start.date;
          const s = allDay ? wallToMs(parseYmd(e.start.date), null) : Date.parse(e.start.dateTime);
          const en = allDay ? wallToMs(parseYmd(e.end?.date || e.start.date), null) : Date.parse(e.end?.dateTime || e.start.dateTime);
          out.push({
            key: `g|${id}|${e.id}`, source: 'google', calId: id, id: e.id, recurringEventId: e.recurringEventId || null,
            title: e.summary || '(ohne Titel)', location: e.location || '', description: e.description || '', start: s, end: Math.max(en, s), allDay,
            color: c.color, srcName: 'Google: ' + calName(c), editable: writable(c) && (!e.eventType || e.eventType === 'default'), recurring: !!e.recurringEventId,
          });
        }
        tok = r.nextPageToken;
      } while (tok);
    }
    cal.gcache.set(key, out); cal.gerr = '';
  } catch (err) { cal.gerr = err.message; }
  cal.loadingG = false;
}

async function gConnect() {
  try {
    await gToken();
    gcfg().on = true; saveSettings();
    await gListCalendars();
    cal.gcache.clear(); await gLoadWeek(true);
    toast('Google Kalender verbunden');
  } catch (err) { toast('⚠ ' + err.message, 4000); }
  render();
}
function gDisconnect() {
  if (g.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(g.token, () => {});
  g.token = null; g.exp = 0;
  settings.gcal = { on: false, cals: {}, target: 'folio' }; saveSettings();
  cal.gcache.clear(); render();
}
// After the ~1 h token runs out, a tap renews it (Google needs a user gesture).
async function gReload() {
  try { await gToken(); cal.gcache.clear(); await gLoadWeek(true); } catch (err) { cal.gerr = err.message; }
  render();
}

const gTimes = (date, start, end) => {
  const tz = localTz();
  let endDate = date;
  if (end <= start) { const d = new Date(date + 'T00:00'); d.setDate(d.getDate() + 1); endDate = ymd(d); }
  return { start: { dateTime: `${date}T${start}:00`, timeZone: tz }, end: { dateTime: `${endDate}T${end}:00`, timeZone: tz } };
};

// ---------- ICS feeds ----------
const httpsUrl = u => u.trim().replace(/^webcal:\/\//i, 'https://');
async function fetchFeed(url) {
  let r;
  try { r = await fetch(httpsUrl(url), { cache: 'no-store', credentials: 'omit', redirect: 'follow' }); }
  catch { throw new Error('Der Kalender-Server erlaubt den Abruf aus dem Browser nicht (CORS) oder ist nicht erreichbar.'); }
  if (!r.ok) throw new Error(`Abruf fehlgeschlagen (${r.status}).`);
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Keine iCalendar-Daten.');
  return parseICS(text);
}
async function refreshFeeds() {
  for (const f of cal.records.filter(r => r.kind === 'calfeed' && r.url && !r.deleted)) {
    try { const p = await fetchFeed(f.url); Object.assign(f, { events: p.events, fetched: Date.now(), error: '', updated: Date.now() }); }
    catch (err) { Object.assign(f, { error: err.message, updated: Date.now() }); }
    await store.put(f);
  }
}
async function subscribe(url) {
  url = httpsUrl(url);
  if (!/^https:\/\//i.test(url)) { toast('Bitte eine https:// oder webcal:// Adresse eingeben'); return false; }
  try {
    const p = await fetchFeed(url);
    const now = Date.now();
    await store.put({ kind: 'calfeed', id: uid(), name: p.name || new URL(url).hostname, url, color: nextColor(), events: p.events, fetched: now, created: now, updated: now });
    toast(`Abonniert: ${p.events.length} Termine`);
    return true;
  } catch (err) {
    await sheet({
      title: 'Abo nicht möglich', done: 'OK', cancel: false,
      body: h('div', { class: 'cal-help' },
        h('p', {}, err.message),
        h('p', {}, 'So geht es trotzdem: Füge den Kalender in Google Kalender über „Weitere Kalender → + → Per URL“ hinzu und verbinde hier Google Kalender. Er erscheint dann (nur lesbar) in Folio.'),
        h('p', {}, h('a', { href: 'https://support.google.com/calendar/answer/37100?hl=de', target: '_blank', rel: 'noopener' }, 'Google-Hilfe: Kalender per URL hinzufügen'))),
    });
    return false;
  }
}
async function importFile() {
  const f = await pickFile('.ics,text/calendar');
  if (!f) return;
  let p;
  try { p = parseICS(await f.text()); } catch { return toast('Datei konnte nicht gelesen werden'); }
  if (!p.events.length) return toast('Keine Termine in der Datei');
  const name = p.name || f.name.replace(/\.ics$/i, '');
  const now = Date.now();
  const same = cal.records.find(r => r.kind === 'calfeed' && !r.deleted && !r.url && r.name === name);
  if (same && await confirmBox('Schon importiert', `„${name}“ wurde schon importiert. Mit dieser Datei aktualisieren (Änderungen und Absagen werden übernommen)?`, 'Aktualisieren')) {
    Object.assign(same, { events: p.events, fetched: now, updated: now });
    await store.put(same);
  } else if (!same) {
    await store.put({ kind: 'calfeed', id: uid(), name, url: null, color: nextColor(), events: p.events, fetched: now, created: now, updated: now });
  } else return;
  const unsupported = p.events.filter(e => e.unsupported).length;
  toast(`${p.events.length} Termine importiert${unsupported ? ` · ${unsupported} mit nicht unterstützter Wiederholung (nur erster Termin)` : ''}`, 4000);
}
const nextColor = () => FEED_COLORS[cal.records.filter(r => r.kind === 'calfeed' && !r.deleted).length % FEED_COLORS.length];
const tombstone = r => ({ kind: r.kind, id: r.id, name: r.name, deleted: true, updated: Date.now(), pages: [] });

// ---------- Occurrences of the visible week ----------
function weekItems() {
  const from = cal.ws, to = dayAt(cal.ws, 7).getTime();
  const items = [];
  for (const r of cal.records) {
    if (r.deleted) continue;
    if (r.kind === 'event') items.push(...expandOwn(r, from, to));
    if (r.kind === 'calfeed') for (const o of expandEvents(r.events || [], from, to)) {
      items.push({ ...o, key: `i|${r.id}|${o.key}`, source: 'ics', feed: r, color: r.color || FEED_COLORS[0], srcName: (r.url ? 'Abo: ' : 'Import: ') + r.name, editable: false });
    }
  }
  if (gcfg().on) items.push(...(cal.gcache.get(cal.ws) || []));
  // the same appointment from two sources (e.g. a feed imported and also shown via Google): once
  const seen = new Set();
  return items.filter(o => { const k = `${o.title.trim().toLowerCase()}|${o.start}|${o.end}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

// Columns for overlapping events within one day
function layout(list) {
  list.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s));
  let cluster = [], cols = [], clusterEnd = -Infinity;
  const close = () => { for (const x of cluster) x.n = cols.length; cluster = []; cols = []; };
  for (const x of list) {
    if (x.s >= clusterEnd) { close(); clusterEnd = -Infinity; }
    let c = cols.findIndex(end => end <= x.s);
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = x.e; x.col = c; cluster.push(x); clusterEnd = Math.max(clusterEnd, x.e);
  }
  close();
  return list;
}

// ---------- View ----------
let headEl, bodyEl;
export async function renderCalendar(head, content) {
  headEl = head; bodyEl = content;
  cal.records = (await store.all()).filter(r => CAL_KINDS.has(r.kind));
  if (gcfg().on && gValid() && !cal.gcache.has(cal.ws) && !cal.loadingG) gLoadWeek().then(render);
  draw();
}
const render = () => { if (headEl?.isConnected) renderCalendar(headEl, bodyEl); };

function go(ws) { cal.ws = ws; render(); }

function draw() {
  const ws = cal.ws, we = dayAt(ws, 6);
  const today = ymd(new Date());
  const nav = h('div', { class: 'cal-nav' },
    h('button', { class: 'iconbtn plain', title: 'Vorige Woche', 'aria-label': 'Vorige Woche', onclick: () => go(dayAt(ws, -7).getTime()) }, icon('chevronLeft', 20)),
    h('button', { class: 'pill-btn', onclick: () => go(weekStartOf(Date.now())) }, 'Heute'),
    h('button', { class: 'iconbtn plain', title: 'Nächste Woche', 'aria-label': 'Nächste Woche', onclick: () => go(dayAt(ws, 7).getTime()) }, icon('chevronRight', 20)),
    h('span', { class: 'cal-range' }, `KW ${isoWeek(ws)} · ${fmtDay(new Date(ws))} – ${fmtDay(we)} ${we.getFullYear()}`));
  const cfg = gcfg();
  const actions = h('div', { class: 'lib-actions' },
    cfg.on && !gValid() ? h('button', { class: 'pill-btn', title: 'Google-Kalender laden (Anmeldung erneuern)', onclick: gReload }, icon('sync', 16), 'Google laden') : null,
    h('button', { class: 'pill-btn', title: 'Abos und Google Kalender neu laden', onclick: async e => {
      const b = e.currentTarget; b.disabled = true;
      await refreshFeeds();
      if (cfg.on) { if (!gValid()) { try { await gToken(); } catch {} } cal.gcache.clear(); await gLoadWeek(true); }
      b.disabled = false; render(); toast('Aktualisiert');
    } }, icon('sync', 16), 'Aktualisieren'),
    h('button', { class: 'pill-btn', onclick: openSources }, icon('gear', 16), 'Quellen'),
    h('button', { class: 'pill-btn primary', onclick: () => editEvent(null, defaultSlot()) }, icon('plus', 16), 'Termin'));
  const titlebar = headEl.querySelector('.lib-titlebar');
  headEl.replaceChildren(...(titlebar ? [titlebar] : []), h('div', { class: 'lib-toolbar cal-toolbar' }, nav, h('div', { class: 'spacer' }), actions));

  const items = weekItems();
  const days = Array.from({ length: 7 }, (_, i) => dayAt(ws, i));
  const dayStart = days.map(d => d.getTime()), dayEnd = days.map((d, i) => dayAt(ws, i + 1).getTime());
  const allDay = days.map(() => []), timed = days.map(() => []);
  for (const o of items) {
    days.forEach((d, i) => {
      if (o.end <= dayStart[i] && !(o.end === o.start && o.start === dayStart[i]) || o.start >= dayEnd[i]) return;
      if (o.allDay || o.end - o.start >= 86400000 && o.start <= dayStart[i] && o.end >= dayEnd[i]) allDay[i].push(o);
      else timed[i].push({ o, s: Math.max(o.start, dayStart[i]), e: Math.max(Math.min(o.end, dayEnd[i]), Math.max(o.start, dayStart[i]) + 15 * 60000) });
    });
  }
  const evBtn = (o, style, cls = '') => h('button', {
    class: 'cal-ev ' + cls, style: { '--ec': o.color, ...style }, title: `${o.title} · ${o.allDay ? 'ganztägig' : fmtTime(o.start) + '–' + fmtTime(o.end)} · ${o.srcName}`,
    onclick: e => { e.stopPropagation(); openItem(o); },
  }, h('span', { class: 'cal-ev-title' }, o.title), o.allDay ? null : h('span', { class: 'cal-ev-time' }, `${fmtTime(o.start)}–${fmtTime(o.end)}`));

  const heads = h('div', { class: 'cal-row cal-heads' }, h('div', { class: 'cal-gutter' }),
    ...days.map(d => h('div', { class: 'cal-dayhead' + (ymd(d) === today ? ' today' : '') },
      h('span', { class: 'cal-dow' }, d.toLocaleDateString('de-DE', { weekday: 'short' })), h('span', { class: 'cal-dnum' }, d.getDate()))));
  const alldayRow = allDay.some(x => x.length) ? h('div', { class: 'cal-row cal-allday' }, h('div', { class: 'cal-gutter' }, 'ganztägig'),
    ...allDay.map(list => h('div', { class: 'cal-adcell' }, list.map(o => evBtn(o, {}, 'chip'))))) : null;

  const cols = days.map((d, i) => {
    const col = h('div', { class: 'cal-col' + (ymd(d) === today ? ' today' : ''), 'data-day': ymd(d) });
    for (const x of layout(timed[i])) {
      const top = (x.s - dayStart[i]) / 3600000 * HOUR, height = Math.max(18, (x.e - x.s) / 3600000 * HOUR - 2);
      // overlapping events share the column but stay readable: each one is wider than its share
      // and the later ones lie on top (like Google Calendar)
      const left = x.col / x.n * 100, width = x.col === x.n - 1 ? 100 / x.n : Math.min(100 - left, 100 / x.n * 1.7);
      col.append(evBtn(x.o, { top: top + 'px', height: height + 'px', left: `calc(${left}% + 1px)`, width: `calc(${width}% - 3px)`, zIndex: 1 + x.col }, (height < 34 ? 'short' : '') + (x.n > 1 ? ' stacked' : '')));
    }
    if (ymd(d) === today) { const now = new Date(); col.append(h('div', { class: 'cal-now', style: { top: (now.getHours() + now.getMinutes() / 60) * HOUR + 'px' } })); }
    // tap on free time → new event there (30-minute steps)
    col.addEventListener('click', e => {
      if (e.target !== col) return;
      const y = e.offsetY, mins = Math.max(0, Math.min(23 * 60 + 30, Math.floor(y / HOUR * 2) * 30));
      editEvent(null, { date: ymd(d), start: `${pad(mins / 60 | 0)}:${pad(mins % 60)}`, end: `${pad(Math.min(23, (mins / 60 | 0) + 1))}:${pad(mins % 60)}` });
    });
    return col;
  });
  const hours = h('div', { class: 'cal-hours' }, Array.from({ length: 24 }, (_, i) => h('div', { class: 'cal-hour', style: { top: i * HOUR + 'px' } }, i ? `${pad(i)}:00` : '')));
  const body = h('div', { class: 'cal-body', style: { height: 24 * HOUR + 'px' } }, hours, ...cols);
  const scroller = h('div', { class: 'cal-scroll' }, body);
  scroller.addEventListener('scroll', () => { cal.scroll = scroller.scrollTop; });

  const legend = h('div', { class: 'cal-legend' },
    h('span', { class: 'cal-src' }, h('i', { style: { background: FOLIO_COLOR } }), 'Folio'),
    ...cal.records.filter(r => r.kind === 'calfeed' && !r.deleted).map(r => h('span', { class: 'cal-src' + (r.error ? ' err' : ''), title: r.error || '' }, h('i', { style: { background: r.color } }), (r.url ? 'Abo: ' : 'Import: ') + r.name, r.error ? ' ⚠' : '')),
    ...(cfg.on ? Object.values(cfg.cals).filter(c => c.on).map(c => h('span', { class: 'cal-src' }, h('i', { style: { background: c.color } }), 'Google: ' + calName(c))) : []),
    cal.gerr ? h('span', { class: 'cal-src err' }, '⚠ ' + cal.gerr) : null);

  bodyEl.replaceChildren(h('div', { class: 'cal' }, legend, h('div', { class: 'cal-grid' }, heads, alldayRow, scroller)));
  // first view: from 7:00 (or the earliest event of the week)
  const earliest = Math.min(...timed.flat().map(x => new Date(x.s).getHours()), 7);
  scroller.scrollTop = cal.scroll ?? Math.max(0, earliest - 0.5) * HOUR;
}

function defaultSlot() {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
  const ws = cal.ws, inWeek = d.getTime() >= ws && d.getTime() < dayAt(ws, 7).getTime();
  const date = inWeek ? ymd(d) : ymd(new Date(ws));
  const s = inWeek ? d.getHours() : 9;
  return { date, start: `${pad(s)}:00`, end: `${pad(Math.min(23, s + 1))}:00` };
}

// ---------- Event sheets ----------
function openItem(o) {
  if (o.editable) return editEvent(o);
  const when = o.allDay ? `${new Date(o.start).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })} · ganztägig`
    : `${new Date(o.start).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })} · ${fmtTime(o.start)}–${fmtTime(o.end)}`;
  sheet({
    title: 'Termin', done: 'OK', cancel: false,
    body: h('div', { class: 'cal-detail' },
      h('div', { class: 'cal-detail-title' }, o.title),
      h('div', {}, when),
      o.location ? h('div', {}, '📍 ' + o.location) : null,
      o.description ? h('div', { class: 'cal-desc' }, o.description) : null,
      h('div', { class: 'cal-detail-src' }, h('i', { style: { background: o.color } }), 'Quelle: ' + o.srcName + ' (nur lesbar)'),
      o.unsupported ? h('div', { class: 'cal-note' }, 'Die Wiederholungsregel dieses Termins wird nicht vollständig unterstützt – gezeigt wird nur der erste Termin.') : null),
  });
}

// o: occurrence to edit, or null for a new event (slot: { date, start, end })
async function editEvent(o, slot) {
  const isNew = !o;
  const cfg = gcfg();
  const r = o?.source === 'folio' ? o.rec : null;
  const v = isNew ? { title: '', ...slot, repeat: 'none', until: '' }
    : { title: o.title, date: ymd(new Date(o.start)), start: hm(new Date(o.start)), end: hm(new Date(o.end)), repeat: r?.weekly ? 'weekly' : 'none', until: r?.until || '' };
  let scope = 'one', action = 'save';
  let target = isNew ? (cfg.on && writable(cfg.cals[cfg.target]) ? cfg.target : 'folio') : null;
  const title = h('input', { class: 'field big', placeholder: 'Titel', value: v.title });
  const date = h('input', { class: 'field', type: 'date', value: v.date });
  const start = h('input', { class: 'field', type: 'time', value: v.start, step: 300 });
  const end = h('input', { class: 'field', type: 'time', value: v.end, step: 300 });
  const until = h('input', { class: 'field', type: 'date', value: v.until });
  const untilRow = h('div', { class: 'cal-until', hidden: v.repeat !== 'weekly' }, h('span', { class: 'form-label' }, 'Wiederholen bis (optional)'), until);
  let repeat = v.repeat;
  const recurring = !isNew && o.recurring;
  const targets = [['folio', 'Folio'], ...Object.entries(cfg.on ? cfg.cals : {}).filter(([, c]) => writable(c)).map(([id, c]) => [id, 'Google: ' + calName(c)])];
  const targetSel = isNew && targets.length > 1 ? h('select', { class: 'field', onchange: e => { target = e.target.value; } }, targets.map(([id, l]) => { const op = h('option', { value: id }, l); op.selected = id === target; return op; })) : null;
  const canRepeat = isNew || (o.source === 'folio' && (!recurring || scope === 'all'));
  const repeatCtl = segmented([['none', 'Einmalig'], ['weekly', 'Wöchentlich']], repeat, x => { repeat = x; untilRow.hidden = x !== 'weekly'; });
  const repeatWrap = h('div', { hidden: !canRepeat }, h('div', { class: 'form-label' }, 'Wiederholung'), repeatCtl, untilRow);
  const scopeCtl = recurring ? h('div', {}, h('div', { class: 'form-label' }, 'Ändern'), segmented([['one', 'Nur dieser Termin'], ['all', 'Ganze Serie']], scope, x => {
    scope = x;
    repeatWrap.hidden = !(o.source === 'folio' && x === 'all');
    gSeriesNote.hidden = !(o.source === 'google' && x === 'all');
  })) : null;
  const gSeriesNote = h('div', { class: 'cal-note', hidden: true }, 'Bei einer Google-Serie ändert Folio nur den Titel; Zeiten bitte pro Termin oder in Google Kalender ändern.');
  const del = !isNew ? h('button', { class: 'pill-btn danger cal-del', onclick: e => { action = 'delete'; e.currentTarget.closest('.sheet').querySelector('.textbtn.strong').click(); } }, icon('trash', 16), recurring ? 'Löschen …' : 'Löschen') : null;
  const body = h('div', { class: 'form cal-form' },
    title,
    h('div', { class: 'cal-when' }, h('div', {}, h('div', { class: 'form-label' }, 'Datum'), date), h('div', {}, h('div', { class: 'form-label' }, 'Beginn'), start), h('div', {}, h('div', { class: 'form-label' }, 'Ende'), end)),
    scopeCtl, gSeriesNote, repeatWrap,
    targetSel ? h('div', {}, h('div', { class: 'form-label' }, 'Speichern in'), targetSel) : null,
    !isNew ? h('div', { class: 'cal-detail-src' }, h('i', { style: { background: o.color } }), 'Quelle: ' + o.srcName) : null,
    del);
  const res = await sheet({
    title: isNew ? 'Neuer Termin' : 'Termin', done: 'Sichern', body,
    onDone: () => {
      if (action === 'delete') return true;
      if (!date.value || !start.value || !end.value) { toast('Bitte Datum, Beginn und Ende angeben'); return false; }
      return true;
    },
  });
  if (!res) return;
  const val = { title: title.value.trim() || '(ohne Titel)', date: date.value, start: start.value, end: end.value, weekly: repeat === 'weekly', until: repeat === 'weekly' && until.value ? until.value : null };
  try {
    if (action === 'delete') await deleteItem(o, recurring ? await askScope() : 'all');
    else if (isNew) await createEvent(val, target);
    else if (o.source === 'folio') await saveOwn(o, val, recurring ? scope : 'all');
    else if (o.source === 'google') await saveGoogle(o, val, recurring ? scope : 'one');
  } catch (err) { toast('⚠ ' + err.message, 4000); }
  render();
}

function askScope() {
  let s = 'one';
  return sheet({ title: 'Wiederholten Termin löschen', done: 'Löschen', body: h('div', { class: 'form' }, segmented([['one', 'Nur dieser Termin'], ['all', 'Ganze Serie']], s, x => { s = x; })), onDone: () => s })
    .then(x => x || null);
}

async function createEvent(v, target) {
  const now = Date.now();
  if (target && target !== 'folio') {
    if (!gValid()) await gToken();
    const body = { summary: v.title, ...gTimes(v.date, v.start, v.end) };
    if (v.weekly) body.recurrence = [`RRULE:FREQ=WEEKLY${v.until ? `;UNTIL=${v.until.replace(/-/g, '')}T235959Z` : ''}`];
    await gapi(`calendars/${encodeURIComponent(target)}/events`, { method: 'POST', body: JSON.stringify(body) });
    cal.gcache.clear(); await gLoadWeek(true);
    toast('In Google Kalender gespeichert');
    return;
  }
  await store.put({ kind: 'event', id: uid(), name: v.title, title: v.title, date: v.date, start: v.start, end: v.end, tz: localTz(), weekly: v.weekly, until: v.until, exceptions: {}, created: now, updated: now });
}

async function saveOwn(o, v, scope) {
  const r = o.rec;
  if (r.weekly && scope === 'one') {
    r.exceptions = { ...(r.exceptions || {}), [o.occDate]: { title: v.title, date: v.date, start: v.start, end: v.end } };
  } else {
    // whole series: a changed date moves the series by the same number of days
    const shift = Math.round((Date.parse(v.date) - Date.parse(o.occDate)) / 86400000);
    let first = r.date;
    if (shift) { const d = new Date(r.date + 'T00:00'); d.setDate(d.getDate() + shift); first = ymd(d); }
    Object.assign(r, { title: v.title, name: v.title, start: v.start, end: v.end, date: r.weekly ? first : v.date, weekly: v.weekly, until: v.until });
    if (!v.weekly) r.exceptions = {};
  }
  r.updated = Date.now();
  await store.put(r);
}

async function saveGoogle(o, v, scope) {
  if (!gValid()) await gToken();
  const id = scope === 'all' && o.recurringEventId ? o.recurringEventId : o.id;
  const body = scope === 'all' && o.recurringEventId ? { summary: v.title } : { summary: v.title, ...gTimes(v.date, v.start, v.end) };
  await gapi(`calendars/${encodeURIComponent(o.calId)}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  cal.gcache.clear(); await gLoadWeek(true);
}

async function deleteItem(o, scope) {
  if (!scope) return;
  if (o.source === 'folio') {
    const r = o.rec;
    if (r.weekly && scope === 'one') { r.exceptions = { ...(r.exceptions || {}), [o.occDate]: { cancelled: true } }; r.updated = Date.now(); await store.put(r); }
    else await store.put(tombstone(r));
  } else if (o.source === 'google') {
    if (!gValid()) await gToken();
    const id = scope === 'all' && o.recurringEventId ? o.recurringEventId : o.id;
    await gapi(`calendars/${encodeURIComponent(o.calId)}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
    cal.gcache.clear(); await gLoadWeek(true);
  }
  toast('Gelöscht');
}

// ---------- Sources ----------
async function openSources() {
  const cfg = gcfg();
  const wrap = h('div', { class: 'form cal-sources' });
  const fill = () => {
    const feeds = cal.records.filter(r => r.kind === 'calfeed' && !r.deleted);
    const url = h('input', { class: 'field', type: 'url', placeholder: 'https://… oder webcal://…', autocomplete: 'off', spellcheck: 'false' });
    wrap.replaceChildren(
      h('div', { class: 'form-label' }, 'Google Kalender'),
      cfg.on
        ? h('div', { class: 'cal-gcals' },
          ...Object.entries(cfg.cals).map(([id, c]) => toggle(`${calName(c)}${writable(c) ? '' : ' (nur lesen)'}`, c.on, on => { c.on = on; saveSettings(); cal.gcache.clear(); })),
          h('div', { class: 'form-label' }, 'Neue Termine standardmäßig in'),
          h('select', { class: 'field', onchange: e => { cfg.target = e.target.value; saveSettings(); } },
            [['folio', 'Folio (synchronisiert über Google Drive)'], ...Object.entries(cfg.cals).filter(([, c]) => writable(c)).map(([id, c]) => [id, 'Google: ' + calName(c)])]
              .map(([id, l]) => { const op = h('option', { value: id }, l); op.selected = cfg.target === id; return op; })),
          h('div', { class: 'cal-row-btns' },
            h('button', { class: 'pill-btn', onclick: async () => { try { await gToken(); await gListCalendars(); fill(); } catch (err) { toast('⚠ ' + err.message); } } }, icon('sync', 16), 'Kalenderliste neu laden'),
            h('button', { class: 'pill-btn danger', onclick: () => { gDisconnect(); fill(); } }, 'Trennen')))
        : h('div', {},
          h('p', { class: 'cal-hint' }, 'Zeigt deine Google-Kalender in der Wochenansicht und kann Termine dort anlegen, ändern und löschen. Google fragt dafür einmal separat um Erlaubnis (Kalenderliste lesen, Termine bearbeiten). Die Drive-Synchronisierung braucht das nicht.'),
          h('button', { class: 'pill-btn primary', onclick: async () => { await gConnect(); fill(); } }, icon('calendar', 16), 'Mit Google Kalender verbinden')),
      h('div', { class: 'form-label' }, 'Abos und importierte Kalender'),
      ...feeds.map(f => h('div', { class: 'cal-feed' },
        h('i', { style: { background: f.color } }),
        h('div', { class: 'cal-feed-main' },
          h('b', {}, f.name),
          h('span', {}, `${f.url ? 'Abo' : 'Import'} · ${(f.events || []).length} Einträge${f.fetched ? ' · Stand ' + new Date(f.fetched).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''}`),
          f.error ? h('span', { class: 'cal-err' }, f.error) : null),
        f.url ? h('button', { class: 'iconbtn plain', title: 'Aktualisieren', 'aria-label': 'Aktualisieren', onclick: async () => { await refreshFeedOne(f); fill(); } }, icon('sync', 18)) : null,
        h('button', { class: 'iconbtn plain', title: 'Entfernen', 'aria-label': 'Entfernen', onclick: async () => {
          if (!(await confirmBox('Kalender entfernen', `„${f.name}“ und seine Termine aus Folio entfernen?`, 'Entfernen', true))) return;
          await store.put(tombstone(f)); f.deleted = true; fill();
        } }, icon('trash', 18)))),
      h('div', { class: 'cal-sub' }, url, h('button', { class: 'pill-btn', onclick: async e => {
        if (!url.value.trim()) return;
        e.currentTarget.disabled = true;
        if (await subscribe(url.value)) { cal.records = (await store.all()).filter(r => CAL_KINDS.has(r.kind)); fill(); }
        else e.currentTarget.disabled = false;
      } }, 'Abonnieren')),
      h('p', { class: 'cal-hint' }, 'Abos werden nur beim Tippen auf „Aktualisieren“ neu geladen. Die Adresse eines privaten Kalenders ist wie ein Passwort: Sie wird nur auf deinen Geräten und in deinem Google Drive gespeichert.'),
      h('button', { class: 'pill-btn', onclick: async () => { await importFile(); cal.records = (await store.all()).filter(r => CAL_KINDS.has(r.kind)); fill(); } }, icon('download', 16), 'ICS-Datei importieren …'));
  };
  fill();
  await sheet({ title: 'Kalenderquellen', done: 'Fertig', cancel: false, body: wrap });
  render();
}
async function refreshFeedOne(f) {
  try { const p = await fetchFeed(f.url); Object.assign(f, { events: p.events, fetched: Date.now(), error: '', updated: Date.now() }); toast('Aktualisiert'); }
  catch (err) { Object.assign(f, { error: err.message, updated: Date.now() }); toast('⚠ ' + err.message, 4000); }
  await store.put(f);
}

bus.addEventListener('remote', e => { if (cal.records.some(r => r.id === e.detail)) render(); });
