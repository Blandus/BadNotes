// Text documents (like Goodnotes' "Textdokument"): flowing rich text instead of pages.
//
// Stored in the model Goodnotes uses for them (Slate/Plate nodes), so .goodnotes import is
// a direct mapping, both ways:
//   record { kind: 'textdoc', id, name, parent, …, blocks: [node] }
//   element node { type, id, children: [node], …props }   text node { text, …marks }
//   types: title, h1–h3, p, blockquote, hr, img (src = data URL), table → tr → td (colSpan,
//   rowSpan, background) → blocks. Lists are paragraphs with listStyleType (disc, decimal,
//   todo), indent and checked (Plate's indent lists). Marks: bold, italic, underline,
//   strikethrough, code, color, backgroundColor. Unknown types, props and marks are kept.
// Editing happens in a contenteditable rendering of the nodes; every change is parsed back
// into nodes (debounced) and saved.
import { $, h, uid, debounce, pickFile } from './util.js';
import { icon } from './icons.js';
import { store, settings, saveSettings, bus } from './store.js';
import { menu, popover, closePopover, toast, promptText } from './ui.js';
import { loadImageFile } from './pdf.js';
import { renderLibrary } from './library.js';

// Yjs (CRDT library Goodnotes stores text documents with) — only needed for .goodnotes
// import, loaded on demand (the service worker keeps a copy for offline use).
export const loadYjs = () => import('https://cdn.jsdelivr.net/npm/yjs@13.6.18/+esm');

// Goodnotes-style ids: 10 characters
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
export const nodeId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), b => ALPHA[b & 63]).join('');
const block = (type, text = '', props = {}) => ({ type, id: nodeId(), ...props, children: [{ text }] });
export const emptyCell = () => ({ type: 'td', id: nodeId(), colSpan: 1, rowSpan: 1, children: [block('p')] });

export function newTextDoc({ name = 'Unbenanntes Textdokument', parent = null } = {}) {
  const now = Date.now();
  return {
    kind: 'textdoc', id: uid(), name, parent, created: now, updated: now, opened: now,
    blocks: [block('title'), block('p')],
  };
}

// ---------- Plain text (search, thumbnails, names) ----------
export function nodeText(n) {
  if (n.text !== undefined) return n.text;
  const sep = ['table', 'tr'].includes(n.type) ? ' ' : '';
  return (n.children || []).map(nodeText).join(sep);
}
export const plainText = r => (r.blocks || []).map(nodeText).join('\n');
export const titleOf = r => nodeText((r.blocks || []).find(b => b.type === 'title') || { text: '' }).trim();

