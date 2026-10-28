// Flashcard decks ("Karteikarten"): a document type of its own in the library.
//   record { kind: 'deck', id, name, parent, …, retention?, newPerDay?,
//            cards: [{ id, front, back, created, log: [[time, grade]], reset? }] }
// grade 1 = Falsch, 2 = Unpräzise, aber richtig, 3 = Richtig. The schedule is computed from the log
// (srs.js, FSRS-6), so syncing merges progress by joining the logs (merge.js).
// Text format for import/export and the AI prompt: cardformat.js.
import { $, h, uid, debounce, pickFile } from './util.js';
import { icon } from './icons.js';
import { store, settings, saveSettings, bus } from './store.js';
import { menu, sheet, toast, promptText, confirmBox, segmented } from './ui.js';
import { renderLibrary } from './library.js';
import { ensureLocal } from './offload.js';
import { parseCards, cardsToText, AI_PROMPT, renderRich, plainCard } from './cardformat.js';
import { inkPad, inkView, hasInk } from './inkpad.js';
import { AGAIN, HARD, GOOD, stateOf, preview, deckStats, buildQueue, nextCard, fmtIvl, dayEnd, DEFAULT_RETENTION, DEFAULT_NEW_PER_DAY } from './srs.js';

export function newDeck({ name = 'Neue Karteikarten', parent = null, cards = [] } = {}) {
  const now = Date.now();
  return { kind: 'deck', id: uid(), name, parent, created: now, updated: now, opened: now, cards };
}
export const newCard = (front, back) => ({ id: uid(), front, back, created: Date.now() });

// Text of a deck for the library search
export const deckText = r => (r.cards || []).map(c => c.front + '\n' + c.back).join('\n');

// ---------- Library tile ----------
// A small stack of cards; the number due today is filled in once the deck has been read.
const dueCache = new Map(); // id → { key, due }
export function deckArt(r, small = false) {
  const badge = h('span', { class: 'deck-due', hidden: true });
  const el = h('div', { class: 'deck-art' + (small ? ' small' : '') },
    h('div', { class: 'deck-card back2' }), h('div', { class: 'deck-card back1' }),
    h('div', { class: 'deck-card front' },
      small ? null : h('span', { class: 'deck-name' }, r.name),
      small ? null : h('span', { class: 'deck-count' }, `${r.cardCount ?? r.cards?.length ?? 0} Karten`)),
    badge);
  if (!r.offloaded && !r.trashed) {
    const key = r.updated + '|' + Math.floor(Date.now() / 60000);
    const show = n => { if (n) { badge.textContent = n; badge.hidden = false; badge.title = `${n} heute fällig`; } };
    const known = dueCache.get(r.id);
    if (known?.key === key) show(known.due);
    else store.get(r.id).then(full => {
      if (!full?.cards) return;
      const st = deckStats(full, Date.now());
      dueCache.set(r.id, { key, due: st.due + st.fresh });
      show(st.due + st.fresh);
    }).catch(() => {});
  }
  return el;
}

// ---------- View state ----------
const dk = { doc: null, dirty: false, filter: '', session: null };
export const deckLocked = id => dk.doc?.id === id && dk.dirty;
const view = () => $('#deck');
const card = id => dk.doc?.cards.find(c => c.id === id);
const opts = () => ({ retention: dk.doc.retention || DEFAULT_RETENTION, newPerDay: dk.doc.newPerDay ?? DEFAULT_NEW_PER_DAY });

// study: start learning right away; chain: "Alles lernen" from the learning overview — when this
// deck is done, the finish screen offers the next deck with cards due (learnplan.js).
export async function openDeck(id, { study = false, chain = false } = {}) {
  let doc = await store.get(id);
  if (doc?.offloaded) doc = await ensureLocal(doc); // kept only in Google Drive: load it first
  if (!doc || doc.deleted || doc.trashed) {
    settings.openDeck = null; saveSettings();
    if ($('#library').hidden) { $('#library').hidden = false; renderLibrary(); }
    return toast('Stapel nicht gefunden');
  }
  doc.opened = Date.now();
  store.put(doc);
  dk.doc = doc; dk.session = null; dk.filter = '';
  settings.openDeck = id; saveSettings();
  $('#library').hidden = true; $('#editor').hidden = true; $('#textdoc').hidden = true;
  view().hidden = false;
  dk.chain = chain;
  renderOverview();
  if (study) startSession();
}

// Opens a deck with one card's edit sheet ("Oft vergessen" in the learning overview)
export async function openDeckCard(deckId, cardId) {
  await openDeck(deckId);
  const c = card(cardId);
  if (c) editCard(c);
}

