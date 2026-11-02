// Small DOM helpers, toasts and modal management shared by all screens.

import { Nav } from './nav.js';
import { backdropUrl, lazyBackground, logoUrl, metaFacts } from './art.js';
import { icon } from './icons.js';

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

export function toast(message, kind = 'info', ms = 4000) {
  const root = document.getElementById('toast-root');
  const t = el('div', { class: `toast ${kind === 'error' ? 'error' : ''}` , text: message });
  root.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---- modals ----------------------------------------------------------

const modalStack = [];

export function openModal(contentEl, { onClose, backdropClass } = {}) {
  const root = document.getElementById('modal-root');
  const backdrop = el('div', { class: 'modal-backdrop' + (backdropClass ? ' ' + backdropClass : '') }, contentEl);
  root.append(backdrop);
  const prevFocus = document.activeElement;
  const entry = { backdrop, onClose, prevFocus };
  modalStack.push(entry);
  Nav.pushScope(backdrop);
  return {
    close: () => closeModal(entry),
  };
}

function closeModal(entry, { restoreFocus = true } = {}) {
  const i = modalStack.indexOf(entry);
  if (i < 0) return;
  modalStack.splice(i, 1);
  entry.backdrop.remove();
  Nav.removeScope(entry.backdrop);
  // Only hand focus back if it lands in the layer that is now on top.
  if (restoreFocus) {
    if (entry.prevFocus && entry.prevFocus.isConnected && Nav.inTopScope(entry.prevFocus)) Nav.focus(entry.prevFocus);
    else if (!Nav.inTopScope(document.activeElement)) Nav.focusFirst();
  }
  if (entry.onClose) entry.onClose();
}

export function closeTopModal() {
  if (!modalStack.length) return false;
  closeModal(modalStack[modalStack.length - 1]);
  return true;
}

// Close every dialog (newest first), e.g. before the player takes over the
// screen so nothing is left drawn over the video or catching remote keys.
export function closeAllModals() {
  while (modalStack.length) closeModal(modalStack[modalStack.length - 1], { restoreFocus: false });
}

export function hasOpenModal() {
  return modalStack.length > 0;
}

// A modal that lists options; resolves with the chosen value (or null on back).
export function pickerModal(title, options, { selectedValue } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let handle = null;
    const body = el('div', { class: 'modal-body' });
    const modal = el('div', { class: 'modal' }, el('div', { class: 'modal-title', text: title }), body);
    options.forEach((opt) => {
      const item = el(
        'button',
        { class: `focusable list-item ${opt.value === selectedValue ? 'selected' : ''}` },
        el('div', { class: 'li-title', text: opt.label }),
        opt.sub ? el('div', { class: 'li-sub', text: opt.sub }) : null
      );
      if (opt.value === selectedValue) item.setAttribute('data-nav-default', '');
      item.addEventListener('click', () => {
        done = true;
        handle.close();
        resolve(opt.value);
      });
      body.append(item);
    });
    // Items must exist before openModal so initial focus lands inside the menu.
    handle = openModal(modal, {
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
  });
}

export function confirmModal(title, { okLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return pickerModal(title, [
    { label: cancelLabel, value: false },
    { label: okLabel, value: true },
  ]).then((v) => v === true);
}

// ---- meta cards ----------------------------------------------------------

export function progressBar(progress) {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return el('div', { class: 'progress-strip' }, el('div', { style: `width:${pct}%` }));
}

// A 2:3 poster card (title shown only while focused), or with `wide` a 16:9
// backdrop card with its title and `sub` line drawn on the artwork.
// The meta rides along as card._meta for screens that react to focus.
export function metaCard(meta, { onSelect, progress, wide = false, sub } = {}) {
  const name = meta.name || meta.id;
  const art = el('div', { class: 'poster' });
  const url = wide ? backdropUrl(meta) : meta.poster;
  if (url) lazyBackground(art, url);
  if (wide) {
    art.append(el('div', { class: 'card-shade' }),
      el('div', { class: 'card-info' },
        el('div', { class: 'card-name', text: name }),
        sub ? el('div', { class: 'card-sub', text: sub }) : null));
  } else if (!meta.poster) {
    art.append(el('div', { class: 'fallback-name', text: name }));
  }
  if (progress !== undefined && progress !== null) art.append(progressBar(progress));
  const card = el('button', { class: `focusable meta-card${wide ? ' wide' : ''}` },
    art,
    wide ? null : el('div', { class: 'card-name', text: name }));
  card._meta = meta;
  if (onSelect) card.addEventListener('click', () => onSelect(meta));
  return card;
}

// The title as logo artwork, falling back to the name in large type. The name
// is always in the DOM (hidden once a logo loads). Pass logoLoaded: true when
// the logo is already preloaded so it shows without a flash of text.
export function titleArt(meta, { tag = 'div', cls = '', logoLoaded = false } = {}) {
  const name = meta.name || meta.id;
  const wrap = el(tag, { class: `title-art ${cls}`.trim() });
  const url = logoUrl(meta);
  if (url) {
    const img = el('img', { class: 'title-logo', alt: name, decoding: 'async' });
    if (logoLoaded) wrap.classList.add('has-logo');
    else img.addEventListener('load', () => wrap.classList.add('has-logo'));
    img.addEventListener('error', () => { wrap.classList.remove('has-logo'); img.remove(); });
    img.src = url;
    wrap.append(img);
  }
  wrap.append(el('div', { class: 'title-text', text: name }));
  return wrap;
}

// Year · runtime · ★ rating · genres, as dot-separated text or as chips.
export function factsRow(meta, { chips = false, cls = '' } = {}) {
  return el('div', { class: `facts ${cls}`.trim() },
    metaFacts(meta).map((f) => el('span', { class: `${chips ? 'chip' : 'fact'}${f.kind ? ' ' + f.kind : ''}` },
      f.kind === 'rating' ? icon('star') : null, f.text)));
}

export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}
