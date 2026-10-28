// "Lernen" in the sidebar: one overview of every flashcard deck — what is due today, how long it
// takes, how the next two weeks look, progress per deck, recent activity, cards that keep being
// forgotten. "Alles lernen" goes through all decks with due cards one after another (deck.js).
// All numbers come from the review logs (srs.js), so they are the same on every device after a sync.
import { h } from './util.js';
import { icon } from './icons.js';
import { store } from './store.js';
import { deckStats, dayStart, dayEnd, recallNow, fmtIvl, DAY } from './srs.js';
import { openDeck, openDeckCard } from './deck.js';
import { plainCard } from './cardformat.js';
import { inkView, hasInk } from './inkpad.js';

// ---------- Data ----------
// Full deck records, read once per version (decks are small; documents kept only in Drive are
// listed without numbers).
const cache = new Map(); // id → record
export async function loadDecks() {
  const all = await store.list();
  const metas = all.filter(r => r.kind === 'deck' && !r.deleted && !r.trashed);
  const folders = new Map(all.filter(r => r.kind === 'folder').map(r => [r.id, r]));
  const out = [];
  for (const m of metas) {
    let full = null;
    if (!m.offloaded) {
      const c = cache.get(m.id);
      full = c?.updated === m.updated ? c : await store.get(m.id);
      if (full) cache.set(m.id, full);
    }
    const path = [];
    for (let f = folders.get(m.parent); f && path.length < 6; f = folders.get(f.parent)) path.unshift(f.name);
    out.push({ meta: m, full, path });
  }
  return out;
}

// Seconds per answer, measured: the median gap between answers given in one go (< 2 min apart).
function secondsPerCard(times) {
  times.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) { const g = times[i] - times[i - 1]; if (g > 1000 && g < 120000) gaps.push(g); }
  if (gaps.length < 10) return 10;
  gaps.sort((a, b) => a - b);
  return Math.min(60, Math.max(4, gaps[gaps.length >> 1] / 1000));
}

export function planStats(decks, now = Date.now()) {
  const start = dayStart(now), end = dayEnd(now);
  const P = {
    decks: [], due: 0, fresh: 0, learning: 0, total: 0, newTotal: 0, mature: 0, young: 0,
    todayAnswers: 0, todayRight: 0, todayWrong: 0, monthAnswers: 0, monthRight: 0,
    forecast: Array(14).fill(0), heat: new Map(), streak: 0, recall: null, leeches: [], secs: 10,
  };
  let rSum = 0, rN = 0;
  const times = [];
  for (const d of decks) {
    if (!d.full) { P.decks.push({ ...d, st: null }); continue; }
    const st = deckStats(d.full, now);
    P.decks.push({ ...d, st });
    P.due += st.due; P.fresh += st.fresh; P.learning += st.learning;
    P.total += st.total; P.newTotal += st.newTotal; P.mature += st.mature; P.young += st.young;
    let next = Infinity;
    for (const c of d.full.cards) {
      const s = st.states.get(c.id);
      for (const [t, g] of c.log || []) {
        const day = dayStart(t);
        P.heat.set(day, (P.heat.get(day) || 0) + 1);
        if (t >= start) { P.todayAnswers++; if (g === 3) P.todayRight++; if (g === 1) P.todayWrong++; }
        if (t >= now - 30 * DAY) { P.monthAnswers++; if (g >= 2) P.monthRight++; }
        if (t >= now - 60 * DAY) times.push(t);
      }
      if (s.st === 'new') continue;
      if (s.due < next) next = s.due;
      const i = s.due < end ? 0 : Math.floor((dayStart(s.due) - start) / DAY);
      if (i < 14) P.forecast[i]++;
      const r = recallNow(s, now);
      if (r != null) { rSum += r; rN++; }
      if (s.lapses >= 2) P.leeches.push({ deck: d, card: c, s, r });
    }
    P.decks[P.decks.length - 1].next = next;
  }
  P.recall = rN ? rSum / rN : null;
  P.secs = secondsPerCard(times);
  P.leeches.sort((a, b) => b.s.lapses - a.s.lapses || (a.r ?? 1) - (b.r ?? 1));
  P.leeches = P.leeches.slice(0, 8);
  // days in a row with at least one answer (today counts once something was learned)
  for (let day = P.heat.has(start) ? start : dayStart(start - DAY / 2); P.heat.has(day); day = dayStart(day - DAY / 2)) P.streak++;
  return P;
}