export async function closeDeck() {
  await saveNow();
  dk.doc = null; dk.session = null; settings.openDeck = null; saveSettings();
  view().hidden = true;
  $('#library').hidden = false;
  renderLibrary();
}

const save = debounce(() => saveNow(), 400);
async function saveNow() {
  if (!dk.doc || !dk.dirty) return;
  dk.dirty = false;
  dk.doc.updated = Date.now();
  await store.put(dk.doc);
}
const changed = () => { dk.dirty = true; save(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

// Sync brought a newer version (e.g. reviews from the iPad): take it, keep the session going.
bus.addEventListener('remote', async e => {
  if (!dk.doc || e.detail !== dk.doc.id || dk.dirty) return;
  const doc = await store.get(dk.doc.id);
  if (!doc || doc.deleted || doc.trashed) return closeDeck();
  dk.doc = doc;
  if (dk.session) { if (!card(dk.session.cur)) showNext(); } else renderOverview();
});

function toolbar(extra = []) {
  return h('div', { class: 'toolbar' },
    h('div', { class: 'tb-group' },
      h('button', { class: 'barbtn', title: 'Bibliothek', 'aria-label': 'Bibliothek', onclick: closeDeck }, icon('home', 22)),
      h('button', { class: 'doc-title', title: 'Umbenennen', onclick: renameDeck }, h('span', {}, dk.doc.name))),
    h('div', { class: 'tb-group right' }, ...extra));
}

async function renameDeck() {
  const name = await promptText('Umbenennen', dk.doc.name);
  if (!name) return;
  dk.doc.name = name; changed(); await saveNow();
  renderOverview();
}

// ---------- Overview ----------
function statusOf(c, now) {
  if (c.st === 'new') return ['Neu', 'new'];
  if (c.st !== 'review') return ['Lernen', 'learn'];
  if (c.due < dayEnd(now)) return ['Fällig', 'due'];
  return ['in ' + fmtIvl(c.due - now), c.s >= 21 ? 'mature' : 'young'];
}

function renderOverview() {
  if (!dk.doc) return;
  const v = view(), d = dk.doc, now = Date.now();
  const st = deckStats(d, now);
  const todo = st.due + st.fresh;
  const startBtn = todo
    ? h('button', { class: 'dk-start', onclick: () => startSession() }, icon('play', 22), h('span', {}, 'Lernen'), h('b', {}, String(todo)))
    : h('div', { class: 'dk-done' }, h('b', {}, d.cards.length ? 'Für heute geschafft' : 'Noch keine Karten'),
      h('span', {}, d.cards.length ? nextDueText(st, now) : 'Importiere Karten oder lege sie selbst an.'));
  const ahead = !todo && d.cards.length
    ? h('button', { class: 'pill-btn', onclick: () => startSession({ extra: 20 }) }, 'Trotzdem lernen (vorziehen)') : null;
  const num = (n, label, cls) => h('div', { class: 'dk-num ' + cls }, h('b', {}, String(n)), h('span', {}, label));
  const seg = (n, cls) => (n ? h('i', { class: cls, style: { flexGrow: n } }) : null);
  const maxF = Math.max(1, ...st.forecast);
  const dayLabel = i => (i === 0 ? 'Heute' : i === 1 ? 'Morgen' : new Date(now + i * 86400000).toLocaleDateString('de-DE', { weekday: 'short' }));

  const hero = h('section', { class: 'dk-hero' },
    h('div', { class: 'dk-nums' }, num(st.due, 'Fällig', 'due'), num(st.fresh, 'Neu heute', 'new'), num(st.learning, 'Im Lernen', 'learn')),
    startBtn, ahead,
    d.cards.length ? h('div', { class: 'dk-progress' },
      h('div', { class: 'dk-bar' }, seg(st.newTotal, 'new'), seg(st.learning, 'learn'), seg(st.young, 'young'), seg(st.mature, 'mature')),
      h('div', { class: 'dk-legend' },
        h('span', {}, h('i', { class: 'new' }), `Neu ${st.newTotal}`), h('span', {}, h('i', { class: 'learn' }), `Lernen ${st.learning}`),
        h('span', {}, h('i', { class: 'young' }), `Jung ${st.young}`), h('span', {}, h('i', { class: 'mature' }), `Gefestigt ${st.mature}`)),
      st.recall != null ? h('div', { class: 'hint' }, `Geschätzte Erinnerung jetzt: ${Math.round(st.recall * 100)} % · Ziel ${Math.round(opts().retention * 100)} %`) : null) : null,
    d.cards.length - st.newTotal ? h('div', { class: 'dk-forecast', 'aria-label': 'Fällige Karten der nächsten 7 Tage' },
      st.forecast.map((n, i) => h('div', { class: 'dk-fc' }, h('span', { class: 'dk-fc-n' }, n || ''), h('div', { class: 'dk-fc-bar' }, h('i', { style: { height: (n / maxF) * 100 + '%' } })), h('span', { class: 'dk-fc-d' }, dayLabel(i))))) : null);

  const list = h('div', { class: 'dk-list' });
  const fill = () => {
    const q = dk.filter.toLowerCase();
    const rows = d.cards.filter(c => !q || (c.front + ' ' + c.back).toLowerCase().includes(q));
    list.replaceChildren(...rows.map(c => {
      const s = st.states.get(c.id) || stateOf(c, opts().retention);
      const [label, cls] = statusOf(s, now);
      return h('button', { class: 'dk-row', onclick: () => editCard(c) },
        h('span', { class: 'dk-row-text' }, rowSide(c.front, c.frontInk, 'b'), rowSide(c.back, c.backInk, 'span')),
        h('span', { class: 'dk-chip ' + cls }, label));
    }), rows.length ? '' : h('div', { class: 'empty' }, q ? 'Keine Treffer.' : ''));
  };
  fill();

  const cardsHead = h('div', { class: 'dk-list-head' },
    h('h2', {}, `Karten (${d.cards.length})`),
    h('input', { class: 'searchfield', type: 'search', placeholder: 'Karten durchsuchen…', value: dk.filter, 'aria-label': 'Karten durchsuchen', oninput: e => { dk.filter = e.target.value; fill(); } }),
    h('button', { class: 'pill-btn', onclick: () => editCard(null) }, icon('plus', 16), 'Karte'));

  const empty = !d.cards.length ? h('section', { class: 'dk-empty' },
    h('div', { class: 'dk-empty-icon' }, icon('cards', 34)),
    h('h2', {}, 'Noch keine Karten'),
    h('p', {}, 'Lege Karten selbst an – tippen oder mit dem Apple Pencil schreiben – oder lass eine KI sie aus deinem Skript erstellen.'),
    h('div', { class: 'dk-empty-btns' },
      h('button', { class: 'pill-btn primary', onclick: () => editCard(null) }, icon('plus', 16), 'Karte erstellen'),
      h('button', { class: 'pill-btn', onclick: () => importCardsSheet({ deck: d }) }, icon('paste', 16), 'Karten importieren'),
      h('button', { class: 'pill-btn', onclick: copyPrompt }, icon('copy', 16), 'KI-Prompt kopieren'))) : null;

  v.replaceChildren(
    toolbar([
      h('button', { class: 'barbtn', title: 'Neue Karte', 'aria-label': 'Neue Karte', onclick: () => editCard(null) }, icon('plus', 22)),
      h('button', { class: 'barbtn', title: 'Karten importieren', 'aria-label': 'Karten importieren', onclick: () => importCardsSheet({ deck: d }) }, icon('paste', 22)),
      h('button', { class: 'barbtn', title: 'Mehr', 'aria-label': 'Mehr', onclick: e => deckMenu(e.currentTarget) }, icon('dots', 22)),
    ]),
    h('div', { class: 'dk-scroll' }, h('div', { class: 'dk-page' }, d.cards.length ? hero : empty, d.cards.length ? cardsHead : null, d.cards.length ? list : null)));
}

function nextDueText(st, now) {
  let next = Infinity;
  for (const c of st.states.values()) if (c.st !== 'new' && c.due < next) next = c.due;
  if (next === Infinity) return st.newTotal ? `Tageslimit für neue Karten erreicht (${opts().newPerDay}). Noch ${st.newTotal} neue Karten.` : '';
  return `Nächste Wiederholung in ${fmtIvl(next - now)}` + (st.newTotal ? ` · ${st.newTotal} neue Karten warten (Tageslimit erreicht)` : '');
}

function deckMenu(anchor) {
  menu(anchor, [
    { label: 'Karten importieren', icon: 'paste', action: () => importCardsSheet({ deck: dk.doc }) },
    { label: 'KI-Prompt kopieren', icon: 'copy', action: copyPrompt },
    { label: 'Als Text exportieren', icon: 'share', action: () => exportDeck(dk.doc) },
    '-',
    { label: 'Lerneinstellungen', icon: 'gear', action: deckSettings },
    { label: 'Lernfortschritt zurücksetzen', icon: 'restore', danger: true, action: resetAll },
  ]);
}

async function deckSettings() {
  let retention = opts().retention, perDay = opts().newPerDay;
  const perDayField = h('input', { class: 'field', type: 'number', min: 0, max: 999, inputmode: 'numeric', value: perDay, oninput: e => { perDay = e.target.value; } });
  const body = h('div', { class: 'form' },
    h('div', { class: 'form-label' }, 'Ziel-Behaltensrate'),
    segmented([[0.8, '80 %'], [0.85, '85 %'], [0.9, '90 %'], [0.95, '95 %']], retention, v => { retention = v; }),
    h('div', { class: 'hint' }, 'Mit welcher Wahrscheinlichkeit du eine Karte bei der Wiederholung noch weißt. Höher = sicherer, aber deutlich mehr Wiederholungen. 90 % ist der empfohlene Standard.'),
    h('div', { class: 'form-label' }, 'Neue Karten pro Tag'),
    perDayField,
    h('div', { class: 'hint' }, 'Begrenzt, wie viele neue Karten täglich dazukommen (alle Geräte zusammen). Fällige Wiederholungen kommen immer dran.'));
  if (!(await sheet({ title: 'Lerneinstellungen', body }))) return;
  dk.doc.retention = retention;
  dk.doc.newPerDay = Math.max(0, Math.min(999, Math.round(+perDay || 0)));
  changed(); await saveNow(); renderOverview();
}

async function resetAll() {
  if (!(await confirmBox('Lernfortschritt zurücksetzen?', 'Alle Karten gelten danach wieder als neu. Die Karten selbst bleiben erhalten.', 'Zurücksetzen', true))) return;
  const now = Date.now();
  for (const c of dk.doc.cards) c.reset = now;
  changed(); await saveNow(); renderOverview();
}

// ---------- Editing a card ----------
async function editCard(c, mode) {
  const isNew = !c;
  // Tippen or Schreiben (Apple Pencil, mouse, finger); remembered per device. A card written by
  // hand opens in "Schreiben".
  const anyInk = c && (hasInk(c.frontInk) || hasInk(c.backInk)), anyText = c && (c.front || c.back);
  mode ||= anyInk && !anyText ? 'ink' : anyText ? 'text' : settings.cardInput || 'text';
  const side = (label, text, ink, placeholder, rows) => {
    const area = h('textarea', { class: 'field dk-area', rows, placeholder });
    area.value = text || '';
    const prev = h('div', { class: 'fc-text dk-preview' });
    const pad = inkPad(ink);
    const extra = h('div', { class: 'dk-side-extra' });
    const show = () => {
      area.hidden = mode !== 'text'; pad.el.hidden = mode !== 'ink';
      renderRich(prev, area.value || ' ');
      prev.hidden = mode !== 'text' && !area.value.trim();
      const written = pad.value();
      extra.replaceChildren(...(mode === 'text' && written ? [h('span', { class: 'hint' }, 'Handschrift:'), inkView(written, { maxW: 240, maxH: 70 })] : []));
    };
    area.oninput = show;
    return { el: [h('div', { class: 'form-label' }, label), area, pad.el, prev, extra], show, area, text: () => area.value.trim(), ink: () => pad.value() };
  };
  const F = side('Vorderseite', c?.front, c?.frontInk, 'Frage oder Begriff', 3);
  const B = side('Rückseite', c?.back, c?.backInk, 'Antwort', 4);
  const sides = [F, B];
  const setMode = v => { mode = v; settings.cardInput = v; saveSettings(); sides.forEach(s => s.show()); tip.textContent = TIPS[v]; if (v === 'text' && matchMedia('(hover: hover)').matches) F.area.focus(); };
  const TIPS = {
    text: 'Formeln in LaTeX zwischen $…$ (abgesetzt $$…$$), **fett**, *kursiv*, Aufzählungen mit „- “. iPad: Mit dem Apple Pencil kannst du auch direkt ins Textfeld schreiben (Kritzeln), es wird zu Text.',
    ink: 'Mit Apple Pencil, Maus oder Finger schreiben. Stift und Farben wie im Notizbuch; Finger schreiben nur, solange „Nur mit Stift zeichnen“ aus ist oder noch kein Pencil benutzt wurde.',
  };
  const tip = h('div', { class: 'hint' }, TIPS[mode]);
  let action = null;
  const submit = (e, a) => { action = a; e.currentTarget.closest('.sheet').querySelector('.sheet-head .textbtn.strong').click(); };
  const s = c && stateOf(c, opts().retention);
  const body = h('div', { class: 'form dk-edit' },
    h('div', { class: 'dk-mode' }, segmented([['text', 'Tippen'], ['ink', 'Schreiben']], mode, setMode)),
    ...F.el, ...B.el, tip,
    s && s.st !== 'new' ? h('div', { class: 'hint' }, `${s.reps} Wiederholung(en), ${s.lapses}× vergessen · nächste ${s.due < Date.now() ? 'jetzt fällig' : 'in ' + fmtIvl(s.due - Date.now())} · Stabilität ${s.s.toFixed(1).replace('.', ',')} Tage`) : null,
    isNew ? h('div', { class: 'dk-edit-btns' },
      h('button', { class: 'pill-btn primary', title: 'Strg+Enter', onclick: e => submit(e, 'next') }, icon('plus', 16), 'Hinzufügen & nächste Karte')) : null,
    c ? h('div', { class: 'dk-edit-btns' },
      h('button', { class: 'pill-btn', onclick: e => submit(e, 'reset') }, icon('restore', 16), 'Als neu lernen'),
      h('button', { class: 'pill-btn danger', onclick: e => submit(e, 'delete') }, icon('trash', 16), 'Löschen')) : null);
  // Strg+Enter: add and go on with the next card (typing many cards in a row)
  body.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); action = isNew ? 'next' : null; body.closest('.sheet').querySelector('.sheet-head .textbtn.strong').click(); }
  });
  const filled = x => x.text() || x.ink();
  const shown = sheet({
    title: isNew ? 'Neue Karte' : 'Karte bearbeiten', body, done: isNew ? 'Hinzufügen' : 'Fertig', className: 'wide',
    onDone: () => (action === 'delete' || (filled(F) && filled(B))) || (toast('Bitte Vorder- und Rückseite ausfüllen – tippen oder schreiben'), false),
  });
  sides.forEach(x => x.show());
  if (mode === 'text' && matchMedia('(hover: hover)').matches) F.area.focus();
  const ok = await shown;
  if (!ok) return;
  if (c) c = card(c.id) || c; // a sync may have replaced the deck while the sheet was open
  if (action === 'delete') {
    if (!(await confirmBox('Karte löschen?', plainCard(c.front).slice(0, 80) || 'Handschriftliche Karte', 'Löschen', true))) return;
    dk.doc.cards = dk.doc.cards.filter(x => x.id !== c.id);
  } else {
    if (isNew) { c = newCard('', ''); dk.doc.cards.push(c); }
    c.front = F.text(); c.back = B.text();
    for (const [k, x] of [['frontInk', F], ['backInk', B]]) { const ink = x.ink(); if (ink) c[k] = ink; else delete c[k]; }
    if (action === 'reset') c.reset = Date.now();
  }
  changed(); await saveNow();
  if (dk.session) renderStudy(); else renderOverview();
  if (action === 'next') editCard(null, mode);
}

