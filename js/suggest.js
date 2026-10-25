// Name suggestions for a notebook, based on its content: headings in text boxes, the title
// of an imported PDF, and the most frequent meaningful words. Handwriting can't be used —
// browsers offer no handwriting recognition.
import { textLines } from './render.js';

const STOP = new Set(`aber alle allem allen aller alles also auch auf aus bei beim bin bis bist dann das dass dein deine dem den der des dessen die dies diese diesem diesen dieser dieses doch dort durch ein eine einem einen einer eines einfach etwa euch für gegen hab habe haben hat hatte hier hin hinter ich ihr ihre im in ins ist ja jede jedem jeden jeder jedes jetzt kann kein keine können man mehr mein meine mit muss nach nicht nichts noch nun nur ob oder ohne sehr sein seine sich sie sind so soll sollen sondern über um und uns unser unter vom von vor war waren was weil wenn werden wie wieder wir wird wo zu zum zur zwischen seite seiten kapitel abbildung tabelle siehe beispiel the and for with from this that are was were have has not you your which page also than then these those into over such`.split(/\s+/));

const clean = s => s.replace(/\s+/g, ' ').replace(/^[\s\-–•·:.,;]+|[\s\-–•·:.,;]+$/g, '').trim();
const cap = s => s.length > 60 ? s.slice(0, 57).replace(/\s+\S*$/, '') + '…' : s;

export function suggestNames(doc) {
  const out = [];
  const add = s => {
    s = cap(clean(s || ''));
    if (s.length >= 3 && s.length <= 60 && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s);
  };
  const pages = doc.pages || [];

  // 1) Headings: biggest text box on the first pages (ties: higher up first)
  const texts = pages.slice(0, 3).flatMap((p, pi) => p.elements.filter(e => e.type === 'text' && e.text.trim()).map(e => ({ e, pi })));
  texts.sort((a, b) => b.e.size - a.e.size || a.pi - b.pi || a.e.y - b.e.y);
  if (texts[0]) add(textLines(texts[0].e).find(l => l.trim()) || texts[0].e.text);

  // 2) Imported PDF: title from the document, or the largest line on page 1
  add(pages[0]?.pdfMetaTitle);
  add(pages[0]?.pdfTitle);

  // 3) Topic from the most frequent words across all text
  const words = pages.flatMap(p => [p.pdfText || '', ...p.elements.filter(e => e.type === 'text').map(e => e.text)])
    .join(' ').match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) || [];
  const count = new Map(), shown = new Map();
  for (const w of words) {
    const k = w.toLowerCase();
    if (STOP.has(k) || /^\d/.test(k)) continue;
    count.set(k, (count.get(k) || 0) + 1);
    // prefer the capitalised spelling (German nouns)
    if (!shown.has(k) || /^\p{Lu}/u.test(w)) shown.set(k, w);
  }
  const top = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => shown.get(k));
  if (top.length) add(top.join(' – '));

  // 4) Fallback: the date it was created
  add(`Notizen vom ${new Date(doc.created || Date.now()).toLocaleDateString('de-DE')}`);
  return out.slice(0, 4);
}
