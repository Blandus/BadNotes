// Flashcard text format: easy to write by hand and for an AI to produce, read leniently.
//
//   # Name des Stapels            (optional)
//
//   F: Vorderseite (Frage, Begriff)
//   A: Rückseite (Antwort)
//      weitere Zeilen gehören zur Rückseite, bis zur nächsten „F:“-Zeile
//
//   F: Was beschreibt $E = mc^2$?
//   A: Die Äquivalenz von Masse und Energie.
//
// Also accepted: Q:/Frage:/Front:/Vorderseite: and Antwort:/Answer:/Back:/Rückseite:, written
// bold (**F:**), as list items or numbered ("1. F:"); "---" lines between cards; a code fence around
// everything (AI chats wrap output in one). Without any such labels: one card per line, front and
// back separated by a tab, " :: " or ";" (Anki/Quizlet text export), or a Markdown table.
// JSON works too: [{ "front": …, "back": … }] or { "name": …, "cards": [...] } (also question/answer,
// q/a, frage/antwort, or [front, back] pairs).
// Card text: **fett**, *kursiv*, `code`, lists ("- "), line breaks, formulas in LaTeX: $…$ inline,
// $$…$$ or \[…\] as a block (drawn with KaTeX, loaded only when a card has a formula).

const FRONT = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*(?:F|Q|Frage|Question|Front|Vorderseite|Begriff|Term)(?:\s*\d+)?\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s?/i;
const BACK = /^\s*(?:[-*+•]\s+|\d+[.)]\s+)?(?:\*\*|__)?\s*(?:A|Antwort|Answer|Back|R[üu]ckseite|Rueckseite|Definition|L[öo]sung)(?:\s*\d+)?\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s?/i;
const SEP = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;
const TITLE = /^\s*#\s+(.+?)\s*#*\s*$/;
const NAME_LINE = /^\s*(?:Stapel|Deck|Thema|Titel|Name)\s*[:：]\s*(.+)$/i;

const tidy = s => s.replace(/^\s*\n/, '').replace(/\s+$/, '').replace(/^\s+/, '');
// a label may be wrapped in ** … ** with the text after it: "**F:** text" → "text"
const after = (line, re) => line.replace(re, '').replace(/^\*\*\s*/, '');

function fromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const pick = (o, keys) => { for (const k of Object.keys(o)) if (keys.includes(k.toLowerCase())) return o[k]; };
  const FK = ['front', 'question', 'q', 'f', 'frage', 'vorderseite', 'term', 'begriff', 'prompt'];
  const BK = ['back', 'answer', 'a', 'antwort', 'rückseite', 'rueckseite', 'definition', 'lösung', 'loesung'];
  const list = Array.isArray(data) ? data : data && (pick(data, ['cards', 'karten', 'flashcards', 'karteikarten', 'items']) || []);
  const name = Array.isArray(data) ? '' : String(pick(data || {}, ['name', 'title', 'titel', 'deck', 'stapel']) || '');
  const cards = [];
  let skipped = 0;
  for (const x of Array.isArray(list) ? list : []) {
    const [f, b] = Array.isArray(x) ? x : x && typeof x === 'object' ? [pick(x, FK), pick(x, BK)] : [];
    if (f != null && b != null && String(f).trim() && String(b).trim()) cards.push({ front: String(f).trim(), back: String(b).trim() });
    else skipped++;
  }
  return { name: name.trim(), cards, skipped };
}

// Cards in one line each: "front<TAB>back", "front :: back", "front;back", "| front | back |"
function fromLines(lines) {
  const cards = [];
  let skipped = 0, name = '';
  const HEAD = /^(frage|vorderseite|front|question|begriff|term)$/i;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const t = TITLE.exec(line) || NAME_LINE.exec(line);
    if (t) { if (!name && !cards.length) name = t[1]; continue; }
    let parts = null;
    if (line.startsWith('|')) {
      const cells = line.replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue; // table rule
      if (HEAD.test(cells[0])) continue; // table header
      parts = cells;
    } else if (line.includes('\t')) parts = line.split('\t');
    else if (line.includes('::')) parts = line.split('::');
    else if (line.includes(';')) parts = line.split(';');
    parts = parts?.map(s => s.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"').replace(/<br\s*\/?>/gi, '\n'));
    if (parts && parts[0] && parts.slice(1).join(' ').trim()) cards.push({ front: parts[0], back: parts.slice(1).filter(Boolean).join('\n') });
    else skipped++;
  }
  return { name, cards, skipped };
}