// ---------- Import ----------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const t = h('textarea', { style: { position: 'fixed', opacity: '0' } }); t.value = text;
  document.body.append(t); t.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  t.remove();
  return ok;
}
export async function copyPrompt() {
  if (await copyText(AI_PROMPT)) toast('Prompt kopiert – in die KI einfügen und dein Skript anhängen', 3500);
  else toast('Kopieren nicht möglich', 3000);
}

// Import sheet: paste (iPad: long press in the field → Einsetzen, or the button), a file, or typed
// text. deck: add to this deck; otherwise a new deck in `parent`. text: pre-filled (dropped file).
export async function importCardsSheet({ deck = null, parent = null, text = '' } = {}) {
  const area = h('textarea', { class: 'field dk-import', rows: 9, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off',
    placeholder: '# Biologie – Zelle\n\nF: Was ist die Aufgabe der Mitochondrien?\nA: Energiegewinnung (ATP) durch Zellatmung.\n\nF: …\nA: …' });
  area.value = text;
  const nameField = deck ? null : h('input', { class: 'field', placeholder: 'Name des Stapels' });
  let nameTouched = false;
  if (nameField) nameField.oninput = () => { nameTouched = true; };
  const status = h('div', { class: 'dk-import-status', role: 'status' });
  const prev = h('div', { class: 'dk-import-preview' });
  let parsed = { cards: [], skipped: 0, name: '' };
  const update = () => {
    parsed = parseCards(area.value);
    if (nameField && !nameTouched && parsed.name) nameField.value = parsed.name;
    const n = parsed.cards.length;
    status.textContent = !area.value.trim() ? '' : n
      ? `${n} Karte${n === 1 ? '' : 'n'} erkannt${parsed.skipped ? ` · ${parsed.skipped} unvollständige übersprungen` : ''}`
      : 'Keine Karten erkannt. Jede Karte braucht eine Zeile „F: …“ und eine Zeile „A: …“.';
    status.classList.toggle('bad', !!area.value.trim() && !n);
    prev.replaceChildren(...parsed.cards.slice(0, 3).map(c => h('div', { class: 'dk-import-card' }, h('b', {}, plainCard(c.front)), h('span', {}, plainCard(c.back)))),
      n > 3 ? h('div', { class: 'hint' }, `… und ${n - 3} weitere`) : '');
  };
  area.addEventListener('input', update);
  const paste = async () => {
    area.focus();
    try {
      const t = await navigator.clipboard.readText();
      if (t) { area.value = t; update(); return; }
    } catch {}
    status.textContent = 'Bitte lange ins Feld drücken und „Einsetzen“ wählen.';
  };
  const file = async () => {
    const f = await pickFile(''); // no filter: iPadOS greys out .md/.json otherwise
    if (!f) return;
    if (f.size > 5e6) return toast('Die Datei ist zu groß für Karteikarten', 3000);
    area.value = await f.text(); update();
    if (nameField && !nameTouched && !parsed.name) nameField.value = f.name.replace(/\.[^.]+$/, '');
  };
  const body = h('div', { class: 'form' },
    h('div', { class: 'dk-step' }, h('b', {}, '1'), h('div', {},
      h('div', {}, 'KI-Prompt kopieren und zusammen mit deinem Skript an eine KI geben (ChatGPT, Claude, Gemini …).'),
      h('button', { class: 'pill-btn', onclick: copyPrompt }, icon('copy', 16), 'KI-Prompt kopieren'))),
    h('div', { class: 'dk-step' }, h('b', {}, '2'), h('div', {}, 'Antwort der KI kopieren und hier einfügen – oder eine Textdatei wählen.')),
    area,
    h('div', { class: 'dk-import-btns' },
      h('button', { class: 'pill-btn', onclick: paste }, icon('paste', 16), 'Einsetzen'),
      h('button', { class: 'pill-btn', onclick: file }, icon('doc', 16), 'Datei wählen…')),
    status, prev,
    nameField ? [h('div', { class: 'form-label' }, 'Name des Stapels'), nameField] : null,
    h('details', { class: 'paste-help' },
      h('summary', {}, 'Format'),
      h('p', {}, 'Jede Karte: eine Zeile „F: Vorderseite“, dann „A: Rückseite“. Weitere Zeilen gehören zur Rückseite, bis zur nächsten „F:“-Zeile. Eine Zeile „# Name“ am Anfang benennt den Stapel. Formeln in LaTeX zwischen $…$.'),
      h('p', {}, 'Auch möglich: Frage/Antwort, Q/A, eine Karte pro Zeile mit Tab, „::“ oder „;“ getrennt (Anki/Quizlet-Export), Markdown-Tabellen und JSON [{"front": …, "back": …}].')));
  if (text) update();
  const shown = sheet({
    title: deck ? 'Karten importieren' : 'Karteikarten importieren', body, done: 'Importieren', className: 'wide',
    onDone: () => parsed.cards.length > 0 || (toast('Keine Karten erkannt'), false),
  });
  // PC: straight into the text field. Touch: no keyboard popping up over the sheet.
  if (matchMedia('(hover: hover)').matches) area.focus(); else document.activeElement?.blur();
  const ok = await shown;
  if (!ok) return;
  if (deck) {
    const target = dk.doc?.id === deck.id ? dk.doc : await store.get(deck.id);
    const seen = new Set(target.cards.map(c => c.front.trim() + '\u0000' + c.back.trim()));
    const add = parsed.cards.filter(c => !seen.has(c.front + '\u0000' + c.back));
    target.cards.push(...add.map(c => newCard(c.front, c.back)));
    const dup = parsed.cards.length - add.length;
    if (dk.doc === target) { changed(); await saveNow(); renderOverview(); }
    else { target.updated = Date.now(); await store.put(target); }
    toast(`${add.length} Karte${add.length === 1 ? '' : 'n'} hinzugefügt${dup ? ` · ${dup} doppelte übersprungen` : ''}`, 3000);
    return;
  }
  const d = newDeck({ name: nameField.value.trim() || parsed.name || 'Karteikarten', parent, cards: parsed.cards.map(c => newCard(c.front, c.back)) });
  await store.put(d);
  toast(`${d.cards.length} Karten importiert`);
  openDeck(d.id);
}

