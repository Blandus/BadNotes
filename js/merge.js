// Three-way merge of two versions of one record (local L, remote R) against the version both
// devices last agreed on (base B, kept per record since the last sync, see store.js 'bases').
//
// - Fields: a field changed on one side only takes that change; changed on both sides to
//   different values → the local value stays and a note records the other one.
// - Pages (notebooks), elements (strokes, text, images) and text blocks (text documents) are
//   matched by their id: additions from both sides are kept, a deletion is applied unless the
//   other side changed that item (then it stays, with a note), and an item changed on both sides
//   is kept twice (remote version in place, local version as a copy next to it, with a note).
// - Order (pages, element layers, blocks): the side that reordered wins, items new on the other
//   side are inserted after their predecessor.
// - A deleted record (tombstone) against an edited one: the edit wins, with a note.
// Pure functions, no I/O.
import { uid } from './util.js';

// JSON with sorted object keys, so equal content compares equal regardless of key order
const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));
export const same = (a, b) => stable(a) === stable(b);

const LIST_KEYS = { notebook: 'pages', textdoc: 'blocks', deck: 'cards' };
const SKIP = new Set(['id', 'kind', 'updated', 'pages', 'blocks', 'cards', 'conflicts']);
const FIELD_LABEL = { name: 'Name', parent: 'Ordner', cover: 'Cover', color: 'Farbe', icon: 'Symbol', retention: 'Ziel-Behaltensrate', newPerDay: 'Neue Karten pro Tag' };
const show = v => (v == null || v === '' ? '–' : v.strokes ? `Handschrift mit ${v.strokes.length} Strich${v.strokes.length === 1 ? '' : 'en'}` : typeof v === 'string' ? `„${v.length > 40 ? v.slice(0, 40) + '…' : v}“` : JSON.stringify(v).slice(0, 40));

// Whether every item carries an id (pages of very old records may not) — otherwise no merge.
export const mergeable = r => !r || r.deleted || !LIST_KEYS[r.kind] || (r[LIST_KEYS[r.kind]] || []).every(x => x && x.id
  && (r.kind !== 'notebook' || (x.elements || []).every(e => e && e.id)));

// Order of ids: the side that changed the order relative to the base wins; items only the other
// side has are inserted after their nearest predecessor there.
export function mergeOrder(bo, lo, ro) {
  // reordered = items both sides still have are no longer in base order (additions/deletions don't count)
  const common = bo.filter(id => lo.includes(id) && ro.includes(id));
  const reordered = xs => { const s = xs.filter(id => common.includes(id)); return s.some((id, i) => id !== common[i]); };
  const [primary, secondary] = reordered(lo) && !reordered(ro) ? [lo, ro] : [ro, lo];
  const out = [...primary];
  secondary.forEach((id, i) => {
    if (out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const k = out.indexOf(secondary[j]); if (k >= 0) { at = k + 1; break; } }
    out.splice(at, 0, id);
  });
  return out;
}

// Merge lists of items with ids. mergeItem(B, L, R) handles an item changed on both sides and
// returns { item, dup } (dup: an extra copy placed right after it).
// progressOnly(B, X): the item differs from the base only in ways a deletion may override
// (flashcards: new reviews) — then a deletion on the other side stands, without a note.
function mergeList(b, l, r, ctx, what, mergeItem, progressOnly = () => false) {
  const map = xs => new Map((xs || []).map(x => [x.id, x]));
  const bm = map(b), lm = map(l), rm = map(r);
  const out = new Map(), dups = new Map();
  for (const id of new Set([...lm.keys(), ...rm.keys()])) {
    const B = bm.get(id), L = lm.get(id), R = rm.get(id);
    if (L && R) {
      if (same(L, R) || (B && same(R, B))) out.set(id, L);
      else if (B && same(L, B)) out.set(id, R);
      else { const m = mergeItem(B, L, R); out.set(id, m.item); if (m.dup) dups.set(id, m.dup); }
    } else {
      const X = L || R;
      if (!B) out.set(id, X);       // new on that side
      else if (!same(X, B) && !progressOnly(B, X)) { // deleted on one side, changed on the other: keep it
        out.set(id, X);
        ctx.note(L ? `${what} wurde auf einem anderen Gerät gelöscht, hier aber geändert – bleibt erhalten.`
          : `${what} wurde hier gelöscht, auf einem anderen Gerät aber geändert – wiederhergestellt.`);
      }                             // else: deleted on one side, unchanged on the other → stays deleted
    }
  }
  const ids = xs => (xs || []).map(x => x.id);
  const res = [];
  for (const id of mergeOrder(ids(b), ids(l), ids(r))) {
    if (!out.has(id)) continue;
    res.push(out.get(id));
    if (dups.has(id)) res.push(dups.get(id));
  }
  return res;
}

// Plain fields of an object (record or page)
function mergeFields(B, L, R, ctx, skip, labels = FIELD_LABEL) {
  const res = {};
  for (const k of new Set([...Object.keys(L), ...Object.keys(R)])) {
    if (skip.has(k)) continue;
    const b = B?.[k], l = L[k], r = R[k];
    let v;
    if (same(l, r)) v = l;
    else if (k === 'opened') v = Math.max(l || 0, r || 0);
    else if (same(l, b)) v = r;
    else if (same(r, b)) v = l;
    else {
      v = l;
      ctx.note(`${labels[k] || `Feld „${k}“`} wurde auf zwei Geräten verschieden geändert – behalten: ${show(l)}, auf dem anderen Gerät: ${show(r)}.`);
    }
    if (v !== undefined) res[k] = v;
  }
  return res;
}

// Goodnotes-style 10-character ids for text blocks (see textdoc.js)
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const nodeId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => ALPHA[b & 63]).join('');

