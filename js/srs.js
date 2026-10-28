// Spaced repetition for flashcards: FSRS-6 (Free Spaced Repetition Scheduler, open-spaced-repetition).
//
// Why FSRS: it models memory with three variables per card — difficulty D, stability S (days until
// recall probability drops to 90 %) and retrievability R — and schedules the next review for the
// moment R falls to the desired retention. Fitted on hundreds of millions of reviews it predicts
// forgetting better than SM-2 (Anki's former default), and it is Anki's scheduler since 23.10.
// Formulas and default parameters follow the reference implementation py-fsrs (fsrs/scheduler.py)
// and the FSRS-6 description in the awesome-fsrs wiki ("The Algorithm"); nothing here is tuned by hand.
//
// Folio's three grades map onto FSRS ratings:
//   Falsch → Again (1), Unpräzise, aber richtig → Hard (2), Richtig → Good (3). (Easy is not offered.)
//
// A card does not store its scheduling state. It stores its review log [[time, grade], …] and the
// state is computed by replaying the log. So two devices merge progress by taking the union of
// their logs (merge.js), and the result is exactly what one device would have computed had it seen
// every review — no "last writer wins" on intervals. card.reset (time) hides earlier reviews.
// Pure functions, no I/O.

export const W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796,
  1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const DECAY = -W[20];
const FACTOR = 0.9 ** (1 / DECAY) - 1;
const S_MIN = 0.001, D_MIN = 1, D_MAX = 10, MAX_IVL = 36500;
export const MIN = 60000, DAY = 86400000;
// Learning steps (scheduler settings, not part of the memory model): one step of 10 min for new and
// forgotten cards (py-fsrs uses 1 min + 10 min for new cards, 10 min for relearning). With one step
// "Richtig" on a new card schedules it by FSRS right away, while "Falsch" (and "Unpräzise" on a new
// card) bring it back in the same session — the session shows waiting learning cards before it ends.
const LEARN = [10 * MIN], RELEARN = [10 * MIN];
export const AGAIN = 1, HARD = 2, GOOD = 3;
export const DEFAULT_RETENTION = 0.9, DEFAULT_NEW_PER_DAY = 20;

const clampD = d => Math.min(Math.max(d, D_MIN), D_MAX);
const clampS = s => Math.max(s, S_MIN);

// probability of recall after `days` with stability s
export const retrievability = (days, s) => (1 + FACTOR * days / s) ** DECAY;
const initS = g => clampS(W[g - 1]);
const initD = (g, clamp = true) => { const d = W[4] - Math.exp(W[5] * (g - 1)) + 1; return clamp ? clampD(d) : d; };
function nextD(d, g) {
  const delta = -(W[6] * (g - 3));
  const damped = d + (10 - d) * delta / 9; // linear damping
  return clampD(W[7] * initD(4, false) + (1 - W[7]) * damped); // mean reversion towards D0(Easy)
}
function shortS(s, g) { // review on the same day
  let inc = Math.exp(W[17] * (g - 3 + W[18])) * s ** -W[19];
  if (g >= HARD) inc = Math.max(inc, 1);
  return clampS(s * inc);
}
function forgetS(d, s, r) {
  const long = W[11] * d ** -W[12] * ((s + 1) ** W[13] - 1) * Math.exp((1 - r) * W[14]);
  return Math.min(long, s / Math.exp(W[17] * W[18]));
}
function recallS(d, s, r, g) {
  const hard = g === HARD ? W[15] : 1, easy = g === 4 ? W[16] : 1;
  return s * (1 + Math.exp(W[8]) * (11 - d) * s ** -W[9] * (Math.exp((1 - r) * W[10]) - 1) * hard * easy);
}
const nextS = (d, s, r, g) => clampS(g === AGAIN ? forgetS(d, s, r) : recallS(d, s, r, g));
export function intervalDays(s, retention = DEFAULT_RETENTION) {
  const ivl = Math.round(s / FACTOR * (retention ** (1 / DECAY) - 1));
  return Math.min(Math.max(ivl, 1), MAX_IVL);
}