// Number for the sidebar: cards to learn today across all decks
export async function todayCount() {
  const P = planStats(await loadDecks());
  return P.due + P.fresh;
}

// ---------- View ----------
const fmtMin = s => (s < 60 ? 'unter 1 Min' : `ca. ${Math.round(s / 60)} Min`);
const pct = x => `${Math.round(x * 100)} %`;

function ring(done, total) {
  const f = total ? done / total : 1, r = 42, c = 2 * Math.PI * r;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('class', 'lp-ring');
  svg.innerHTML = `<circle cx="50" cy="50" r="${r}" class="lp-ring-bg"/><circle cx="50" cy="50" r="${r}" class="lp-ring-fg" stroke-dasharray="${c * f} ${c}" transform="rotate(-90 50 50)"/>`;
  return h('div', { class: 'lp-ring-wrap' }, svg, h('div', { class: 'lp-ring-text' }, h('b', {}, total ? pct(f) : '–'), h('span', {}, 'heute')));
}

function deckBar(st) {
  const seg = (n, cls) => (n ? h('i', { class: cls, style: { flexGrow: n } }) : null);
  return h('div', { class: 'dk-bar' }, seg(st.newTotal, 'new'), seg(st.learning, 'learn'), seg(st.young, 'young'), seg(st.mature, 'mature'));
}

function deckCard(d, now) {
  const { meta, st, path } = d;
  if (!st) {
    return h('div', { class: 'lp-deck off' },
      h('div', { class: 'lp-deck-head' }, h('div', { class: 'lp-deck-name' }, h('b', {}, meta.name), path.length ? h('span', {}, path.join(' / ')) : null)),
      h('div', { class: 'hint' }, 'Nur in Google Drive – zum Laden öffnen.'),
      h('div', { class: 'lp-deck-btns' }, h('button', { class: 'pill-btn', onclick: () => openDeck(meta.id) }, 'Öffnen')));
  }
  const todo = st.due + st.fresh;
  const mastered = st.total ? st.mature / st.total : 0;
  const status = todo
    ? h('span', { class: 'lp-pill due' }, `${todo} heute`)
    : st.total ? h('span', { class: 'lp-pill ok' }, icon('check', 13), 'erledigt') : h('span', { class: 'lp-pill' }, 'leer');
  const next = !todo && d.next < Infinity ? `Nächste Wiederholung in ${fmtIvl(d.next - now)}` : todo ? [st.due && `${st.due} fällig`, st.fresh && `${st.fresh} neu`].filter(Boolean).join(' · ') : st.newTotal ? 'Tageslimit neuer Karten erreicht' : '';
  return h('div', { class: 'lp-deck' + (todo ? ' has-todo' : '') },
    h('button', { class: 'lp-deck-head', onclick: () => openDeck(meta.id) },
      h('div', { class: 'lp-deck-name' }, h('b', {}, meta.name), path.length ? h('span', {}, path.join(' / ')) : null),
      status),
    st.total ? deckBar(st) : null,
    h('div', { class: 'lp-deck-meta' },
      h('span', {}, `${st.total} Karten`),
      st.total ? h('span', {}, `${pct(mastered)} gefestigt`) : null,
      st.recall != null ? h('span', {}, `Erinnerung ${pct(st.recall)}`) : null),
    next ? h('div', { class: 'lp-deck-next' }, next) : null,
    h('div', { class: 'lp-deck-btns' },
      todo ? h('button', { class: 'pill-btn primary', onclick: () => openDeck(meta.id, { study: true }) }, icon('play', 14), 'Lernen') : null,
      h('button', { class: 'pill-btn', onclick: () => openDeck(meta.id) }, 'Öffnen')));
}

