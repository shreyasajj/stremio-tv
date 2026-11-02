// Inline SVG icons (24×24, drawn in currentColor). SVG instead of font glyphs:
// TV boxes often lack emoji/symbol fonts and render those as empty boxes.

const STROKE = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const PATHS = {
  search: `<g ${STROKE}><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/></g>`,
  home: `<path ${STROKE} d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z"/>`,
  discover: `<g ${STROKE}><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></g>`,
  library: `<path ${STROKE} d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z"/>`,
  addons: `<g ${STROKE}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M17 3.5v7M13.5 7h7"/></g>`,
  settings: `<g ${STROKE}><path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2.5"/><circle cx="10" cy="12" r="2.5"/><circle cx="18" cy="18" r="2.5"/></g>`,
  play: '<path fill="currentColor" d="M7 4.2v15.6a1 1 0 0 0 1.5.86l12.4-7.8a1 1 0 0 0 0-1.72L8.5 3.34A1 1 0 0 0 7 4.2z"/>',
  pause: '<g fill="currentColor"><rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/></g>',
  info: `<g ${STROKE}><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></g>`,
  subtitles: `<g ${STROKE}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 12.5h4M13.5 12.5H17M7 15.5h6.5M16 15.5h1"/></g>`,
  audio: `<g ${STROKE}><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></g>`,
  speed: `<g ${STROKE}><path d="M4.5 18a8.5 8.5 0 1 1 15 0"/><path d="m12 14 4-5"/></g>`,
  next: '<g fill="currentColor"><path d="M5 5.2v13.6a1 1 0 0 0 1.55.83l9.6-6.8a1 1 0 0 0 0-1.66l-9.6-6.8A1 1 0 0 0 5 5.2z"/><rect x="17" y="4.5" width="2.5" height="15" rx="1"/></g>',
  forward: '<g fill="currentColor"><path d="M3 6v12l8.5-6zM12 6v12l8.5-6z"/></g>',
  rewind: '<g fill="currentColor"><path d="M21 6v12l-8.5-6zM12 6v12L3.5 12z"/></g>',
  plus: `<path ${STROKE} d="M12 5v14M5 12h14"/>`,
  download: `<path ${STROKE} d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/>`,
  restore: `<path ${STROKE} d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5"/>`,
  trash: `<path ${STROKE} d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>`,
  chevronDown: `<path ${STROKE} d="m6 9.5 6 6 6-6"/>`,
  chevronRight: `<path ${STROKE} d="m9.5 6 6 6-6 6"/>`,
  check: `<path ${STROKE} d="m5 12.5 4.5 4.5L19 7.5"/>`,
  star: '<path fill="currentColor" d="m12 3.2 2.6 5.5 6 .7-4.45 4.1 1.2 5.9L12 16.4l-5.35 3 1.2-5.9L3.4 9.4l6-.7z"/>',
  backspace: `<g ${STROKE}><path d="M8.5 5H20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H8.5L3 12z"/><path d="m11.5 9.5 5 5M16.5 9.5l-5 5"/></g>`,
};

// Markup string, for innerHTML and static HTML.
export function iconSvg(name, cls = '') {
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

// DOM node, for el(...) children.
export function icon(name, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = iconSvg(name, cls);
  return t.content.firstChild;
}