// Fuzz (as py-fsrs): spreads intervals ≥ 3 days a little, so cards learned together don't stay
// together. Deterministic per card and review, so every device computes the same date.
const FUZZ = [[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]];
function hash01(str) {
  let x = 2166136261;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
  x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
function fuzz(days, seed) {
  if (days < 2.5) return days;
  let delta = 1;
  for (const [a, b, f] of FUZZ) delta += f * Math.max(Math.min(days, b) - a, 0);
  const max = Math.min(Math.round(days + delta), MAX_IVL);
  const min = Math.min(Math.max(2, Math.round(days - delta)), max);
  return Math.min(Math.floor(hash01(seed) * (max - min + 1)) + min, max); // uniform over min…max
}

// state: { st: 'new' | 'learning' | 'review' | 'relearning', step, s, d, last, due, reps, lapses }
export const NEW_STATE = { st: 'new', step: 0, s: null, d: null, last: null, due: 0, reps: 0, lapses: 0 };

// One review (py-fsrs Scheduler.review_card), returns the new state.
export function review(c, g, t, retention = DEFAULT_RETENTION, seed = '') {
  c = { ...c };
  const days = c.last == null ? null : Math.floor((t - c.last) / DAY);
  if (c.st === 'new') c.st = 'learning', c.step = 0;
  if (c.s == null) { c.s = initS(g); c.d = initD(g); }
  else if (days < 1) { c.s = shortS(c.s, g); c.d = nextD(c.d, g); }
  else { c.s = nextS(c.d, c.s, retrievability(days, c.s), g); c.d = nextD(c.d, g); }
  let ivl; // ms
  const toReview = () => { c.st = 'review'; c.step = null; ivl = fuzz(intervalDays(c.s, retention), seed + t) * DAY; };
  if (c.st === 'review') {
    if (g === AGAIN) { c.lapses++; c.st = 'relearning'; c.step = 0; ivl = RELEARN[0]; }
    else toReview();
  } else {
    const steps = c.st === 'learning' ? LEARN : RELEARN;
    if (!steps.length || (c.step >= steps.length && g >= HARD)) toReview();
    else if (g === AGAIN) { c.step = 0; ivl = steps[0]; }
    else if (g === HARD) ivl = c.step === 0 ? (steps.length === 1 ? steps[0] * 1.5 : (steps[0] + steps[1]) / 2) : steps[c.step];
    else if (g === GOOD) { if (c.step + 1 >= steps.length) toReview(); else { c.step++; ivl = steps[c.step]; } }
    else toReview(); // Easy
  }
  c.reps++; c.last = t; c.due = t + ivl;
  return c;
}

// Reviews of a card that count (after a reset), oldest first.
export const reviewsOf = card => (card.log || []).filter(([t]) => !(card.reset > t)).sort((a, b) => a[0] - b[0]);
export function stateOf(card, retention = DEFAULT_RETENTION) {
  let c = NEW_STATE;
  for (const [t, g] of reviewsOf(card)) c = review(c, g, t, retention, card.id);
  return c;
}
// What each grade would do now (the times shown on the buttons)
export function preview(card, now, retention = DEFAULT_RETENTION) {
  const c = stateOf(card, retention);
  return Object.fromEntries([AGAIN, HARD, GOOD].map(g => [g, review(c, g, now, retention, card.id).due - now]));
}
// Current recall probability (null for cards never reviewed)
export const recallNow = (c, now) => (c.last == null ? null : retrievability(Math.max(0, (now - c.last) / DAY), c.s));

// ---------- Days ----------
// A study day starts at 4:00 local time (as in Anki): a late-night session still counts as "today".
const ROLLOVER_H = 4;
export function dayStart(now) {
  const d = new Date(now);
  if (d.getHours() < ROLLOVER_H) d.setDate(d.getDate() - 1);
  d.setHours(ROLLOVER_H, 0, 0, 0);
  return +d;
}
export const dayEnd = now => { const d = new Date(dayStart(now)); d.setDate(d.getDate() + 1); return +d; };

// ---------- Deck overview ----------
// due: cards to review today; fresh: new cards still allowed today (daily limit minus new cards
// already started today, on any device — counted from the logs).
export function deckStats(deck, now) {
  const ret = deck.retention || DEFAULT_RETENTION, limit = deck.newPerDay ?? DEFAULT_NEW_PER_DAY;
  const start = dayStart(now), end = dayEnd(now);
  const out = { total: 0, fresh: 0, newTotal: 0, learning: 0, due: 0, young: 0, mature: 0, startedToday: 0, recall: null, forecast: Array(7).fill(0), states: new Map() };
  let rSum = 0, rN = 0;
  for (const card of deck.cards || []) {
    const c = stateOf(card, ret);
    out.states.set(card.id, c);
    out.total++;
    if (c.st === 'new') { out.newTotal++; continue; }
    const first = reviewsOf(card)[0]?.[0];
    if (first >= start) out.startedToday++;
    if (c.st === 'review') { if (c.s >= 21) out.mature++; else out.young++; } else out.learning++;
    if (c.due < end) out.due++;
    else { const day = Math.floor((dayStart(c.due) - start) / DAY); if (day < 7) out.forecast[day]++; }
    const r = recallNow(c, now);
    if (r != null) { rSum += r; rN++; }
  }
  out.forecast[0] = out.due;
  out.fresh = Math.max(0, Math.min(out.newTotal, limit - out.startedToday));
  out.recall = rN ? rSum / rN : null;
  return out;
}

// ---------- Study session ----------
// Queue for one session: learning cards and today's reviews (lowest recall first), new cards
// spread in between, up to the daily limit. extra: cards to study ahead when nothing is due.
export function buildQueue(deck, now, { extra = 0 } = {}) {
  const st = deckStats(deck, now);
  const end = dayEnd(now);
  const cards = deck.cards || [];
  const due = cards.filter(c => { const s = st.states.get(c.id); return s.st !== 'new' && s.due < end; });
  due.sort((a, b) => (recallNow(st.states.get(a.id), now) ?? 1) - (recallNow(st.states.get(b.id), now) ?? 1));
  const fresh = cards.filter(c => st.states.get(c.id).st === 'new').slice(0, st.fresh);
  let ahead = [];
  if (extra && !due.length && !fresh.length) {
    ahead = cards.filter(c => st.states.get(c.id).st !== 'new').sort((a, b) => st.states.get(a.id).due - st.states.get(b.id).due).slice(0, extra);
    if (ahead.length < extra) ahead.push(...cards.filter(c => st.states.get(c.id).st === 'new').slice(0, extra - ahead.length));
  }
  // one new card after every few reviews
  const out = [];
  const every = fresh.length ? Math.max(1, Math.floor(due.length / fresh.length)) : 0;
  let i = 0;
  for (const c of due) { out.push(c.id); if (every && ++i % every === 0 && fresh.length) out.push(fresh.shift().id); }
  out.push(...fresh.map(c => c.id), ...ahead.map(c => c.id));
  return out;
}

// Picks the next card: a learning card whose step is due, else the next of the queue, else
// (queue empty) the learning card due soonest — so a card answered wrong comes back in the same
// session. Returns its id or null when the session is done. Never the card just shown, if avoidable.
export function nextCard(queue, learning, now, lastId) {
  const ready = learning.filter(x => x.due <= now && x.id !== lastId).sort((a, b) => a.due - b.due)[0];
  if (ready) return ready.id;
  const q = queue.find(id => id !== lastId) ?? queue[0];
  if (q) return q;
  const soon = [...learning].sort((a, b) => a.due - b.due);
  return (soon.find(x => x.id !== lastId) || soon[0])?.id ?? null;
}

// "1 Min", "10 Min", "3 Std", "2 T", "3 Mon", "1,5 J"
export function fmtIvl(ms) {
  const m = ms / MIN;
  if (m < 60) return `${Math.max(1, Math.round(m))} Min`;
  if (m < 60 * 20) return `${Math.round(m / 60)} Std`;
  const d = ms / DAY;
  if (d < 30.5) return `${Math.max(1, Math.round(d))} T`;
  if (d < 365) return `${Math.round(d / 30.4)} Mon`;
  return `${(d / 365).toFixed(1).replace('.', ',').replace(',0', '')} J`;
}
