// iCalendar (RFC 5545) reading for the calendar view: parse VEVENTs of a .ics file or feed and
// expand them into occurrences for a time window. Pure functions, no I/O.
//
// Supported: DTSTART/DTEND/DURATION with TZID (IANA names, via Intl), UTC ("Z"), floating
// times and all-day dates; RRULE with FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL,
// BYDAY (weekly/daily, without ordinals), BYMONTHDAY (monthly); EXDATE; RECURRENCE-ID
// (moved/changed single occurrences); STATUS:CANCELLED (whole event or one occurrence).
// Not supported (the event then only shows its first occurrence, marked `unsupported`):
// other rule parts (BYSETPOS, ordinals like 2MO, BYWEEKNO, …), RDATE, EXRULE. TZIDs that are
// not IANA names (e.g. Windows names) are read as local time.

// ---------- Time zones ----------
const dtfs = new Map();
function dtf(tz) {
  if (!dtfs.has(tz)) dtfs.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return dtfs.get(tz);
}
export function validTz(tz) { try { dtf(tz); return true; } catch { return false; } }
// offset of tz from UTC at instant ms (in ms)
function offsetAt(ms, tz) {
  const p = Object.fromEntries(dtf(tz).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// wall-clock time in tz → instant. tz: 'UTC', an IANA name, or null (local time of this device)
export function wallToMs({ y, m, d, h = 0, mi = 0, s = 0 }, tz) {
  if (tz === 'UTC') return Date.UTC(y, m - 1, d, h, mi, s);
  if (!tz) return new Date(y, m - 1, d, h, mi, s).getTime();
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

// ---------- Parsing ----------
const unescape = v => v.replace(/\\([nN\\;,])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

function parseLines(text) {
  return text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean).map(line => {
    // name;param=value;param="x:y":value
    let i = 0, inQ = false;
    for (; i < line.length; i++) { const c = line[i]; if (c === '"') inQ = !inQ; else if (c === ':' && !inQ) break; }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.split(';');
    const params = {};
    for (const p of ps) { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1).replace(/^"|"$/g, ''); }
    return { name: name.toUpperCase(), params, value };
  });
}

// "20261026T143000Z" / "20261026T143000" / "20261026" → time object
function parseTime(value, params, fallbackTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const t = { y: +m[1], m: +m[2], d: +m[3] };
  if (!m[4] || params.VALUE === 'DATE') return { ...t, allDay: true, tz: null };
  Object.assign(t, { h: +m[4], mi: +m[5], s: +(m[6] || 0) });
  let tz = m[7] ? 'UTC' : (params.TZID || '').replace(/^\//, '') || fallbackTz || null;
  if (tz && tz !== 'UTC' && !validTz(tz)) tz = null;
  return { ...t, tz };
}
export const timeMs = t => wallToMs(t, t.allDay ? null : t.tz);

function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

function parseRule(v) {
  const r = Object.fromEntries(v.split(';').map(p => p.split('=')).map(([k, x]) => [k.toUpperCase(), x]));
  const rule = { freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1) };
  if (r.COUNT) rule.count = +r.COUNT;
  if (r.UNTIL) rule.until = r.UNTIL;
  if (r.BYDAY) rule.byday = r.BYDAY.split(',');
  if (r.BYMONTHDAY) rule.bymonthday = r.BYMONTHDAY.split(',').map(Number);
  if (r.WKST) rule.wkst = r.WKST;
  const known = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'WKST']);
  rule.unsupported = !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)
    || Object.keys(r).some(k => !known.has(k))
    || (rule.byday || []).some(d => !/^(MO|TU|WE|TH|FR|SA|SU)$/.test(d))
    || (rule.bymonthday && rule.freq !== 'MONTHLY') || (rule.bymonthday || []).some(n => !(n >= 1 && n <= 31));
  return rule;
}

