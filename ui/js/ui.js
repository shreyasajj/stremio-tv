// Small DOM helpers, toasts and modal management shared by all screens.

import { Nav } from './nav.js';

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

function closeModal(entry) {
  const i = modalStack.indexOf(entry);
  if (i < 0) return;
  modalStack.splice(i, 1);
  entry.backdrop.remove();
  Nav.popScope();
  if (entry.prevFocus && entry.prevFocus.isConnected) Nav.focus(entry.prevFocus);
  if (entry.onClose) entry.onClose();
}

export function closeTopModal() {
  if (!modalStack.length) return false;
  closeModal(modalStack[modalStack.length - 1]);
  return true;
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

export function metaCard(meta, { onSelect, progress } = {}) {
  const poster = el('div', { class: 'poster' });
  if (meta.poster) poster.style.backgroundImage = `url("${meta.poster}")`;
  else poster.append(el('div', { class: 'fallback-name', text: meta.name || meta.id }));
  const card = el(
    'button',
    { class: 'focusable meta-card' },
    poster,
    progress !== undefined && progress !== null
      ? el('div', { class: 'progress-strip' }, el('div', { style: `width:${Math.round(progress * 100)}%` }))
      : null,
    el('div', { class: 'card-name', text: meta.name || meta.id })
  );
  if (onSelect) card.addEventListener('click', () => onSelect(meta));
  return card;
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