export async function exportDeck(r) {
  const d = r.cards ? r : await ensureLocal(r);
  if (!d) return;
  const name = (d.name || 'Karteikarten').replace(/[\\/:*?"<>|]/g, '_') + '.txt';
  const file = new File([cardsToText(d)], name, { type: 'text/plain' });
  if (navigator.canShare?.({ files: [file] }) && /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) {
    try { await navigator.share({ files: [file] }); } catch (err) { if (err.name !== 'AbortError') toast('Teilen nicht möglich: ' + err.message, 4000); }
    return;
  }
  const a = h('a', { href: URL.createObjectURL(file), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------- Study session ----------
// queue: ids still to show; learning: cards in a learning step today [{ id, due }] (come back in
// this session, a wrong answer after 1 min / 10 min); undo: snapshots for "Rückgängig".
function startSession({ extra = 0 } = {}) {
  const queue = buildQueue(dk.doc, Date.now(), { extra });
  if (!queue.length) return toast('Keine Karten zu lernen');
  dk.session = { queue, learning: [], cur: null, flipped: false, last: null, undo: [], counts: { 1: 0, 2: 0, 3: 0 }, done: 0 };
  showNext();
}

function showNext() {
  const s = dk.session;
  s.queue = s.queue.filter(card); s.learning = s.learning.filter(x => card(x.id)); // deleted meanwhile
  s.cur = nextCard(s.queue, s.learning, Date.now(), s.last);
  s.flipped = false;
  renderStudy();
}

function rate(g) {
  const s = dk.session, c = card(s.cur);
  if (!c || !s.flipped) return;
  const now = Date.now();
  s.undo.push({ id: c.id, log: c.log ? [...c.log] : undefined, queue: [...s.queue], learning: s.learning.map(x => ({ ...x })), counts: { ...s.counts }, done: s.done, last: s.last });
  c.log = [...(c.log || []), [now, g]];
  s.queue = s.queue.filter(id => id !== c.id);
  s.learning = s.learning.filter(x => x.id !== c.id);
  const st = stateOf(c, opts().retention);
  if (st.st !== 'review' && st.due < dayEnd(now)) s.learning.push({ id: c.id, due: st.due });
  s.counts[g]++; s.done++; s.last = c.id;
  changed();
  showNext();
}

function undo() {
  const s = dk.session, u = s?.undo.pop();
  if (!u) return;
  const c = card(u.id);
  if (c) { if (u.log) c.log = u.log; else delete c.log; }
  Object.assign(s, { queue: u.queue, learning: u.learning, counts: u.counts, done: u.done, last: u.last, cur: u.id, flipped: true });
  changed();
  renderStudy();
}

function flip() { if (dk.session && !dk.session.flipped && card(dk.session.cur)) { dk.session.flipped = true; renderStudy(); } }

// "Alles lernen": after a deck, the next one with the most cards due today — or back to the overview
function chainNext() {
  const box = h('div', { class: 'fc-chain' });
  const toPlan = async () => { await saveNow(); dk.session = null; await closeDeck(); (await import('./library.js')).goSection('learn'); };
  (async () => {
    await saveNow();
    const { loadDecks, planStats } = await import('./learnplan.js');
    const P = planStats(await loadDecks());
    const next = P.decks.filter(d => d.st && d.meta.id !== dk.doc?.id && d.st.due + d.st.fresh)
      .sort((a, b) => (b.st.due + b.st.fresh) - (a.st.due + a.st.fresh))[0];
    box.replaceChildren(...[
      next ? h('button', { class: 'pill-btn primary', onclick: () => openDeck(next.meta.id, { study: true, chain: true }) },
        icon('play', 14), `Weiter mit „${next.meta.name}“ (${next.st.due + next.st.fresh})`)
        : h('p', { class: 'fc-chain-done' }, 'Alle Stapel für heute geschafft.'),
      h('button', { class: 'pill-btn' + (next ? '' : ' primary'), onclick: toPlan }, 'Zur Lernübersicht'),
    ]);
  })();
  return box;
}

async function endSession() {
  dk.session = null;
  await saveNow();
  renderOverview();
}

function renderStudy() {
  const s = dk.session, v = view();
  if (!s) return;
  const c = card(s.cur);
  const left = s.queue.length + s.learning.length;
  const total = s.done + left;
  const top = h('div', { class: 'toolbar fc-bar' },
    h('div', { class: 'tb-group' },
      h('button', { class: 'barbtn', title: 'Beenden (Esc)', 'aria-label': 'Lernen beenden', onclick: endSession }, icon('close', 22)),
      h('div', { class: 'fc-count' }, c ? `Noch ${left}` : 'Fertig')),
    h('div', { class: 'fc-progress' }, h('i', { style: { width: (total ? (s.done / total) * 100 : 100) + '%' } })),
    h('div', { class: 'tb-group right' },
      c ? h('button', { class: 'barbtn', title: 'Karte bearbeiten (E)', 'aria-label': 'Karte bearbeiten', onclick: () => editCard(c) }, icon('rename', 20)) : null,
      h('button', { class: 'barbtn', title: 'Rückgängig (Strg+Z)', 'aria-label': 'Rückgängig', disabled: !s.undo.length, onclick: undo }, icon('undo', 22))));
  if (!c) {
    const n = s.counts;
    v.replaceChildren(top, h('div', { class: 'fc-stage' }, h('div', { class: 'fc-finish' },
      h('div', { class: 'fc-finish-icon' }, icon('check', 34)),
      h('h2', {}, 'Geschafft!'),
      h('p', {}, `${s.done} Antwort${s.done === 1 ? '' : 'en'}: ${n[3]} richtig · ${n[2]} unpräzise · ${n[1]} falsch`),
      h('p', { class: 'hint' }, nextDueText(deckStats(dk.doc, Date.now()), Date.now())),
      dk.chain ? chainNext() : h('button', { class: 'pill-btn primary', onclick: endSession }, 'Zur Übersicht'))));
    return;
  }
  const st = stateOf(c, opts().retention);
  const tag = st.st === 'new' ? 'Neu' : st.st === 'review' ? 'Wiederholung' : 'Nochmal';
  const face = h('div', { class: 'fc-card' + (s.flipped ? ' flipped' : ''), role: 'button', tabindex: '0', 'aria-label': s.flipped ? 'Karte' : 'Antwort zeigen', onclick: e => { if (!e.target.closest('a')) flip(); } },
    h('span', { class: 'fc-tag ' + st.st }, tag),
    sideView(c.front, c.frontInk, 'fc-front', 260),
    s.flipped ? h('div', { class: 'fc-sep' }) : null,
    s.flipped ? sideView(c.back, c.backInk, 'fc-back', 340) : null);
  let actions;
  if (!s.flipped) {
    actions = h('div', { class: 'fc-actions' }, h('button', { class: 'fc-show', onclick: flip }, 'Antwort zeigen', h('kbd', {}, 'Leertaste')));
  } else {
    const p = preview(c, Date.now(), opts().retention);
    const btn = (g, label, cls, key) => h('button', { class: 'fc-grade ' + cls, onclick: () => rate(g) },
      h('b', {}, label), h('span', {}, fmtIvl(p[g])), h('kbd', {}, key));
    actions = h('div', { class: 'fc-actions grades' },
      btn(AGAIN, 'Falsch', 'again', '1'), btn(HARD, 'Unpräzise', 'hard', '2'), btn(GOOD, 'Richtig', 'good', '3'));
  }
  v.replaceChildren(top, h('div', { class: 'fc-stage' }, h('div', { class: 'fc-scroll' }, face), actions));
}

// Keyboard: Space/Enter show the answer, then 1 / 2 / 3 (Space = Richtig); Strg+Z undo; E edit; Esc end
document.addEventListener('keydown', e => {
  if (!dk.session || view().hidden || document.querySelector('.backdrop, .popover')) return;
  if (e.target.matches?.('input, textarea, [contenteditable="true"]')) return;
  const s = dk.session, k = e.key;
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); return undo(); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'Escape') { e.preventDefault(); return endSession(); }
  if (!card(s.cur)) { if (k === 'Enter' || k === ' ') { e.preventDefault(); endSession(); } return; }
  if (k === 'e' || k === 'E') { e.preventDefault(); return editCard(card(s.cur)); }
  if (!s.flipped) { if (k === ' ' || k === 'Enter') { e.preventDefault(); flip(); } return; }
  const g = { 1: AGAIN, 2: HARD, 3: GOOD, ' ': GOOD, Enter: GOOD }[k];
  if (g) { e.preventDefault(); rate(g); }
});


// One side of a card: its text (formatted) and/or its handwriting
function sideView(text, ink, cls, maxH) {
  const el = h('div', { class: 'fc-text ' + cls });
  if (text) el.append(renderRich(h('div'), text));
  if (hasInk(ink)) el.append(h('div', { class: 'fc-ink' }, inkView(ink, { maxW: Math.min(680, innerWidth - 72), maxH })));
  return el;
}
// List row: the text, or a small picture of the handwriting
function rowSide(text, ink, tag) {
  if (text || !hasInk(ink)) return h(tag, {}, plainCard(text));
  return h(tag, { class: 'dk-row-ink' }, inkView(ink, { maxW: 160, maxH: tag === 'b' ? 30 : 24 }));
}