// → { name, events: [{ uid, rid, title, location, description, status, start, end (time objects),
//      duration (ms), rule, exdates: [ms], unsupportedParts }] }
export function parseICS(text) {
  const lines = parseLines(text);
  const events = [];
  let cal = { name: '', tz: null }, ev = null, depth = [];
  for (const { name, params, value } of lines) {
    if (name === 'BEGIN') { depth.push(value.toUpperCase()); if (value.toUpperCase() === 'VEVENT' && depth.length === 2) ev = { exdates: [], raw: {} }; continue; }
    if (name === 'END') {
      const what = depth.pop();
      if (what === 'VEVENT' && ev) { events.push(ev); ev = null; }
      continue;
    }
    if (depth.length === 1) { // calendar properties
      if (name === 'X-WR-CALNAME') cal.name = unescape(value);
      if (name === 'X-WR-TIMEZONE' && validTz(value)) cal.tz = value;
      continue;
    }
    if (!ev || depth[depth.length - 1] !== 'VEVENT') continue; // VALARM etc. are ignored
    switch (name) {
      case 'UID': ev.uid = value; break;
      case 'SUMMARY': ev.title = unescape(value); break;
      case 'LOCATION': ev.location = unescape(value); break;
      case 'DESCRIPTION': ev.description = unescape(value).slice(0, 2000); break;
      case 'STATUS': ev.status = value.toUpperCase(); break;
      case 'DTSTART': ev.raw.start = [value, params]; break;
      case 'DTEND': ev.raw.end = [value, params]; break;
      case 'DURATION': ev.raw.duration = value; break;
      case 'RRULE': ev.rule = parseRule(value); break;
      case 'RECURRENCE-ID': ev.raw.rid = [value, params]; break;
      case 'EXDATE': ev.raw.ex = [...(ev.raw.ex || []), [value, params]]; break;
      case 'RDATE': case 'EXRULE': ev.unsupportedParts = true; break;
    }
  }
  const out = [];
  for (const e of events) {
    if (!e.raw.start) continue;
    const start = parseTime(...e.raw.start, cal.tz);
    if (!start) continue;
    let end = e.raw.end ? parseTime(...e.raw.end, cal.tz) : null;
    let duration = end ? timeMs(end) - timeMs(start) : e.raw.duration ? parseDuration(e.raw.duration) : start.allDay ? 86400000 : 0;
    if (!(duration >= 0)) duration = 0;
    const exdates = [];
    for (const [v, p] of e.raw.ex || []) for (const one of v.split(',')) { const t = parseTime(one, p, cal.tz); if (t) exdates.push(timeMs(t.allDay ? { ...t, h: start.h, mi: start.mi, s: start.s, allDay: start.allDay, tz: start.tz } : t)); }
    const ridT = e.raw.rid ? parseTime(...e.raw.rid, cal.tz) : null;
    out.push({
      uid: e.uid || `${e.raw.start[0]}-${e.title || ''}`, rid: ridT ? timeMs(ridT) : null,
      title: e.title || '(ohne Titel)', location: e.location || '', description: e.description || '',
      status: e.status || 'CONFIRMED', start, duration, rule: e.rule || null, exdates,
      unsupported: !!(e.unsupportedParts || e.rule?.unsupported),
    });
  }
  return { name: cal.name, events: out };
}

