// "Seite hinzufügen": position (before / after / last), quick templates, and more ways to add pages
// (template window, image, document scan, photo, import). The template window has a cover and a
// paper tab, size and colour, and every template can be picked directly in each paper colour.
import { h, uid, pickFile } from './util.js';
import { icon } from './icons.js';
import { settings, saveSettings, newPage, TEMPLATES, TEMPLATE_SECTIONS, PAPERS, COVERS, PAGE_W } from './store.js';
import { renderThumb, renderCover, pageH } from './render.js';
import { popover, closePopover, menu, segmented, toast } from './ui.js';
import { loadImageFile, pdfToPages } from './pdf.js';

const COVER_NAMES = ['Ink Navy', 'Tiefblau', 'Mist Blue', 'Sage Green', 'Tannengrün', 'Schiefer', 'Warm Stone', 'Sand', 'Ocker', 'Pflaume', 'Graphit', 'Soft Ivory'];
// Paper sizes in mm (portrait). Only the aspect ratio shapes the page (pages are 1000 units wide),
// so A3–A6 give the same page shape; A7 and the others differ slightly.
const SIZES = {
  standard: ['Standard', [216, 280]], a3: ['A3', [297, 420]], a4: ['A4', [210, 297]], a5: ['A5', [148, 210]], a6: ['A6', [105, 148]],
  a7: ['A7 (iPhone)', [74, 105]], letter: ['Letter-Format', [216, 279]], tabloid: ['Tabloid-Format', [279, 432]],
};
const PAPER_ORDER = ['yellow', 'white', 'dark'];
const PAPER_NAMES = { white: 'Weiß', yellow: 'Gelb', dark: 'Dunkel' };
const dimsOf = o => (o.size === 'custom' ? o.custom : SIZES[o.size][1]);
const heightOf = o => { const [w, hh] = dimsOf(o); return Math.round(o.orient === 'landscape' ? PAGE_W * w / hh : PAGE_W * hh / w); };

// ctx: { doc, cur (index), insert(pages, at) }
export function addPageMenu(anchor, ctx) {
  const cur = ctx.doc.pages[ctx.cur];
  let where = settings.addWhere || 'after';
  const at = () => (where === 'before' ? ctx.cur : where === 'after' ? ctx.cur + 1 : ctx.doc.pages.length);
  const add = pages => { closePopover(); if (pages?.length) ctx.insert(pages, at()); };
  // "current template": same paper, size and template as this page (a PDF page → blank page of its size)
  const h0 = pageH(cur);
  const curTemplate = (cur?.bg || cur?.pdf) ? 'blank' : cur?.template || 'blank';
  const quick = [
    ['Aktuelle Vorlage', () => newPage(curTemplate, h0, cur?.paper)],
    ['Leer', () => newPage('blank', h0, (cur?.bg || cur?.pdf) ? undefined : cur?.paper)],
    ['Liniert schmal', () => newPage('narrow', h0, (cur?.bg || cur?.pdf) ? undefined : cur?.paper)],
  ];
  const tile = ([label, make]) => {
    const cv = h('canvas'); renderThumb(cv, make(), 200);
    return h('button', { class: 'ap-tile', onclick: () => add([make()]) }, h('div', { class: 'ap-tile-art' }, cv), h('span', {}, label));
  };
  const row = (ic, label, action) => h('button', { class: 'ap-row', onclick: action }, icon(ic, 22), h('span', {}, label));
  const run = fn => async () => {
    closePopover();
    try { const pages = await fn(); if (pages?.length) ctx.insert(pages, at()); }
    catch (err) { toast('Hinzufügen fehlgeschlagen: ' + err.message, 5000); }
  };
  const body = h('div', { class: 'addpage2' },
    h('div', { class: 'ap-title' }, 'Seite hinzufügen'),
    segmented([['before', 'Vor dieser'], ['after', 'Nach dieser'], ['end', 'Letzte Seite']], where, v => { where = v; settings.addWhere = v; saveSettings(); }),
    h('div', { class: 'ap-head' }, 'Neue Vorlagen'),
    h('div', { class: 'ap-hint' }, 'Die hier gezeigten Vorlagen übernehmen wenn möglich die Eigenschaften der aktuellen Seite.'),
    h('div', { class: 'ap-tiles' }, quick.map(tile)),
    h('div', { class: 'ap-list' },
      row('doc', 'Mehr Vorlagen …', () => { closePopover(); templateWindow(ctx, cur, pages => ctx.insert(pages, at())); }),
      row('image', 'Bild', run(imagePages)),
      row('scan', 'Dokumente scannen', run(() => cameraPages(true))),
      row('camera', 'Foto aufnehmen', run(() => cameraPages(false))),
      row('download', 'Importieren', run(importPages))));
  const p = popover(anchor, body, { className: 'addpage-pop' });
  body.querySelector('.segmented').classList.add('ap-seg');
  return p;
}