// ---------- Library thumbnail: the first lines on a page ----------
export function renderTextThumb(canvas, r, width) {
  const w = width, hgt = Math.round(width * 1.294), s = w / 600;
  canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, hgt);
  let y = 60 * s;
  const font = (px, bold) => `${bold ? '700 ' : ''}${px * s}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  const wrap = (text, px, bold, color) => {
    ctx.font = font(px, bold); ctx.fillStyle = color;
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        if (ctx.measureText(line + word).width > w - 100 * s && line.trim()) { ctx.fillText(line, 50 * s, y); y += px * 1.35 * s; line = word.trimStart(); }
        else line += word;
        if (y > hgt) return;
      }
      ctx.fillText(line, 50 * s, y); y += px * 1.35 * s;
    }
  };
  const SIZE = { title: [40, true], h1: [32, true], h2: [27, true], h3: [23, true] };
  for (const b of r.blocks || []) {
    if (y > hgt) break;
    if (b.type === 'table') { ctx.strokeStyle = '#C9C9C9'; ctx.strokeRect(50 * s, y - 16 * s, w - 100 * s, 60 * s); y += 76 * s; continue; }
    if (b.type === 'img') { ctx.fillStyle = '#E6E6E6'; ctx.fillRect(50 * s, y - 16 * s, w - 100 * s, 140 * s); y += 156 * s; continue; }
    const t = nodeText(b);
    const [px, bold] = SIZE[b.type] || [18, false];
    if (b.type === 'title' && !t) { wrap('Titel', px, bold, '#B5B5B5'); continue; }
    wrap(t, px, bold, '#1A1A1A');
    y += 6 * s;
  }
}

// ---------- Nodes → DOM ----------
const BLOCK_TAG = { title: 'h1', h1: 'h2', h2: 'h3', h3: 'h4', p: 'p', blockquote: 'blockquote', code_block: 'pre' };
const TAG_TYPE = { H1: 'title', H2: 'h1', H3: 'h2', H4: 'h3', H5: 'h3', H6: 'h3', P: 'p', DIV: 'p', BLOCKQUOTE: 'blockquote', PRE: 'code_block', LI: 'p' };
const KNOWN_PROPS = new Set(['type', 'id', 'children', 'listStyleType', 'indent', 'checked', 'colSpan', 'rowSpan', 'background', 'src', 'url', 'align']);
const MARK_TAGS = [['bold', 'strong'], ['italic', 'em'], ['underline', 'u'], ['strikethrough', 's'], ['code', 'code']];

function setCommon(el, n) {
  el.dataset.type = n.type;
  el.dataset.id = n.id || nodeId();
  const extra = Object.fromEntries(Object.entries(n).filter(([k]) => !KNOWN_PROPS.has(k)));
  if (Object.keys(extra).length) el.dataset.props = JSON.stringify(extra);
  if (n.listStyleType) { el.dataset.list = n.listStyleType; el.style.setProperty('--indent', n.indent || 1); }
  if (n.checked) el.dataset.checked = '';
  if (n.align) el.style.textAlign = n.align;
  return el;
}

function renderLeaf(l) {
  let node = document.createTextNode(l.text);
  for (const [mark, tag] of MARK_TAGS) if (l[mark]) node = h(tag, {}, node);
  const style = {};
  if (l.color) style.color = l.color;
  if (l.backgroundColor) style.backgroundColor = l.backgroundColor;
  const extra = Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'text' && !['bold', 'italic', 'underline', 'strikethrough', 'code', 'color', 'backgroundColor'].includes(k)));
  if (Object.keys(style).length || Object.keys(extra).length) {
    node = h('span', { style, ...(Object.keys(extra).length ? { 'data-marks': JSON.stringify(extra) } : {}) }, node);
  }
  return node;
}

function renderInline(el, children) {
  for (const c of children || []) {
    if (c.text !== undefined) { if (c.text) el.append(renderLeaf(c)); }
    else el.append(renderNode(c)); // inline elements (links etc.) are rendered as spans
  }
  if (!el.textContent) el.append(h('br'));
  return el;
}

export function renderNode(n) {
  if (n.text !== undefined) return renderLeaf(n);
  switch (n.type) {
    case 'hr': return setCommon(h('hr', { contenteditable: 'false' }), n);
    case 'img': return setCommon(h('figure', { contenteditable: 'false' }, n.src ? h('img', { src: n.src, alt: '' }) : h('div', { class: 'td-img-missing' }, 'Bild')), n);
    case 'table': {
      const t = setCommon(h('table'), n);
      t.append(h('tbody', {}, (n.children || []).map(renderNode)));
      return t;
    }
    case 'tr': { const cells = (n.children || []).filter(c => c.type); return setCommon(h('tr', {}, (cells.length ? cells : [emptyCell()]).map(renderNode)), n); }
    case 'td': case 'th': {
      const c = setCommon(h(n.type, { colspan: n.colSpan > 1 ? n.colSpan : null, rowspan: n.rowSpan > 1 ? n.rowSpan : null, 'data-span': n.colSpan !== undefined || n.rowSpan !== undefined ? '' : null }), n);
      if (n.background) c.style.background = n.background;
      for (const k of n.children || []) c.append(k.text !== undefined ? renderInline(h('p', { 'data-type': 'p', 'data-id': nodeId() }), [k]) : renderNode(k));
      if (!c.children.length) c.append(renderNode(block('p')));
      return c;
    }
  }
  if (BLOCK_TAG[n.type]) return renderInline(setCommon(h(BLOCK_TAG[n.type]), n), n.children);
  // unknown: keep as a generic block with its children
  const el = setCommon(h('div', { class: 'td-unknown' }), n);
  return (n.children || []).every(c => c.text !== undefined) ? renderInline(el, n.children) : (el.append(...n.children.map(renderNode)), el);
}

// ---------- DOM → nodes ----------
const VOID = new Set(['hr', 'img']);
const isBlockEl = el => el.nodeType === 1 && (TAG_TYPE[el.tagName] || ['HR', 'FIGURE', 'TABLE', 'UL', 'OL'].includes(el.tagName) || el.dataset?.type);

function marksOf(el, marks) {
  const m = { ...marks };
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') m.bold = true;
  if (tag === 'I' || tag === 'EM') m.italic = true;
  if (tag === 'U') m.underline = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') m.strikethrough = true;
  if (tag === 'CODE') m.code = true;
  if (tag === 'FONT' && el.getAttribute('color')) m.color = el.getAttribute('color');
  if (el.style?.color) m.color = el.style.color;
  if (el.style?.backgroundColor && el.style.backgroundColor !== 'transparent') m.backgroundColor = el.style.backgroundColor;
  if (el.style?.fontWeight === 'bold' || +el.style?.fontWeight >= 600) m.bold = true;
  if (el.style?.fontStyle === 'italic') m.italic = true;
  if (el.dataset?.marks) try { Object.assign(m, JSON.parse(el.dataset.marks)); } catch {}
  return m;
}

function inlineLeaves(node, marks, out) {
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { if (c.data) out.push({ text: c.data.replace(/​/g, ''), ...marks }); }
    else if (c.nodeType === 1) {
      // a <br> at the very end of a block is the browser's placeholder for an empty last line
      if (c.tagName === 'BR') { if (c !== node.lastChild) out.push({ text: '\n', ...marks }); }
      else if (isBlockEl(c)) { if (out.length) out.push({ text: '\n', ...marks }); inlineLeaves(c, marks, out); }
      else inlineLeaves(c, marksOf(c, marks), out);
    }
  }
  return out;
}
const sameMarks = (a, b) => { const ka = Object.keys(a).filter(k => k !== 'text'), kb = Object.keys(b).filter(k => k !== 'text'); return ka.length === kb.length && ka.every(k => a[k] === b[k]); };
function mergeLeaves(leaves) {
  const out = [];
  for (const l of leaves) {
    const last = out[out.length - 1];
    if (last && sameMarks(last, l)) last.text += l.text; else out.push({ ...l });
  }
  const kept = out.filter(l => l.text);
  return kept.length ? kept : [{ text: '' }];
}

function propsOf(el, seen) {
  let id = el.dataset.id;
  if (!id || seen.has(id)) id = nodeId(); // the browser copies attributes when it splits a block
  seen.add(id);
  const n = { type: el.dataset.type, id };
  if (el.dataset.props) try { Object.assign(n, JSON.parse(el.dataset.props)); } catch {}
  if (el.dataset.list) { n.listStyleType = el.dataset.list; n.indent = +el.style.getPropertyValue('--indent') || 1; if (el.dataset.list === 'todo') n.checked = el.hasAttribute('data-checked'); }
  if (el.style.textAlign) n.align = el.style.textAlign;
  return n;
}

function parseBlock(el, seen) {
  const tag = el.tagName;
  if (tag === 'HR') return { ...propsOf(el, seen), type: 'hr', children: [{ text: '' }] };
  if (tag === 'FIGURE') {
    const n = { ...propsOf(el, seen), type: 'img', children: [{ text: '' }] };
    const img = el.querySelector('img');
    if (img) n.src = img.getAttribute('src');
    return n;
  }
  if (tag === 'TABLE') {
    const rows = [...el.rows].map(tr => ({
      ...propsOf(tr, seen), type: 'tr',
      children: !tr.cells.length ? [emptyCell()] : [...tr.cells].map(td => {
        const c = { ...propsOf(td, seen), type: td.tagName === 'TH' ? 'th' : 'td' };
        if (td.hasAttribute('data-span') || td.colSpan > 1 || td.rowSpan > 1) Object.assign(c, { colSpan: td.colSpan || 1, rowSpan: td.rowSpan || 1 }); // written only if the node had them
        if (td.style.background || td.style.backgroundColor) c.background = td.style.backgroundColor || td.style.background;
        c.children = parseBlocks(td, seen);
        return c;
      }),
    }));
    return { ...propsOf(el, seen), type: 'table', children: rows.length ? rows : [{ type: 'tr', id: nodeId(), children: [emptyCell()] }] };
  }
  if (tag === 'UL' || tag === 'OL') { // pasted lists
    return [...el.children].map(li => ({ ...propsOf(li, seen), type: 'p', listStyleType: tag === 'OL' ? 'decimal' : 'disc', indent: 1, children: mergeLeaves(inlineLeaves(li, {}, [])) }));
  }
  const n = propsOf(el, seen);
  if (!n.type || n.type === 'img' || n.type === 'hr') n.type = TAG_TYPE[tag] || 'p';
  if (el.classList.contains('td-unknown') && [...el.children].some(isBlockEl)) n.children = parseBlocks(el, seen);
  else n.children = mergeLeaves(inlineLeaves(el, {}, []));
  return n;
}

export function parseBlocks(container, seen = new Set()) {
  const out = [];
  let loose = [];
  const flush = () => {
    if (!loose.length) return;
    const tmp = h('p'); loose.forEach(n => tmp.append(n.cloneNode(true)));
    if (tmp.textContent.trim()) out.push({ type: 'p', id: nodeId(), children: mergeLeaves(inlineLeaves(tmp, {}, [])) });
    loose = [];
  };
  for (const c of container.childNodes) {
    if (c.nodeType === 1 && isBlockEl(c)) { flush(); const n = parseBlock(c, seen); Array.isArray(n) ? out.push(...n) : out.push(n); }
    else if (c.nodeType === 1 || (c.nodeType === 3 && c.data.trim())) loose.push(c);
  }
  flush();
  return out.length ? out : [block('p')];
}

// ---------- Editor ----------
const td = { doc: null, el: null, content: null, dirty: false, range: null };
export const textLocked = id => td.doc?.id === id && td.dirty;
const view = () => $('#textdoc');

export async function openTextDoc(id) {
  const doc = await store.get(id);
  if (!doc || doc.deleted || doc.trashed) {
    settings.openText = null; saveSettings();
    if ($('#library').hidden && $('#editor').hidden) { $('#library').hidden = false; renderLibrary(); }
    return toast('Dokument nicht gefunden');
  }
  doc.opened = Date.now();
  store.put(doc);
  td.doc = doc;
  settings.openText = id; saveSettings();
  $('#library').hidden = true; $('#editor').hidden = true;
  build();
  view().hidden = false;
  const first = td.content.querySelector('[data-type="title"]');
  if (first && !first.textContent) placeCaret(first);
}

export async function closeTextDoc() {
  await saveNow();
  td.doc = null; settings.openText = null; saveSettings();
  view().hidden = true;
  $('#library').hidden = false;
  renderLibrary();
}

const save = debounce(() => saveNow(), 500);
async function saveNow() {
  if (!td.doc || !td.dirty) return;
  td.dirty = false;
  td.doc.blocks = parseBlocks(td.content);
  const title = titleOf(td.doc);
  if (title) td.doc.name = title;
  td.doc.updated = Date.now();
  $('#tdTitle').textContent = td.doc.name;
  await store.put(td.doc);
}
const changed = () => { td.dirty = true; markEmpty(); save(); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

// Placeholders for an empty title / first paragraph
function markEmpty() {
  for (const el of td.content.querySelectorAll('[data-empty]')) el.removeAttribute('data-empty');
  const title = td.content.querySelector(':scope > [data-type="title"]');
  if (title && !title.textContent) title.dataset.empty = 'Titel';
  const blocks = [...td.content.children];
  if (blocks.length <= 2) { const p = blocks.find(b => b.dataset.type === 'p'); if (p && !p.textContent) p.dataset.empty = 'Hier schreiben…'; }
}

// Remote (sync) update of the open document: re-render unless it is being edited right now
bus.addEventListener('remote', async e => {
  if (!td.doc || e.detail !== td.doc.id || td.dirty) return;
  const doc = await store.get(td.doc.id);
  if (!doc || doc.deleted || doc.trashed) return closeTextDoc();
  td.doc = doc;
  if (document.activeElement !== td.content) { td.content.replaceChildren(...doc.blocks.map(renderNode)); markEmpty(); }
});

function build() {
  const v = view();
  td.content = h('div', { class: 'td-content', contenteditable: 'true', spellcheck: 'true' }, td.doc.blocks.map(renderNode));
  td.content.addEventListener('input', changed);
  td.content.addEventListener('keydown', onKey);
  td.content.addEventListener('pointerdown', onPointer);
  td.content.addEventListener('paste', onPaste);
  document.execCommand('defaultParagraphSeparator', false, 'p');
  const bar = h('div', { class: 'toolbar' },
    h('div', { class: 'tb-group' },
      h('button', { class: 'barbtn', title: 'Bibliothek', onclick: closeTextDoc }, icon('home', 22)),
      h('button', { class: 'doc-title', title: 'Umbenennen', onclick: renameDoc }, h('span', { id: 'tdTitle' }, td.doc.name))),
    h('div', { class: 'tb-group right' },
      h('button', { class: 'barbtn', title: 'Teilen', onclick: e => shareMenu(e.currentTarget) }, icon('share', 22))));
  v.replaceChildren(bar,
    h('div', { class: 'td-stage' },
      formatBar(),
      h('div', { class: 'td-scroll' }, h('div', { class: 'td-page' }, td.content))));
  markEmpty();
  updateBar();
}

async function renameDoc() {
  const name = await promptText('Umbenennen', td.doc.name);
  if (!name) return;
  let title = td.content.querySelector(':scope > [data-type="title"]');
  if (!title) { title = renderNode(block('title')); td.content.prepend(title); }
  title.replaceChildren(document.createTextNode(name));
  td.dirty = true; await saveNow(); markEmpty();
}

function shareMenu(anchor) {
  menu(anchor, [
    { label: 'Als PDF (Drucken)', icon: 'pdf', action: printDoc },
    { label: 'Als Goodnotes-Datei (Beta)', icon: 'doc', action: async () => { await saveNow(); (await import('./goodnotes-export.js')).exportGoodnotes(td.doc); } },
  ]);
}

// PDF: the system print dialog ("Als PDF sichern" on iPad / "Microsoft Print to PDF" on PC)
export async function printDoc(doc) {
  const r = doc?.blocks ? doc : td.doc;
  const host = h('div', { class: 'td-print' }, h('div', { class: 'td-content' }, r.blocks.map(renderNode)));
  document.body.append(host);
  document.body.classList.add('printing-text');
  const done = () => { host.remove(); document.body.classList.remove('printing-text'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  await Promise.all([...host.querySelectorAll('img')].map(i => i.decode?.().catch(() => {})));
  print();
  setTimeout(done, 1000); // Safari may not fire afterprint
}

// ---------- Selection helpers ----------
const TEXT_BLOCKS = 'h1,h2,h3,h4,p,blockquote,pre,div.td-unknown';
function blockOf(node) {
  for (let n = node?.nodeType === 3 ? node.parentNode : node; n && n !== td.content; n = n.parentNode) {
    if (n.matches?.(TEXT_BLOCKS) && (n.parentNode === td.content || n.parentNode.matches?.('td,th'))) return n;
  }
  return null;
}
function selectedBlocks() {
  const sel = getSelection();
  if (!sel.rangeCount || !td.content.contains(sel.anchorNode)) return [];
  const r = sel.getRangeAt(0);
  const a = blockOf(r.startContainer), b = blockOf(r.endContainer);
  if (!a) return [];
  const all = [...td.content.querySelectorAll(TEXT_BLOCKS)].filter(el => blockOf(el) === el);
  const i = all.indexOf(a), j = b ? all.indexOf(b) : i;
  return all.slice(i, Math.max(i, j) + 1);
}
function placeCaret(el, atEnd = false) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(!atEnd);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  td.content.focus();
}
// Text offset of a boundary inside a block, and back (block elements get replaced)
function offsetIn(blockEl, node, off) {
  const r = document.createRange(); r.selectNodeContents(blockEl);
  try { r.setEnd(node, off); } catch { return 0; }
  return r.toString().length;
}
function pointAt(blockEl, off) {
  const w = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
  let n, left = off;
  while ((n = w.nextNode())) { if (left <= n.data.length) return [n, left]; left -= n.data.length; }
  return [blockEl, blockEl.childNodes.length];
}
function saveRange() {
  const sel = getSelection();
  if (sel.rangeCount && td.content.contains(sel.anchorNode)) td.range = sel.getRangeAt(0).cloneRange();
}
// Only needed when the focus went elsewhere (menus); otherwise the live selection is right.
function restoreRange() {
  const sel = getSelection();
  if (document.activeElement === td.content && sel.rangeCount && td.content.contains(sel.anchorNode)) return;
  if (!td.range) return;
  const s = getSelection(); s.removeAllRanges(); s.addRange(td.range);
  td.content.focus();
}

// ---------- Commands ----------
const STYLES = [['title', 'Titel'], ['h1', 'Überschrift 1'], ['h2', 'Überschrift 2'], ['h3', 'Überschrift 3'], ['p', 'Text'], ['blockquote', 'Zitat']];

function setBlockType(type) {
  restoreRange();
  const blocks = selectedBlocks();
  if (!blocks.length) return;
  const sel = getSelection(), r = sel.getRangeAt(0);
  const sb = blockOf(r.startContainer), eb = blockOf(r.endContainer);
  const so = offsetIn(sb, r.startContainer, r.startOffset), eo = eb ? offsetIn(eb, r.endContainer, r.endOffset) : so;
  let newStart = null, newEnd = null;
  for (const b of blocks) {
    const n = document.createElement(BLOCK_TAG[type]);
    for (const a of b.attributes) n.setAttribute(a.name, a.value);
    n.dataset.type = type;
    if (type !== 'p') { delete n.dataset.list; delete n.dataset.checked; n.style.removeProperty('--indent'); }
    n.append(...b.childNodes);
    b.replaceWith(n);
    if (b === sb) newStart = n;
    if (b === eb) newEnd = n;
  }
  if (newStart) {
    const nr = document.createRange();
    nr.setStart(...pointAt(newStart, so)); nr.setEnd(...pointAt(newEnd || newStart, eo));
    sel.removeAllRanges(); sel.addRange(nr);
  }
  changed(); updateBar();
}

function toggleList(kind) {
  restoreRange();
  const blocks = selectedBlocks();
  if (!blocks.length) return;
  const on = blocks.every(b => b.dataset.list === kind);
  for (const b of blocks) {
    if (b.dataset.type !== 'p') { const p = document.createElement('p'); for (const a of b.attributes) p.setAttribute(a.name, a.value); p.dataset.type = 'p'; p.append(...b.childNodes); b.replaceWith(p); blocks[blocks.indexOf(b)] = p; }
  }
  for (const b of blocks) {
    if (on) { delete b.dataset.list; delete b.dataset.checked; b.style.removeProperty('--indent'); }
    else { b.dataset.list = kind; if (!b.style.getPropertyValue('--indent')) b.style.setProperty('--indent', 1); if (kind !== 'todo') delete b.dataset.checked; }
  }
  placeCaret(blocks[blocks.length - 1], true);
  changed(); updateBar();
}

function indent(delta) {
  const blocks = selectedBlocks().filter(b => b.dataset.list);
  for (const b of blocks) b.style.setProperty('--indent', Math.max(1, Math.min(6, (+b.style.getPropertyValue('--indent') || 1) + delta)));
  if (blocks.length) changed();
  return blocks.length > 0;
}

function exec(cmd, value) {
  restoreRange();
  const css = cmd === 'foreColor' || cmd === 'hiliteColor';
  if (css) document.execCommand('styleWithCSS', false, true);
  document.execCommand(cmd, false, value);
  if (css) document.execCommand('styleWithCSS', false, false);
  changed(); updateBar();
}

function currentBlockForInsert() {
  restoreRange();
  let b = selectedBlocks().pop();
  // inside a table: insert after the table
  const cell = b?.closest('td,th');
  if (cell) b = cell.closest('table');
  return b || td.content.lastElementChild;
}
function insertAfter(ref, ...nodes) {
  if (ref && ref.parentNode === td.content) ref.after(...nodes); else td.content.append(...nodes);
}
function insertBlock(node) {
  const ref = currentBlockForInsert();
  const el = renderNode(node);
  const after = renderNode(block('p'));
  // replace an empty paragraph instead of leaving it above
  if (ref && ref.dataset.type === 'p' && !ref.textContent && !ref.dataset.list && ref.parentNode === td.content) ref.replaceWith(el);
  else insertAfter(ref, el);
  if (!el.nextElementSibling || el.nextElementSibling.tagName === 'TABLE' || el.nextElementSibling.tagName === 'FIGURE' || el.nextElementSibling.tagName === 'HR') el.after(after);
  changed();
  return el;
}

function insertTable(rows = 3, cols = 3) {
  const t = insertBlock({ type: 'table', id: nodeId(), children: Array.from({ length: rows }, () => ({ type: 'tr', id: nodeId(), children: Array.from({ length: cols }, emptyCell) })) });
  placeCaret(t.querySelector('td p'));
  updateBar();
}
async function insertImage() {
  saveRange();
  const f = await pickFile('image/*');
  if (!f) return;
  const img = await loadImageFile(f, 2000);
  insertBlock({ type: 'img', id: nodeId(), src: img.src, children: [{ text: '' }] });
}

// table editing
function cellCtx() {
  restoreRange();
  const sel = getSelection();
  const cell = sel.anchorNode && (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode).closest?.('td,th');
  return cell && td.content.contains(cell) ? { cell, row: cell.parentNode, table: cell.closest('table') } : null;
}
const newCellEl = () => renderNode(emptyCell());
function tableOp(op) {
  const c = cellCtx();
  if (!c) return;
  const { cell, row, table } = c, ci = cell.cellIndex;
  if (op === 'rowAdd') { const r = renderNode({ type: 'tr', id: nodeId(), children: [] }); for (let i = 0; i < row.cells.length; i++) r.append(newCellEl()); row.after(r); placeCaret(r.cells[ci] || r.cells[0]); }
  if (op === 'colAdd') { for (const r of table.rows) { const ref = r.cells[Math.min(ci, r.cells.length - 1)]; ref ? ref.after(newCellEl()) : r.append(newCellEl()); } }
  if (op === 'rowDel') { if (table.rows.length > 1) row.remove(); else table.remove(); }
  if (op === 'colDel') { if (row.cells.length > 1) for (const r of table.rows) r.cells[Math.min(ci, r.cells.length - 1)]?.remove(); else table.remove(); }
  if (op === 'del') table.remove();
  if (!td.content.children.length) td.content.append(renderNode(block('p')));
  changed(); updateBar();
}

// ---------- Events ----------
function onKey(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    if (indent(e.shiftKey ? -1 : 1)) return;
    const c = cellCtx();
    if (c) { // next / previous cell
      const cells = [...c.table.querySelectorAll('td,th')], i = cells.indexOf(c.cell);
      const next = cells[i + (e.shiftKey ? -1 : 1)];
      if (next) placeCaret(next.querySelector(TEXT_BLOCKS) || next, true);
      else if (!e.shiftKey) { tableOp('rowAdd'); }
    }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    // Enter in an empty list item ends the list (as in Goodnotes / most editors)
    const b = selectedBlocks()[0];
    if (b?.dataset.list && !b.textContent) { e.preventDefault(); delete b.dataset.list; delete b.dataset.checked; b.style.removeProperty('--indent'); changed(); updateBar(); return; }
    // Enter at the end of the title / a heading continues with normal text
    if (b && ['title', 'h1', 'h2', 'h3'].includes(b.dataset.type)) {
      const s = getSelection();
      if (s.isCollapsed && offsetIn(b, s.anchorNode, s.anchorOffset) === b.textContent.length) {
        e.preventDefault();
        const p = renderNode(block('p'));
        b.after(p); placeCaret(p); changed(); updateBar();
      }
    }
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); exec('bold'); }
    else if (k === 'i') { e.preventDefault(); exec('italic'); }
    else if (k === 'u') { e.preventDefault(); exec('underline'); }
    else if (k === 's') { e.preventDefault(); saveNow(); }
  }
}

// Tapping the box of a checklist item ticks it
function onPointer(e) {
  const p = e.target.closest?.('[data-list="todo"]');
  if (!p) return;
  const r = p.getBoundingClientRect(), pad = parseFloat(getComputedStyle(p).paddingLeft);
  if (e.clientX < r.left + pad) {
    e.preventDefault();
    p.toggleAttribute('data-checked');
    changed();
  }
}

// Paste: keep text, line breaks and simple formatting; images are inserted as image blocks
function onPaste(e) {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    saveRange();
    (async () => { for (const f of files) { const img = await loadImageFile(f, 2000); insertBlock({ type: 'img', id: nodeId(), src: img.src, children: [{ text: '' }] }); } })();
    return;
  }
  const html = e.clipboardData?.getData('text/html');
  if (!html) return; // plain text: the browser inserts it
  e.preventDefault();
  const tmp = h('div', { html });
  tmp.querySelectorAll('script,style,meta,link').forEach(n => n.remove());
  const nodes = parseBlocks(tmp);
  // single paragraph → insert inline at the caret; otherwise as blocks after the current one
  if (nodes.length === 1 && nodes[0].type === 'p') document.execCommand('insertText', false, nodeText(nodes[0]));
  else { let ref = currentBlockForInsert(); for (const n of nodes) { const el = renderNode(n); insertAfter(ref, el); ref = el; } changed(); }
}

// ---------- Format bar ----------
let barEls = null;
function fbtn(title, content, onclick, extra = {}) {
  // mousedown would move the focus out of the text (and lose the selection)
  return h('button', { class: 'iconbtn td-fbtn', title, onpointerdown: e => { e.preventDefault(); saveRange(); }, onclick, ...extra }, content);
}
const COLORS = [['Standard', null], ['Grau', '#6E6E73'], ['Rot', '#D12F2F'], ['Orange', '#E8730C'], ['Grün', '#1F8A4C'], ['Blau', '#1F4FD1'], ['Lila', '#8E3FD1']];
const MARKS = [['Keine', null], ['Gelb', '#FFF3A3'], ['Grün', '#CCFBDA'], ['Blau', '#D6EBFF'], ['Rosa', '#FFD6E8'], ['Orange', '#FFE2C2']];

function formatBar() {
  const style = h('button', { class: 'opt-drop td-style', onpointerdown: e => { e.preventDefault(); saveRange(); }, onclick: e => styleMenu(e.currentTarget) }, h('span', {}, 'Text'), icon('chevronDown', 14));
  const B = fbtn('Fett (Strg+B)', h('b', {}, 'B'), () => exec('bold'));
  const I = fbtn('Kursiv (Strg+I)', h('i', {}, 'I'), () => exec('italic'));
  const U = fbtn('Unterstrichen (Strg+U)', h('u', {}, 'U'), () => exec('underline'));
  const S = fbtn('Durchgestrichen', h('s', {}, 'S'), () => exec('strikeThrough'));
  const color = fbtn('Textfarbe', h('span', { class: 'td-color-a' }, 'A'), e => colorMenu(e.currentTarget, COLORS, c => exec('foreColor', c || '#1A1A1A')));
  const mark = fbtn('Markieren', icon('highlighter', 20), e => colorMenu(e.currentTarget, MARKS, c => exec('hiliteColor', c || 'transparent')));
  const ul = fbtn('Aufzählung', h('span', { class: 'td-glyph' }, '•≡'), () => toggleList('disc'));
  const ol = fbtn('Nummerierung', h('span', { class: 'td-glyph' }, '1.'), () => toggleList('decimal'));
  const todo = fbtn('Checkliste', icon('check', 20), () => toggleList('todo'));
  const table = fbtn('Tabelle', h('span', { class: 'td-glyph' }, '▦'), () => insertTable());
  const image = fbtn('Bild', icon('image', 20), insertImage);
  const hr = fbtn('Trennlinie', icon('minus', 20), () => { insertBlock({ type: 'hr', id: nodeId(), children: [{ text: '' }] }); });
  const undo = fbtn('Rückgängig', icon('undo', 20), () => exec('undo'));
  const redo = fbtn('Wiederholen', icon('redo', 20), () => exec('redo'));
  const tableTools = h('div', { class: 'opt-group td-table-tools', hidden: true },
    h('div', { class: 'opt-sep' }),
    fbtn('Zeile darunter einfügen', h('span', { class: 'td-chip' }, '+ Zeile'), () => tableOp('rowAdd')),
    fbtn('Spalte rechts einfügen', h('span', { class: 'td-chip' }, '+ Spalte'), () => tableOp('colAdd')),
    fbtn('Zeile löschen', h('span', { class: 'td-chip' }, '− Zeile'), () => tableOp('rowDel')),
    fbtn('Spalte löschen', h('span', { class: 'td-chip' }, '− Spalte'), () => tableOp('colDel')),
    fbtn('Tabelle löschen', icon('trash', 18), () => tableOp('del')));
  barEls = { style, B, I, U, S, ul, ol, todo, tableTools };
  return h('div', { class: 'opt-pill td-format' }, h('div', { class: 'opt-inner' },
    undo, redo, h('div', { class: 'opt-sep' }), style, h('div', { class: 'opt-sep' }), B, I, U, S, color, mark,
    h('div', { class: 'opt-sep' }), ul, ol, todo, h('div', { class: 'opt-sep' }), table, image, hr, tableTools));
}

function styleMenu(anchor) {
  const cur = selectedBlocks()[0]?.dataset.type;
  menu(anchor, STYLES.map(([t, label]) => ({ label, checked: cur === t, action: () => setBlockType(t) })), { className: 'td-style-menu' });
}
function colorMenu(anchor, list, apply) {
  menu(anchor, list.map(([label, c]) => ({ label, swatch: c || 'transparent', action: () => apply(c) })));
}

function updateBar() {
  if (!barEls || !td.content) return;
  const b = selectedBlocks()[0];
  barEls.style.firstChild.textContent = (STYLES.find(([t]) => t === b?.dataset.type) || [, b ? 'Text' : 'Stil'])[1];
  const q = c => { try { return document.queryCommandState(c); } catch { return false; } };
  const inText = !!b;
  barEls.B.classList.toggle('on', inText && q('bold'));
  barEls.I.classList.toggle('on', inText && q('italic'));
  barEls.U.classList.toggle('on', inText && q('underline'));
  barEls.S.classList.toggle('on', inText && q('strikeThrough'));
  barEls.ul.classList.toggle('on', b?.dataset.list === 'disc');
  barEls.ol.classList.toggle('on', b?.dataset.list === 'decimal');
  barEls.todo.classList.toggle('on', b?.dataset.list === 'todo');
  barEls.tableTools.hidden = !b?.closest('td,th');
}
document.addEventListener('selectionchange', () => { if (td.doc && !view().hidden) { saveRange(); updateBar(); } });