function heatmap(heat, now) {
  const weeks = 18, today = dayStart(now);
  // columns = weeks (Monday first), the last column ends with today
  const dow = (new Date(today).getDay() + 6) % 7;
  const first = today - (dow + (weeks - 1) * 7) * DAY;
  const max = Math.max(1, ...heat.values());
  const cells = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const day = dayStart(first + (w * 7 + d) * DAY + DAY / 2);
    if (day > today) { cells.push(h('i', { class: 'lp-heat-cell future' })); continue; }
    const n = heat.get(day) || 0;
    const lvl = !n ? 0 : n / max > 0.66 ? 4 : n / max > 0.33 ? 3 : n / max > 0.1 ? 2 : 1;
    cells.push(h('i', { class: `lp-heat-cell l${lvl}`, title: `${new Date(day).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' })}: ${n} Antwort${n === 1 ? '' : 'en'}` }));
  }
  return h('div', { class: 'lp-heat', style: { '--weeks': weeks } }, cells);
}

function forecastChart(fc, now) {
  const max = Math.max(1, ...fc);
  return h('div', { class: 'lp-fc' }, fc.map((n, i) => {
    const d = new Date(now + i * DAY);
    const label = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '').slice(0, 2); // today: highlighted bar + bold
    return h('div', { class: 'lp-fc-col' + (i === 0 ? ' today' : '') + ((d.getDay() + 6) % 7 >= 5 ? ' weekend' : ''), title: `${d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}: ${n} Karte${n === 1 ? '' : 'n'}` },
      h('span', { class: 'lp-fc-n' }, n || ''),
      h('div', { class: 'lp-fc-bar' }, h('i', { style: { height: (n / max) * 100 + '%' } })),
      h('span', { class: 'lp-fc-d' }, label));
  }));
}

const tile = (ic, value, label, sub) => h('div', { class: 'lp-tile' },
  h('div', { class: 'lp-tile-icon' }, icon(ic, 18)), h('b', {}, value), h('span', {}, label), sub ? h('small', {}, sub) : null);