// ---------- Expansion ----------
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const addDays = (t, n) => { const d = new Date(Date.UTC(t.y, t.m - 1, t.d + n)); return { ...t, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const dow = t => new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay();
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Start times (wall clock, in the event's zone) of a rule, in order, until stop() says so.
function* ruleStarts(start, rule) {
  const { freq, interval } = rule;
  if (freq === 'DAILY') {
    for (let t = start; ; t = addDays(t, interval)) if (!rule.byday || rule.byday.includes(DAYS[dow(t)])) yield t;
  } else if (freq === 'WEEKLY') {
    const wk = DAYS.indexOf(rule.wkst || 'MO');
    const days = (rule.byday || [DAYS[dow(start)]]).map(d => DAYS.indexOf(d));
    let weekStart = addDays(start, -((dow(start) - wk + 7) % 7));
    for (;; weekStart = addDays(weekStart, 7 * interval)) {
      const inWeek = days.map(d => addDays(weekStart, (d - wk + 7) % 7)).sort((a, b) => Date.UTC(a.y, a.m, a.d) - Date.UTC(b.y, b.m, b.d));
      for (const t of inWeek) if (Date.UTC(t.y, t.m - 1, t.d) >= Date.UTC(start.y, start.m - 1, start.d)) yield t;
    }
  } else if (freq === 'MONTHLY') {
    for (let i = 0; ; i += interval) {
      const mm = start.m - 1 + i, y = start.y + Math.floor(mm / 12), m = (mm % 12) + 1;
      for (const d of (rule.bymonthday || [start.d]).slice().sort((a, b) => a - b)) {
        if (d > daysIn(y, m)) continue; // e.g. the 31st in a 30-day month: skipped (RFC 5545)
        const t = { ...start, y, m, d };
        if (Date.UTC(y, m - 1, d) >= Date.UTC(start.y, start.m - 1, start.d)) yield t;
      }
    }
  } else if (freq === 'YEARLY') {
    for (let i = 0; ; i += interval) { const y = start.y + i; if (start.m === 2 && start.d === 29 && daysIn(y, 2) < 29) continue; yield { ...start, y }; }
  }
}

// Occurrences of parsed events overlapping [from, to): { key, uid, title, location, description,
// start, end (ms), allDay, unsupported }. Moved occurrences and cancellations are applied.
export function expandEvents(events, from, to) {
  const byUid = new Map();
  for (const e of events) { if (!byUid.has(e.uid)) byUid.set(e.uid, { master: null, overrides: [] }); const g = byUid.get(e.uid); e.rid != null ? g.overrides.push(e) : (g.master = e); }
  const out = [];
  const push = (e, s) => {
    const end = s + e.duration;
    if (end > from && s < to || (e.duration === 0 && s >= from && s < to)) out.push({ key: `${e.uid}|${s}`, uid: e.uid, title: e.title, location: e.location, description: e.description, start: s, end: Math.max(end, s), allDay: !!e.start.allDay, unsupported: e.unsupported });
  };
  for (const { master, overrides } of byUid.values()) {
    const ov = new Map(overrides.map(o => [o.rid, o]));
    const used = new Set();
    if (master && master.status !== 'CANCELLED') {
      const tz = master.start.allDay ? null : master.start.tz;
      if (!master.rule || master.rule.unsupported) {
        const s = timeMs(master.start);
        const o = ov.get(s);
        if (o) used.add(s);
        if (!o) push(master, s); else if (o.status !== 'CANCELLED') push(o, timeMs(o.start));
      } else {
        const r = master.rule, ex = new Set(master.exdates);
        let untilMs = Infinity;
        if (r.until) { const u = parseTime(r.until, {}, tz); if (u) untilMs = u.allDay ? wallToMs(addDays(u, 1), tz) - 1 : timeMs(u); }
        let n = 0, guard = 0;
        for (const t of ruleStarts(master.start, r)) {
          if (++guard > 50000) break;
          const s = wallToMs(t, tz);
          if (s > untilMs || (r.count && n >= r.count) || s >= to) break;
          n++;
          if (ex.has(s)) continue;
          const o = ov.get(s);
          if (o) { used.add(s); if (o.status !== 'CANCELLED') push(o, timeMs(o.start)); continue; }
          push(master, s);
        }
      }
    }
    // changed occurrences whose original time was not generated (or without a master)
    for (const o of overrides) if (!used.has(o.rid) && o.status !== 'CANCELLED' && !(master && master.status === 'CANCELLED')) push(o, timeMs(o.start));
  }
  return out;
}