// Leaf item (element, text block) changed on both sides: remote in place, local as a copy.
const leafMerge = (ctx, what, newId) => (B, L, R) => {
  ctx.note(`${what} wurde auf zwei Geräten geändert – beide Fassungen sind erhalten (die von hier als Kopie daneben).`);
  const dup = { ...structuredClone(L), id: newId() };
  // text boxes and images: slightly offset, so the two versions don't sit exactly on top of each other
  if ((dup.type === 'text' || dup.type === 'image') && typeof dup.x === 'number' && typeof dup.y === 'number') { dup.x += 18; dup.y += 18; }
  return { item: R, dup };
};

// Infinite pages grow on both devices: the merged area covers both (no note).
const INF_AREA = ['x0', 'y0', 'w', 'h'];
function unionArea(L, R) {
  const box = p => [p.x0 || 0, p.y0 || 0, (p.x0 || 0) + (p.w || 0), (p.y0 || 0) + (p.h || 0)];
  const [a, b] = [box(L), box(R)];
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  return { x0, y0, w: Math.max(a[2], b[2]) - x0, h: Math.max(a[3], b[3]) - y0 };
}

const mergePage = ctx => (B, L, R) => ({
  item: {
    ...mergeFields(B, L, R, ctx, new Set(['id', 'elements', ...(L.inf && R.inf ? INF_AREA : [])]), { template: 'Seitenvorlage', paper: 'Papier', bg: 'Seitenhintergrund', h: 'Seitenformat', bookmark: 'Lesezeichen' }),
    ...(L.inf && R.inf ? unionArea(L, R) : {}),
    id: L.id,
    elements: mergeList(B?.elements, L.elements, R.elements, ctx, 'Ein Element', leafMerge(ctx, 'Ein Element', uid)),
  },
});

// Flashcards (deck.js / srs.js): the learning progress is the card's review log, so reviews made on
// two devices are simply put together (union, by time) and the schedule is replayed from it — no
// conflict. A reset of the progress (card.reset = time) is kept as the later of both. Text (front,
// back) is merged like any field. A card deleted on one device stays deleted even if it was
// studied on the other; only an edit of its text brings it back (with a note).
const logKey = e => e[0] + ':' + e[1];
function unionLog(a = [], b = []) {
  const m = new Map();
  for (const e of [...a, ...b]) if (Array.isArray(e)) m.set(logKey(e), e);
  return [...m.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
const CARD_PROGRESS = new Set(['id', 'log', 'reset']);
const cardText = c => Object.fromEntries(Object.entries(c || {}).filter(([k]) => !CARD_PROGRESS.has(k)));
const cardProgressOnly = (B, X) => same(cardText(B), cardText(X));
const mergeCard = ctx => (B, L, R) => {
  const item = { ...mergeFields(B, L, R, ctx, CARD_PROGRESS, { front: 'Die Vorderseite einer Karte', back: 'Die Rückseite einer Karte', frontInk: 'Die Handschrift auf einer Vorderseite', backInk: 'Die Handschrift auf einer Rückseite' }), id: L.id };
  const log = unionLog(L.log, R.log);
  if (log.length) item.log = log;
  const reset = Math.max(L.reset || 0, R.reset || 0);
  if (reset) item.reset = reset;
  return { item };
};
export { unionLog };

// B must exist (without a base sync.js keeps the newer version instead).
// Returns { rec, notes }; rec.updated is set by the caller.
export function merge3(B, L, R) {
  const notes = [];
  const ctx = { note: t => { if (!notes.includes(t)) notes.push(t); } };
  // Deleted records (tombstones): an edit beats a deletion.
  if (L.deleted || R.deleted) {
    if (L.deleted && R.deleted) return { rec: R, notes };
    if (R.deleted) notes.push('Auf einem anderen Gerät endgültig gelöscht, hier aber bearbeitet – das Dokument bleibt erhalten.');
    else notes.push('Hier endgültig gelöscht, auf einem anderen Gerät aber bearbeitet – das Dokument wurde wiederhergestellt.');
    const rec = structuredClone(R.deleted ? L : R);
    rec.conflicts = [...(rec.conflicts || []), ...notes.map(text => ({ at: Date.now(), text }))].slice(-20);
    return { rec, notes };
  }
  const rec = { ...mergeFields(B, L, R, ctx, SKIP), id: L.id, kind: L.kind || R.kind };
  const key = LIST_KEYS[rec.kind];
  if (key === 'pages') rec.pages = mergeList(B?.pages, L.pages, R.pages, ctx, 'Eine Seite', mergePage(ctx));
  if (key === 'blocks') rec.blocks = mergeList(B?.blocks, L.blocks, R.blocks, ctx, 'Ein Absatz', leafMerge(ctx, 'Ein Absatz', nodeId));
  if (key === 'cards') rec.cards = mergeList(B?.cards, L.cards, R.cards, ctx, 'Eine Karteikarte', mergeCard(ctx), cardProgressOnly);
  // Conflict notes of both sides stay until the user dismisses them; a note both sides had and
  // one side dismissed since stays dismissed.
  const key2 = c => c.at + '|' + c.text;
  const lk = new Set((L.conflicts || []).map(key2)), rk = new Set((R.conflicts || []).map(key2)), bk = new Set((B?.conflicts || []).map(key2));
  const list = [];
  for (const c of [...(R.conflicts || []), ...(L.conflicts || [])]) {
    const k = key2(c);
    if (list.some(x => key2(x) === k)) continue;
    if (bk.has(k) && !(lk.has(k) && rk.has(k))) continue;
    list.push(c);
  }
  const now = Date.now();
  for (const text of notes) list.push({ at: now, text });
  if (list.length) rec.conflicts = list.slice(-20);
  return { rec, notes };
}