export function parseCards(input) {
  let text = String(input || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // AI chats put the result in a code fence, with chat text around it: only the fenced part counts
  // (if it has cards); otherwise just the fence lines are dropped.
  const fenced = /^\s*(```|~~~)[^\n]*\n([\s\S]*?)\n\s*\1\s*$/m.exec(text);
  if (fenced && /^\s*\S/m.test(fenced[2]) && (fenced[2].split('\n').some(l => FRONT.test(l)) || /^\s*[[{]/.test(fenced[2]))) text = fenced[2];
  text = text.split('\n').filter(l => !/^\s*(```|~~~)/.test(l)).join('\n').trim();
  if (/^[[{]/.test(text)) { const j = fromJson(text); if (j) return j; }
  const lines = text.split('\n');
  if (!lines.some(l => FRONT.test(l)) || !lines.some(l => BACK.test(l))) return fromLines(lines);

  const cards = [];
  let name = '', cur = null, field = null, skipped = 0;
  const close = () => {
    if (cur) {
      const front = tidy(cur.front), back = tidy(cur.back ?? '');
      if (front && back) cards.push({ front, back }); else skipped++;
    }
    cur = null; field = null;
  };
  for (const line of lines) {
    if (FRONT.test(line)) { close(); cur = { front: after(line, FRONT), back: null }; field = 'front'; continue; }
    if (BACK.test(line) && cur && field === 'front') { cur.back = after(line, BACK); field = 'back'; continue; }
    if (SEP.test(line)) { close(); continue; }
    if (/^\s*#{1,6}\s/.test(line)) { // a heading: the deck name (first one) or a chapter; ends a card
      const t = TITLE.exec(line);
      if (t && !name && !cards.length && !cur) name = t[1].replace(/^(Stapel|Deck)\s*[:：]\s*/i, '');
      close(); continue;
    }
    if (!cur) { // text outside cards (introductions), maybe "Stapel: Name"
      const n = NAME_LINE.exec(line);
      if (n && !name && !cards.length) name = n[1].trim();
      continue;
    }
    cur[field] += '\n' + line;
  }
  close();
  return { name: name.trim(), cards, skipped };
}

// The deck as text in the same format (export; import gives the same cards back).
export function cardsToText(deck) {
  const out = [`# ${deck.name || 'Karteikarten'}`, ''];
  // handwriting has no text form: such a side is exported as "[Handschrift]"
  const side = (t, ink) => t || (ink?.strokes?.length ? '[Handschrift]' : '');
  for (const c of deck.cards || []) out.push('F: ' + side(c.front, c.frontInk), 'A: ' + side(c.back, c.backInk), '');
  return out.join('\n');
}

// Prompt for an AI (ChatGPT, Claude, Gemini …): the script goes below it.
export const AI_PROMPT = `Erstelle aus dem folgenden Skript Karteikarten zum Lernen. Gib nur die Karten aus, in einem Codeblock und genau in diesem Format:

# Name des Stapels

F: Frage oder Begriff
A: Antwort

F: nächste Frage
A: nächste Antwort

Regeln:
- Jede Karte beginnt mit „F:“ (Vorderseite) und danach „A:“ (Rückseite). Zwischen zwei Karten steht eine Leerzeile.
- Eine Karte prüft genau einen Fakt oder Zusammenhang. Lieber mehrere kleine Karten als eine große.
- Fragen eindeutig formulieren, sodass genau eine Antwort passt. Antworten kurz und präzise.
- Mehrzeilige Antworten sind erlaubt: in den nächsten Zeilen weiterschreiben, Aufzählungen mit „- “.
- Formeln in LaTeX: im Text zwischen $…$, abgesetzt zwischen $$…$$ (z. B. $E = mc^2$).
- Erlaubte Formatierung: **fett**, *kursiv*. Sonst keine.
- Decke alle prüfungsrelevanten Inhalte ab: Definitionen, Zusammenhänge, Formeln, Abläufe, Beispiele.
- Keine Nummerierung, keine Einleitung, keine Kommentare.

Skript:
`;

// ---------- Display ----------
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// $…$ needs a non-space after the opening and before the closing $, and no digit right after it
// (as Pandoc does), so "5 $ und 7 $" stays text.
const MATH = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=\S)((?:\\\$|[^$\n])+?)(?<=\S)\$(?!\d)/g;
export const hasMath = text => { MATH.lastIndex = 0; return MATH.test(text); };

let katex = null, katexLoading = null;
export function loadKatex() {
  if (katex) return Promise.resolve(katex);
  katexLoading ||= (async () => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
    document.head.append(css);
    katex = (await import('https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.mjs')).default;
    return katex;
  })().catch(e => { katexLoading = null; throw e; });
  return katexLoading;
}

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>');
}

// Card text → HTML (escaped; only the markup above is produced).
export function richHTML(text) {
  const math = [];
  MATH.lastIndex = 0;
  let s = String(text || '').replace(MATH, (m, d1, d2, i1, i2) => {
    const display = d1 != null || d2 != null;
    const tex = (d1 ?? d2 ?? i1 ?? i2).trim();
    let html;
    if (katex) html = katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
    else html = `<code class="fc-tex">${esc(tex)}</code>`;
    math.push(display ? `<div class="fc-math">${html}</div>` : html);
    return `\u0000${math.length - 1}\u0000`;
  });
  s = esc(s);
  // blocks: lists and paragraphs
  const out = [];
  let list = null;
  for (const line of s.split('\n')) {
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const tag = li[1] ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { list = { tag, items: [] }; out.push(list); }
      list.items.push(inline(li[2]));
      continue;
    }
    list = null;
    out.push(inline(line));
  }
  let html = '';
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (typeof b === 'object') html += `<${b.tag}>${b.items.map(x => `<li>${x}</li>`).join('')}</${b.tag}>`;
    else html += b + (i < out.length - 1 && typeof out[i + 1] !== 'object' ? '<br>' : '');
  }
  return html.replace(/\u0000(\d+)\u0000/g, (m, i) => math[+i]);
}

// Fills el with the card text; formulas are drawn as soon as KaTeX has loaded (offline before the
// first load: the LaTeX source is shown).
export function renderRich(el, text) {
  el.innerHTML = richHTML(text);
  if (!katex && hasMath(text)) loadKatex().then(() => { if (el.isConnected) el.innerHTML = richHTML(text); }).catch(() => {});
  return el;
}

// Plain text for lists and search
export const plainCard = text => String(text || '').replace(/\$\$?|\\[[\]()]|\*\*|`/g, '').replace(/\s+/g, ' ').trim();
