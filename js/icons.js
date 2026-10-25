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
  portrait: '<rect x="6.5" y="3.5" width="11" height="17" rx="2"/>',
  landscape: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/>',
  home:'<path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19z"/>',
  moreCircle: '<circle cx="12" cy="12" r="8.5"/><circle cx="8.3" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="15.7" cy="12" r="1" fill="currentColor" stroke="none"/>',
  selectCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M8.3 12.2l2.6 2.6 4.8-5"/>',
  favorites: '<path d="M6.5 3.5h11v17l-5.5-3.8-5.5 3.8z"/><path d="M12 7.3l1.1 2.2 2.4.3-1.8 1.7.4 2.4-2.1-1.1-2.1 1.1.4-2.4-1.8-1.7 2.4-.3z"/>',
  zoom: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>',
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
