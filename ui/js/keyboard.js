// On-screen keyboard for remote-only text entry (search, addon URLs, login).
// Physical keyboards also work: printable keys type directly while the
// keyboard modal is open.

import { el, openModal, toast } from './ui.js';
import { Nav } from './nav.js';
import { icon } from './icons.js';

const ROWS_LOWER = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '_', '@'],
];
const ROWS_UPPER = ROWS_LOWER.map((row) => row.map((k) => k.toUpperCase()));
const ROWS_SYMBOLS = [
  ['!', '#', '$', '%', '&', '*', '(', ')', '+', '='],
  [':', ';', ',', '?', '"', "'", '`', '~', '^', '|'],
  ['/', '\\', '[', ']', '{', '}', '<', '>', '-', '_'],
  ['.', '@', '€', '£', '№', '°', '§', '·', '…', ' '],
];

// createKeyboard: the keyboard itself (text display + key rows), for embedding
// in a screen or a dialog.
// opts: { value, password, placeholder, leadingIcon, onChange(text), onDone(text) }
// Returns { element, text(), setText(t), focus(), handleKey(e) }; handleKey
// types physical keys into it and returns true when it consumed the event.
export function createKeyboard({ value = '', password = false, placeholder, leadingIcon, onChange, onDone } = {}) {
  let text = value;
  let layer = 'lower'; // lower | upper | symbols

  const display = el('div', { class: 'osk-display' });
  const rowsHost = el('div', { class: 'osk-rows' });
  const element = el('div', { class: 'osk-wrap' }, display, el('div', { class: 'osk' }, rowsHost));

  function renderDisplay() {
    display.innerHTML = '';
    if (leadingIcon) display.append(icon(leadingIcon));
    if (!text) {
      display.append(el('span', { class: 'osk-placeholder', text: placeholder || (password ? 'Password' : 'Type with the arrow keys…') }));
    } else {
      display.append(password ? '•'.repeat(text.length) : text);
    }
    display.append(el('span', { class: 'caret' }));
  }

  function setText(t, { silent = false } = {}) {
    text = t;
    renderDisplay();
    if (!silent && onChange) onChange(text);
  }

  function key(label, action, cls = '', glyph = null) {
    const b = glyph
      ? el('button', { class: `focusable osk-key ${cls}`, 'aria-label': label }, icon(glyph))
      : el('button', { class: `focusable osk-key ${cls}`, text: label });
    b.addEventListener('click', action);
    return b;
  }

  async function paste() {
    let clip = '';
    try {
      if (window.shell?.readClipboard) clip = await window.shell.readClipboard();
      else if (navigator.clipboard?.readText) clip = await navigator.clipboard.readText();
    } catch { /* clipboard unavailable */ }
    clip = (clip || '').replace(/[\r\n]+/g, ' ').trim();
    if (clip) setText(text + clip);
    else toast('Clipboard is empty');
  }

  function renderRows() {
    // Keep focus on the same key position when switching layers.
    const focused = rowsHost.contains(document.activeElement) ? [...rowsHost.querySelectorAll('.osk-key')].indexOf(document.activeElement) : -1;
    rowsHost.innerHTML = '';
    const rows = layer === 'upper' ? ROWS_UPPER : layer === 'symbols' ? ROWS_SYMBOLS : ROWS_LOWER;
    rows.forEach((row) => {
      const r = el('div', { class: 'osk-row' });
      row.forEach((ch) => r.append(key(ch === ' ' ? '␣' : ch, () => setText(text + ch))));
      rowsHost.append(r);
    });
    const bottom = el('div', { class: 'osk-row' });
    bottom.append(
      key(layer === 'upper' ? 'abc' : 'ABC', () => { layer = layer === 'upper' ? 'lower' : 'upper'; renderRows(); }, layer === 'upper' ? 'on' : ''),
      key('#+=', () => { layer = layer === 'symbols' ? 'lower' : 'symbols'; renderRows(); }, layer === 'symbols' ? 'on' : ''),
      key('Space', () => setText(text + ' '), 'wide'),
      key('Paste', paste),
      key('Backspace', () => setText(text.slice(0, -1)), '', 'backspace'),
      key('Clear', () => setText('')),
      key('Done', () => onDone && onDone(text), 'wide')
    );
    rowsHost.append(bottom);
    if (focused >= 0) Nav.focus(rowsHost.querySelectorAll('.osk-key')[focused]);
  }

  // Physical keyboard: printable keys type, Backspace deletes (it must NOT
  // fall through to "go back"), Ctrl+V pastes. Enter on a focused key is left
  // to Nav so it activates that key.
  function handleKey(e) {
    if (e.key === 'Enter' && document.activeElement?.classList.contains('osk-key')) return false;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { paste(); return true; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      setText(text + e.key);
      return true;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') { setText(text.slice(0, -1)); return true; }
    return false;
  }

  renderDisplay();
  renderRows();
  return {
    element,
    text: () => text,
    setText,
    handleKey,
    // A sensible starting key: the first letter row.
    focus() {
      const first = rowsHost.querySelectorAll('.osk-row')[1]?.querySelector('.osk-key');
      if (first) Nav.focus(first);
    },
    firstLetterKey: () => rowsHost.querySelectorAll('.osk-row')[1]?.querySelector('.osk-key'),
  };
}

// oskPrompt: open a modal keyboard, resolve with the final string (null if backed out).
// opts: { title, value, password }
export function oskPrompt({ title = 'Enter text', value = '', password = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const kb = createKeyboard({
      value,
      password,
      onDone: (text) => {
        done = true;
        handle.close();
        resolve(text);
      },
    });
    const modal = el(
      'div',
      { class: 'modal', style: 'min-width: 780px' },
      el('div', { class: 'modal-title', text: title }),
      kb.element
    );

    Nav.pushKeyHandler(kb.handleKey);
    const handle = openModal(modal, {
      onClose: () => {
        Nav.popKeyHandler(kb.handleKey);
        if (!done) { done = true; resolve(null); }
      },
    });
    kb.focus();
  });
}