// actions: { newDeck(), importCards() } from the library
export async function renderLearnPlan(content, actions) {
  const decks = await loadDecks();
  if (!content.isConnected) return;
  const now = Date.now(), P = planStats(decks, now);
  if (!decks.length) {
    return content.replaceChildren(h('div', { class: 'lp' }, h('section', { class: 'dk-empty' },
      h('div', { class: 'dk-empty-icon' }, icon('cards', 34)),
      h('h2', {}, 'Noch keine Karteikarten'),
      h('p', {}, 'Hier siehst du später alle Stapel auf einen Blick: was heute dran ist, wie lange es dauert und wie gut du die Karten schon kannst.'),
      h('div', { class: 'dk-empty-btns' },
        h('button', { class: 'pill-btn primary', onclick: actions.newDeck }, icon('plus', 16), 'Stapel anlegen'),
        h('button', { class: 'pill-btn', onclick: actions.importCards }, icon('paste', 16), 'Karten importieren')))));
  }
  const todo = P.due + P.fresh;
  const order = [...P.decks].sort((a, b) => ((b.st ? b.st.due + b.st.fresh : -1) - (a.st ? a.st.due + a.st.fresh : -1)) || a.meta.name.localeCompare(b.meta.name, 'de'));
  const firstTodo = order.find(d => d.st && d.st.due + d.st.fresh);
  const dateLabel = new Date(now).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  const hero = h('section', { class: 'lp-hero' },
    h('div', { class: 'lp-hero-main' },
      h('div', { class: 'lp-date' }, dateLabel),
      h('h2', {}, todo ? `${todo} Karte${todo === 1 ? '' : 'n'} warten auf dich` : P.todayAnswers ? 'Alles erledigt für heute' : 'Heute ist nichts fällig'),
      h('div', { class: 'lp-chips' },
        h('span', { class: 'lp-chip due' }, h('b', {}, P.due), ' fällig'),
        h('span', { class: 'lp-chip new' }, h('b', {}, P.fresh), ' neu'),
        P.learning ? h('span', { class: 'lp-chip learn' }, h('b', {}, P.learning), ' im Lernen') : null,
        todo ? h('span', { class: 'lp-chip' }, icon('clock', 14), fmtMin(todo * P.secs)) : null),
      todo
        ? h('button', { class: 'dk-start lp-start', onclick: () => openDeck(firstTodo.meta.id, { study: true, chain: true }) }, icon('play', 22), h('span', {}, 'Alles lernen'), h('b', {}, String(todo)))
        : h('div', { class: 'lp-hero-done' }, P.forecast[1] ? `Morgen: ${P.forecast[1]} Karte${P.forecast[1] === 1 ? '' : 'n'}` : 'Morgen ist auch nichts fällig – Zeit für neue Karten?'),
      todo && P.decks.filter(d => d.st && d.st.due + d.st.fresh).length > 1 ? h('div', { class: 'hint' }, 'Stapel für Stapel, der mit den meisten fälligen Karten zuerst.') : null),
    ring(P.todayAnswers, P.todayAnswers + todo));

  const tiles = h('section', { class: 'lp-tiles' },
    tile('quick', P.streak ? `${P.streak} Tag${P.streak === 1 ? '' : 'e'}` : '–', 'Lernserie', P.streak ? 'jeden Tag gelernt' : 'heute anfangen'),
    tile('check', String(P.todayAnswers), 'Heute beantwortet', P.todayAnswers ? `${P.todayRight} richtig · ${P.todayWrong} falsch` : null),
    tile('chart', P.monthAnswers ? pct(P.monthRight / P.monthAnswers) : '–', 'Trefferquote', '30 Tage, richtig + unpräzise'),
    tile('cards', String(P.total), 'Karten', P.total ? `${pct(P.mature / P.total)} gefestigt${P.recall != null ? ` · Erinnerung ${pct(P.recall)}` : ''}` : null));

  const decksSec = h('section', { class: 'lp-sec' },
    h('div', { class: 'lp-sec-head' }, h('h3', {}, 'Deine Stapel'), h('span', { class: 'hint' }, `${decks.length}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'pill-btn', onclick: actions.newDeck }, icon('plus', 16), 'Stapel')),
    h('div', { class: 'lp-decks' }, order.map(d => deckCard(d, now))),
    h('div', { class: 'lp-legend dk-legend' },
      h('span', {}, h('i', { class: 'new' }), 'Neu'), h('span', {}, h('i', { class: 'learn' }), 'Im Lernen'),
      h('span', {}, h('i', { class: 'young' }), 'Jung'), h('span', {}, h('i', { class: 'mature' }), 'Gefestigt (≥ 21 Tage)')));

  const fcSec = P.total - P.newTotal ? h('section', { class: 'lp-sec lp-box' },
    h('div', { class: 'lp-sec-head' }, h('h3', {}, 'Die nächsten 14 Tage'), h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, `${P.forecast.slice(1, 8).reduce((a, b) => a + b, 0)} in den nächsten 7 Tagen`)),
    forecastChart(P.forecast, now)) : null;

  const heatSec = h('section', { class: 'lp-sec lp-box' },
    h('div', { class: 'lp-sec-head' }, h('h3', {}, 'Aktivität'), h('span', { class: 'spacer' }),
      h('span', { class: 'lp-heat-legend' }, 'weniger', ...[0, 1, 2, 3, 4].map(l => h('i', { class: 'lp-heat-cell l' + l })), 'mehr')),
    heatmap(P.heat, now));

  const leechSec = P.leeches.length ? h('section', { class: 'lp-sec lp-box' },
    h('div', { class: 'lp-sec-head' }, h('h3', {}, 'Oft vergessen'), h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Umformulieren oder aufteilen hilft oft')),
    h('div', { class: 'lp-leeches' }, P.leeches.map(({ deck, card, s }) => h('button', { class: 'lp-leech', onclick: () => openDeckCard(deck.meta.id, card.id) },
      h('span', { class: 'lp-leech-text' },
        card.front ? h('b', {}, plainCard(card.front)) : hasInk(card.frontInk) ? inkView(card.frontInk, { maxW: 140, maxH: 26 }) : h('b', {}, '–'),
        h('span', {}, deck.meta.name)),
      h('span', { class: 'lp-pill warn' }, `${s.lapses}× vergessen`))))) : null;

  content.replaceChildren(h('div', { class: 'lp' }, hero, tiles, decksSec, h('div', { class: 'lp-cols' }, fcSec, heatSec), leechSec));
}