// ---------- Page sources ----------
async function imagePage(file, scan = false) {
  const img = await loadImageFile(file, 2000);
  const src = scan ? await scanFilter(img.src) : img.src;
  return { ...newPage('blank', Math.round(PAGE_W * img.h / img.w)), bg: src };
}
async function imagePages() {
  const f = await pickFile('image/*');
  return f ? [await imagePage(f)] : null;
}
// Camera (iPad/phone); on a PC the browser shows a file picker instead.
function pickCamera() {
  return new Promise(res => {
    const i = h('input', { type: 'file', accept: 'image/*', capture: 'environment' });
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}
async function cameraPages(scan) {
  const f = await pickCamera();
  return f ? [await imagePage(f, scan)] : null;
}
async function importPages() {
  const f = await pickFile('application/pdf,image/*');
  if (!f) return null;
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return pdfToPages(f);
  return [await imagePage(f)];
}

// Document scan look: greyscale, white paper, dark ink (levels stretched from the ink level up to
// the paper level, the 85th brightness percentile; then a little extra contrast).
export async function scanFilter(src) {
  const img = new Image(); img.src = src; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data, hist = new Uint32Array(256);
  for (let i = 0; i < p.length; i += 4) { const g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0; p[i] = g; hist[g]++; }
  const n = p.length / 4, pct = q => { let s = 0; for (let v = 0; v < 256; v++) { s += hist[v]; if (s >= n * q) return v; } return 255; };
  // hi = paper brightness (→ white); lo = ink (→ black), at least 60 levels darker than the paper
  // so an almost uniform photo doesn't turn its paper black
  const hi = Math.max(1, pct(0.85)), lo = Math.max(0, Math.min(pct(0.02), hi - 60));
  for (let i = 0; i < p.length; i += 4) {
    let v = (p[i] - lo) / (hi - lo); v = Math.min(1, Math.max(0, v)); v = v * v * (3 - 2 * v); // smoothstep: crisper
    p[i] = p[i + 1] = p[i + 2] = Math.round(v * 255);
  }
  x.putImageData(d, 0, 0);
  return c.toDataURL('image/jpeg', 0.88);
}

// ---------- Template window ----------
function templateWindow(ctx, cur, insert) {
  const curH = cur ? pageH(cur) : 1414;
  const o = {
    tab: 'paper',
    template: cur && !cur.bg && !cur.pdf && cur.template in TEMPLATES ? cur.template : (settings.lastTemplate in TEMPLATES ? settings.lastTemplate : 'lined'),
    paper: cur && !cur.bg && !cur.pdf && cur.paper in PAPERS ? cur.paper : 'white',
    orient: curH < PAGE_W ? 'landscape' : 'portrait',
    size: 'a4', custom: [210, 297],
    cover: ctx.doc.cover || COVERS[1],
  };
  // start with the current page's size: a listed size of the same shape (A4 first), else "Angepasst"
  const match = ['a4', ...Object.keys(SIZES).filter(k => k !== 'a4')].find(k => Math.abs(heightOf({ size: k, orient: o.orient }) - curH) <= 2);
  if (match) o.size = match;
  else { o.size = 'custom'; o.custom = o.orient === 'landscape' ? [Math.round(210 * curH / PAGE_W), 210] : [210, Math.round(210 * curH / PAGE_W)]; }
  const sample = (template = o.template, paper = o.paper) => ({ template, paper, h: heightOf(o), elements: [] });
  const back = h('div', { class: 'backdrop' });
  const close = () => { document.removeEventListener('keydown', onKey); back.classList.add('closing'); setTimeout(() => back.remove(), 200); };
  const confirm = () => {
    if (o.tab === 'paper') {
      settings.lastTemplate = o.template; saveSettings();
      insert([newPage(o.template, heightOf(o), o.paper)]);
    } else {
      // cover page: the cover drawn as the page background
      // (filled with the cover colour first: the cover's rounded corners must not turn black in the JPEG)
      const hh = heightOf(o), cv = document.createElement('canvas'), page = document.createElement('canvas');
      renderCover(cv, o.cover, PAGE_W, hh);
      page.width = PAGE_W; page.height = hh;
      const x = page.getContext('2d');
      x.fillStyle = o.cover; x.fillRect(0, 0, PAGE_W, hh); x.drawImage(cv, 0, 0);
      insert([{ ...newPage('blank', hh), bg: page.toDataURL('image/jpeg', 0.9) }]);
    }
    close();
  };
  // Escape / Enter belong to an open size or colour menu first
  const onKey = e => { if (document.querySelector('.popover') || e.target.tagName === 'INPUT') return; if (e.key === 'Escape') close(); else if (e.key === 'Enter') confirm(); };
  document.addEventListener('keydown', onKey);

  const top = h('div', { class: 'tw-top' }), gallery = h('div', { class: 'tw-gallery' });
  const tabs = h('div', { class: 'tw-tabs' });
  const sizeName = () => (o.size === 'custom' ? `${o.custom[0]} × ${o.custom[1]} mm` : SIZES[o.size][0].replace('-Format', ''));
  const sizeLabel = () => `${sizeName()}, ${o.orient === 'portrait' ? 'Hochformat' : 'Querformat'}`;

  // Size window: portrait / landscape, the paper sizes, and "Angepasst" (own width × height in mm)
  function sizePopover(anchor) {
    const body = h('div', { class: 'sz' });
    const draw = (customOpen = false) => {
      const seg = h('div', { class: 'sz-seg' }, [['portrait', 'Hochformat'], ['landscape', 'Querformat']].map(([k, l]) =>
        h('button', { class: o.orient === k ? 'on' : '', onclick: () => { o.orient = k; render(); draw(customOpen); } }, l)));
      if (customOpen) {
        const num = (v, i) => h('input', {
          class: 'field sz-num', type: 'number', min: 20, max: 2000, step: 1, value: v, inputmode: 'numeric',
          onchange: e => { const n = Math.round(+e.target.value); if (n >= 20 && n <= 2000) { o.custom = o.custom.slice(); o.custom[i] = n; o.size = 'custom'; render(); } },
        });
        body.replaceChildren(seg, h('div', { class: 'sz-list' },
          h('button', { class: 'sz-row', onclick: () => draw(false) }, icon('chevronLeft', 18), h('span', {}, 'Größen')),
          h('label', { class: 'sz-row' }, h('span', {}, 'Breite (mm)'), num(o.custom[0], 0)),
          h('label', { class: 'sz-row' }, h('span', {}, 'Höhe (mm)'), num(o.custom[1], 1))),
          h('div', { class: 'sz-hint' }, 'Maße im Hochformat; Querformat dreht die Seite.'));
        return;
      }
      body.replaceChildren(seg, h('div', { class: 'sz-list' },
        ...Object.entries(SIZES).map(([k, [label]]) => h('button', {
          class: 'sz-row', onclick: () => { o.size = k; render(); closePopover(); },
        }, h('span', {}, label), o.size === k ? icon('check', 20) : null)),
        h('button', { class: 'sz-row', onclick: () => { if (o.size !== 'custom') { o.custom = dimsOf(o).slice(); o.size = 'custom'; render(); } draw(true); } },
          h('span', {}, 'Angepasst'), o.size === 'custom' ? h('span', { class: 'sz-val' }, `${o.custom[0]} × ${o.custom[1]} mm`) : null, icon('chevronRight', 18))));
    };
    draw(o.size === 'custom');
    popover(anchor, body, { className: 'sz-pop' });
  }
  const field = (label, value, onclick) => h('button', { class: 'tw-field', onclick }, h('span', {}, label), h('span', { class: 'tw-val' }, value, icon('chevronDown', 16)));

  function render() {
    tabs.replaceChildren(...[['cover', 'Umschlag'], ['paper', 'Papier']].map(([k, l]) => h('button', { class: o.tab === k ? 'on' : '', onclick: () => { o.tab = k; render(); } }, l)));
    const preview = h('canvas');
    if (o.tab === 'paper') renderThumb(preview, sample(), 240); else renderCover(preview, o.cover, 240, Math.round(240 * heightOf(o) / PAGE_W));
    const swatch = h('i', { class: 'tw-dot', style: { background: PAPERS[o.paper].color } });
    top.replaceChildren(
      h('div', { class: 'tw-preview' },
        h('div', { class: 'tw-cap' }, o.tab === 'paper' ? 'PAPIER' : 'UMSCHLAG'), preview,
        h('div', { class: 'tw-name' }, o.tab === 'paper' ? TEMPLATES[o.template] : COVER_NAMES[COVERS.indexOf(o.cover)] || 'Umschlag')),
      h('div', { class: 'tw-settings' },
        h('div', { class: 'tw-cap' }, o.tab === 'paper' ? 'PAPIER-VORLAGEN' : 'UMSCHLAG'),
        h('div', { class: 'tw-group' },
          field('Größe', sizeLabel(), e => sizePopover(e.currentTarget)),
          o.tab === 'paper' ? field('Farbe', [swatch, PAPER_NAMES[o.paper]], e => menu(e.currentTarget, PAPER_ORDER.map(k => ({
            label: PAPER_NAMES[k], swatch: PAPERS[k].color, action: () => { o.paper = k; render(); },
          })))) : null)));
    const land = o.orient === 'landscape' ? ' landscape' : '';
    if (o.tab === 'paper') {
      gallery.replaceChildren(h('div', { class: 'tw-h1' }, 'Papier-Vorlagen'),
        ...TEMPLATE_SECTIONS.flatMap(([name, keys]) => [h('div', { class: 'tw-h2' }, name), h('div', { class: 'tw-grid' + land }, keys.map(k => {
          const cv = h('canvas'); renderThumb(cv, sample(k), 220);
          const active = o.template === k;
          return h('div', { class: 'tw-item' + (active ? ' active' : '') },
            h('button', { class: 'tw-art', 'aria-label': TEMPLATES[k], onclick: () => { o.template = k; render(); } }, cv, active ? h('span', { class: 'tw-check' }, icon('check', 16)) : null),
            h('div', { class: 'tw-label' }, TEMPLATES[k]),
            h('div', { class: 'tw-dots' }, PAPER_ORDER.map(pk => h('button', {
              class: 'tw-dot' + (active && o.paper === pk ? ' on' : ''), style: { background: PAPERS[pk].color }, title: `${TEMPLATES[k]}, ${PAPER_NAMES[pk]}`,
              'aria-label': `${TEMPLATES[k]}, ${PAPER_NAMES[pk]}`, onclick: () => { o.template = k; o.paper = pk; render(); },
            }))));
        }))]));
    } else {
      gallery.replaceChildren(h('div', { class: 'tw-h1' }, 'Umschläge'), h('div', { class: 'tw-grid' + land }, COVERS.map((c, i) => {
        const cv = h('canvas'); renderCover(cv, c, 200, Math.round(200 * heightOf(o) / PAGE_W));
        const active = o.cover === c;
        return h('div', { class: 'tw-item' + (active ? ' active' : '') },
          h('button', { class: 'tw-art', 'aria-label': COVER_NAMES[i], onclick: () => { o.cover = c; render(); } }, cv, active ? h('span', { class: 'tw-check' }, icon('check', 16)) : null),
          h('div', { class: 'tw-label' }, COVER_NAMES[i]));
      })));
    }
  }
  back.append(h('div', { class: 'tw', role: 'dialog', 'aria-label': 'Vorlagen' },
    h('div', { class: 'tw-head' },
      h('button', { class: 'tw-round', title: 'Schließen', 'aria-label': 'Schließen', onclick: close }, icon('close', 20)),
      tabs,
      h('button', { class: 'tw-round primary', title: 'Hinzufügen', 'aria-label': 'Hinzufügen', onclick: confirm }, icon('check', 22))),
    top, gallery));
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  render();
  document.body.append(back);
}
