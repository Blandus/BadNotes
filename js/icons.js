// Original line icons, 24×24, drawn with currentColor.
const P = {
  library: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  bookmark: '<path d="M7 3.5h10v17l-5-4-5 4z"/>',
  bookmarkFill: '<path d="M7 3.5h10v17l-5-4-5 4z" fill="currentColor"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8 11H6.5a1 1 0 0 0-1 1v7.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V12a1 1 0 0 0-1-1H16"/>',
  pen: '<path d="M4.5 19.5l1-4.2L16.3 4.5a1.9 1.9 0 0 1 2.7 0l.5.5a1.9 1.9 0 0 1 0 2.7L8.7 18.5z"/><path d="M14.5 6.3l3.2 3.2"/>',
  eraser: '<path d="M9 20h11"/><path d="M4.6 14.6l9.3-9.3a2 2 0 0 1 2.8 0l2.9 2.9a2 2 0 0 1 0 2.8l-7.7 7.7a4 4 0 0 1-2.8 1.2H8.3a2 2 0 0 1-1.4-.6l-2.3-2.3a1.7 1.7 0 0 1 0-2.4z"/><path d="M8.8 10.4l4.8 4.8"/>',
  highlighter: '<path d="M8.5 14.5L5 18v2.5h3.5L12 17"/><path d="M8.5 14.5l8-8 3.5 3.5-8 8z"/><path d="M14 9l3.5 3.5"/>',
  shapes: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><circle cx="15.5" cy="15.5" r="5"/>',
  lasso: '<path d="M12 4c5 0 8.5 2.4 8.5 5.5S17 15 12 15c-1.2 0-2.4-.2-3.4-.4" stroke-dasharray="2.4 2.6"/><path d="M8.3 14.4C5.3 13.5 3.5 11.7 3.5 9.5 3.5 6.4 7 4 12 4"/><path d="M6.8 14.3c-.9 1.6-.1 3.1 1.3 3.4 1.5.4 1.8 1.7.9 2.8"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="10" r="1.7"/><path d="M4 18l5-5 4 4 2.5-2.5L20 19"/>',
  text: '<path d="M5 7V4.5h14V7M12 4.5v15M9 19.5h6"/>',
  laser: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.5M12 18.7v2.5M2.8 12h2.5M18.7 12h2.5M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8"/>',
  undo: '<path d="M9 6.5L4.5 11 9 15.5"/><path d="M4.5 11H15a4.5 4.5 0 0 1 0 9h-2.5"/>',
  redo: '<path d="M15 6.5l4.5 4.5-4.5 4.5"/><path d="M19.5 11H9a4.5 4.5 0 0 0 0 9h2.5"/>',
  addPage: '<path d="M6 3.5h8.2l3.8 3.8v13.2H6z"/><path d="M12 10.5v6M9 13.5h6"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  chevronDown: '<path d="M7 10l5 5 5-5"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4.2l2 2.2h6.8a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  star: '<path d="M12 3.8l2.5 5.1 5.6.8-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z"/>',
  starFill: '<path d="M12 3.8l2.5 5.1 5.6.8-4.1 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8z" fill="currentColor"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5v-2h5v2M6.5 6.5l1 13.5h9l1-13.5M10 10.5v6M14 10.5v6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6M5.5 5.5l1.8 1.8M16.7 16.7l1.8 1.8M5.5 18.5l1.8-1.8M16.7 7.3l1.8-1.8"/><circle cx="12" cy="12" r="6.6"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.3"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.3"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.3"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.3"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.8" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>',
  sort: '<path d="M7.5 4.5v15M4 16l3.5 3.5L11 16M16.5 19.5v-15M13 8l3.5-3.5L20 8"/>',
  sync: '<path d="M19.5 9.5A8 8 0 0 0 5.3 7.3M4.5 14.5a8 8 0 0 0 14.2 2.2"/><path d="M19.8 4.5v5h-5M4.2 19.5v-5h5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  cut: '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M8.3 15.7L18 4.5M15.7 15.7L6 4.5"/>',
  paste: '<rect x="5.5" y="5" width="13" height="15.5" rx="2"/><path d="M9 5V3.5h6V5M9 11h6M9 15h4"/>',
  rename: '<path d="M4.5 19.5l1-4.2L16.3 4.5a1.9 1.9 0 0 1 2.7 0l.5.5a1.9 1.9 0 0 1 0 2.7L8.7 18.5z"/>',
  move: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4.2l2 2.2h6.8a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M10 13.5h5M13 11l2.5 2.5L13 16"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1-1.6-1-2.6 0-.9.7-1.5 1.6-1.5h2.1a4 4 0 0 0 4-4C20.5 6.6 16.7 3.5 12 3.5z"/><circle cx="7.5" cy="11" r="1.1" fill="currentColor" stroke="none"/><circle cx="10" cy="7.3" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="7.3" r="1.1" fill="currentColor" stroke="none"/>',
  restore: '<path d="M9 6.5L4.5 11 9 15.5"/><path d="M4.5 11H15a4.5 4.5 0 0 1 0 9h-2.5"/>',
  doc: '<path d="M6 3.5h8.2l3.8 3.8v13.2H6z"/><path d="M14 3.5v4h4"/>',
  quick: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  pdf: '<path d="M6 3.5h8.2l3.8 3.8v13.2H6z"/><path d="M9 13h6M9 16.5h4"/>',
  nibFountain: '<path d="M12 3l5 7.5L12 21l-5-10.5z"/><path d="M12 10.5V14"/><circle cx="12" cy="10" r=".8" fill="currentColor"/>',
  nibBall: '<path d="M9 3h6v11.5L12 21l-3-6.5z"/><path d="M9 14.5h6"/>',
  nibBrush: '<path d="M14.5 3.5l4 4-6.5 6.5-4-4z"/><path d="M8 10c-3 1-3.5 5-4.5 8.5 3.5-1 7.5-1 8.5-4.5"/>',
  minus: '<path d="M5 12h14"/>',
  screenshot: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M9 9.5h1.4l.8-1.3h1.6l.8 1.3H15a1 1 0 0 1 1 1v3.8a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-3.8a1 1 0 0 1 1-1z"/><circle cx="12" cy="12.3" r="1.5"/>',
  portrait:'<rect x="6.5" y="3.5" width="11" height="17" rx="2"/>',
  landscape: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/>',
  home:'<path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19z"/>',
  moreCircle: '<circle cx="12" cy="12" r="8.5"/><circle cx="8.3" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15.7" cy="12" r="1" fill="currentColor" stroke="none"/>',
  selectCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.2l2.6 2.6 4.8-5"/>',
  favorites: '<path d="M6.5 3.5h11v17l-5.5-3.8-5.5 3.8z"/><path d="M12 7.3l1.1 2.2 2.4.3-1.8 1.7.4 2.4-2.1-1.1-2.1 1.1.4-2.4-1.8-1.7 2.4-.3z"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
  notes: '<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  dots: '<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  dotsV: '<circle cx="12" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  cards: '<rect x="3.5" y="7" width="13" height="10" rx="1.8"/><path d="M7.5 7V5.5A1.5 1.5 0 0 1 9 4h10a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-2.5"/><path d="M7 11h6M7 13.8h4"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
  textdoc: '<path d="M6 3.5h8.2l3.8 3.8v13.2H6z"/><path d="M14 3.5v4h4M9 11.5h6M9 14.5h6M9 17.5h3.5"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z"/>',
  cloudDown: '<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z"/><path d="M12 10.5v5M9.8 13.4l2.2 2.2 2.2-2.2"/>',
  // folder symbols (also usable elsewhere)
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  school: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.5V16c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-4.5"/><path d="M21.5 9.5V15"/>',
  work: '<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v1.5"/><path d="M3.5 12.5h17"/>',
  idea: '<path d="M9.5 17.5h5M10.5 20.5h3"/><path d="M8.6 14.6a6 6 0 1 1 6.8 0c-.6.5-.9 1.1-.9 1.9v1h-5v-1c0-.8-.3-1.4-.9-1.9z"/>',
  flask: '<path d="M9.5 3.5h5"/><path d="M10.5 3.5v6L5 18.5a1.4 1.4 0 0 0 1.2 2h11.6a1.4 1.4 0 0 0 1.2-2l-5.5-9v-6"/><path d="M7.4 14.5h9.2"/>',
  music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.3 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
  code: '<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  lassoRect: '<rect x="4" y="5" width="16" height="13" rx="1.5" stroke-dasharray="3 2.4"/><path d="M15 15.5l4.5 4.5M15 15.5v4M15 15.5h4"/>',
  scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><rect x="8" y="7.5" width="8" height="9" rx="1.2"/><path d="M10 10.5h4M10 13.5h3"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.4"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19.5h14"/>',
  // more folder symbols
  pencil: '<path d="M15.5 4.5l4 4L9 19l-5 1 1-5z"/><path d="M13.5 6.5l4 4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5s1.1-6.1 3.5-8.5z"/>',
  plane: '<path d="M10.5 13.5L4 12l1-2 7 .5 4.5-5a1.8 1.8 0 0 1 2.5 2.5l-5 4.5.5 7-2 1-1.5-6.5z"/>',
  sport: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5l4 3-1.5 4.5h-5L8 10.5z"/><path d="M12 3.5v4M20 10.5l-4 0M17 19l-2.5-4M7 19l2.5-4M4 10.5h4"/>',
  leaf: '<path d="M5 19c0-8 5-13.5 14.5-14.5C19 13.5 13.5 19 5 19z"/><path d="M5 19l8-8"/>',
  money: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v5M17.5 9.5v5"/>',
  chart: '<path d="M4 4v16h16"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  person: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20c.8-3.7 3.7-6 7.5-6s6.7 2.3 7.5 6"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.6-3.2 3-5.2 6-5.2s5.4 2 6 5.2"/><path d="M15.5 5.5a3.2 3.2 0 0 1 0 6.2M17.5 14.6c1.8.7 3 2.4 3.5 4.9"/>',
  food: '<path d="M7 3.5v17M4.5 3.5V8a2.5 2.5 0 0 0 5 0V3.5"/><path d="M17 20.5v-17c-2.2 1-3.5 3.5-3.5 7 0 1.8 1.2 2.7 3.5 2.7"/>',
  health: '<path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5z"/>',
  car: '<path d="M4 16.5V12l2-5h12l2 5v4.5z"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>',
  game: '<rect x="3" y="7.5" width="18" height="10" rx="4"/><path d="M8 10.5v4M6 12.5h4"/><circle cx="15.5" cy="11.5" r=".9" fill="currentColor" stroke="none"/><circle cx="17.5" cy="13.5" r=".9" fill="currentColor" stroke="none"/>',
  flag: '<path d="M5.5 20.5v-16"/><path d="M5.5 4.5h12l-2.5 4 2.5 4h-12"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v10.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  coffee: '<path d="M4.5 9.5h12v5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5z"/><path d="M16.5 11h1.5a2.5 2.5 0 0 1 0 5h-1.8M8.5 3.5v3M12.5 3.5v3"/>',
};

export function icon(name, size = 22) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.7'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || '';
  return s;
}

// Folio mark (same artwork as folio-mark.svg). The front layer and its fold follow the theme
// via --logo-front / --logo-fold, so the mark stays visible on dark backgrounds.
export function folioMark(size = 32) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 64 64');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('class', 'folio-mark'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<rect x="8" y="12" width="28" height="40" rx="6" fill="#8EB8E6" transform="rotate(-20 22 32)"/>'
    + '<rect x="16" y="11" width="28" height="40" rx="6" fill="#6B8F7E" transform="rotate(-6 30 31)"/>'
    + '<g transform="rotate(8 40 36)"><path d="M30 14H43L54 25V50a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6Z" fill="var(--logo-front, #0F2747)"/>'
    + '<path d="M43 14V21.5a3.5 3.5 0 0 0 3.5 3.5H54Z" fill="var(--logo-fold, #FAF9F5)"/></g>';
  return s;
}
