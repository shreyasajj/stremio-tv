// On-screen keyboard for remote-only text entry (search, addon URLs, login).
// Physical keyboards also work: printable keys type directly while the
// keyboard modal is open.

import { el, openModal } from './ui.js';
import { Nav } from './nav.js';

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

// oskPrompt: open a modal keyboard, resolve with the final string (null if backed out).
// opts: { title, value, password, onChange (live, for search) }
export function oskPrompt({ title = 'Enter text', value = '', password = false, onChange } = {}) {
  return new Promise((resolve) => {
    let text = value;
    let layer = 'lower'; // lower | upper | symbols
    let done = false;

    const display = el('div', { class: 'osk-display' });
    const rowsHost = el('div', { class: 'osk-rows' });
    const modal = el(
      'div',
      { class: 'modal', style: 'min-width: 780px' },
      el('div', { class: 'modal-title', text: title }),
      display,
      el('div', { class: 'osk' }, rowsHost)
    );

    function renderDisplay() {
      display.innerHTML = '';
      if (!text) {
        display.append(el('span', { class: 'osk-placeholder', text: password ? 'Password' : 'Type with the arrow keys…' }));
      } else {
        display.append(password ? '•'.repeat(text.length) : text);
      }
      display.append(el('span', { class: 'caret' }));
    }

    function setText(t) {
      text = t;
      renderDisplay();
      if (onChange) onChange(text);
    }

    function key(label, action, cls = '') {
      const b = el('button', { class: `focusable osk-key ${cls}`, text: label });
      b.addEventListener('click', action);
      return b;
    }

    function renderRows() {
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
        key('⌫', () => setText(text.slice(0, -1))),
        key('Clear', () => setText('')),
        key('Done', finish, 'wide')
      );
      rowsHost.append(bottom);
    }

    function finish() {
      done = true;
      handle.close();
      resolve(text);
    }

    // Physical keyboard passthrough while the OSK is open.
    function physicalKeys(e) {
      if (e.key === 'Enter' && document.activeElement?.classList.contains('osk-key')) {
        return false; // let Nav activate the focused key
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setText(text + e.key);
        return true;
      }
      if (e.key === 'Delete') { setText(text.slice(0, -1)); return true; }
      return false;
    }

    Nav.pushKeyHandler(physicalKeys);
    const handle = openModal(modal, {
      onClose: () => {
        Nav.popKeyHandler(physicalKeys);
        if (!done) { done = true; resolve(null); }
      },
    });

    renderDisplay();
    renderRows();
    // Start focus on a sensible key (first letter row).
    const firstKey = rowsHost.querySelectorAll('.osk-row')[1]?.querySelector('.osk-key');
    if (firstKey) Nav.focus(firstKey);
  });
}
