// Spatial navigation engine: moves DOM focus with arrow keys, geometrically.
//
// Any element with class "focusable" participates. Focus moves to the nearest
// visible candidate in the pressed direction, preferring candidates that
// overlap the current element on the perpendicular axis (so rows behave like
// rows and columns like columns).
//
// Scopes: pushScope(el) traps navigation inside el (used by modals and the
// player overlay); popScope() releases it.
//
// Key handlers: pushKeyHandler(fn) lets a screen intercept keys before the
// engine (the player uses this). Return true from fn to consume the event.

const BACK_KEYS = ['Escape', 'Backspace', 'BrowserBack', 'GoBack', 'XF86Back', 'SoftLeft'];
const ENTER_KEYS = ['Enter', 'NumpadEnter', 'Select', ' '];

const scopes = [];
const keyHandlers = [];
let backHandler = null;
let lastFocused = null;

function currentScope() {
  return scopes.length ? scopes[scopes.length - 1] : document.body;
}

function isVisible(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  // display:none ancestors yield a zero rect, checked above; also honor .hidden
  if (el.closest('.hidden')) return false;
  return true;
}

function focusables(scope) {
  return [...scope.querySelectorAll('.focusable')].filter(isVisible);
}

function rectOf(el) {
  return el.getBoundingClientRect();
}

// Score a candidate rect against the source rect for a direction.
// Lower is better; Infinity means "not in that direction".
function score(from, to, dir) {
  const fc = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const tc = { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  let primary, secondary, overlap;
  if (dir === 'left' || dir === 'right') {
    primary = dir === 'left' ? fc.x - tc.x : tc.x - fc.x;
    secondary = Math.abs(tc.y - fc.y);
    overlap = Math.min(from.bottom, to.bottom) - Math.max(from.top, to.top);
  } else {
    primary = dir === 'up' ? fc.y - tc.y : tc.y - fc.y;
    secondary = Math.abs(tc.x - fc.x);
    overlap = Math.min(from.right, to.right) - Math.max(from.left, to.left);
  }
  if (primary <= 1) return Infinity;
  // Strongly prefer candidates aligned with us on the cross axis.
  const alignBonus = overlap > 0 ? 0 : 1e6;
  return alignBonus + primary + secondary * 2.5;
}

function move(dir) {
  const scope = currentScope();
  const all = focusables(scope);
  if (!all.length) return false;
  let cur = document.activeElement;
  if (!cur || !cur.classList || !cur.classList.contains('focusable') || !scope.contains(cur)) {
    focus(preferredIn(scope) || all[0]);
    return true;
  }
  const from = rectOf(cur);
  let best = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const s = score(from, rectOf(el), dir);
    if (s < bestScore) { bestScore = s; best = el; }
  }
  if (best) {
    focus(best);
    return true;
  }
  return false;
}

function preferredIn(scope) {
  return scope.querySelector('.focusable[autofocus], .focusable[data-nav-default]');
}

// Focus the best starting element in a scope: an explicit default first, then
// content on the active screen (not the sidebar), then anything focusable.
function focusFirstIn(scope) {
  const pref = preferredIn(scope);
  if (pref && isVisible(pref)) { focus(pref); return; }
  if (scope === document.body) {
    const screen = document.querySelector('#screens .screen:not(.hidden)');
    if (screen) {
      const inScreen = focusables(screen);
      if (inScreen.length) { focus(inScreen[0]); return; }
      // Screen content is still loading — wait for it rather than grabbing
      // the sidebar; the observer will retry as content arrives.
      return;
    }
  }
  const els = focusables(scope);
  if (els.length) focus(els[0]);
}

function focus(el) {
  if (!el) return;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  lastFocused = el;
  scrollIntoViewNicely(el);
}

function scrollIntoViewNicely(el) {
  // Horizontal: center within the nearest scrollable row.
  const row = el.closest('.meta-row');
  if (row) {
    const target = el.offsetLeft - (row.clientWidth - el.offsetWidth) / 2;
    row.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }
  // Vertical: center within the nearest vertically scrollable ancestor.
  let p = el.parentElement;
  while (p && p !== document.body) {
    const canScroll = p.scrollHeight > p.clientHeight + 4;
    if (canScroll && (p.classList.contains('screen') || p.classList.contains('modal-body') || p === row?.parentElement)) {
      const elTop = offsetTopWithin(el, p);
      const target = elTop - (p.clientHeight - el.offsetHeight) / 2;
      p.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
      break;
    }
    p = p.parentElement;
  }
}

function offsetTopWithin(el, ancestor) {
  let y = 0;
  let n = el;
  while (n && n !== ancestor) {
    y += n.offsetTop;
    n = n.offsetParent;
  }
  return y;
}

function activate(el) {
  if (!el) return;
  el.dispatchEvent(new CustomEvent('nav:activate', { bubbles: true }));
  el.click();
}

function onKeyDown(e) {
  // Let registered handlers (player, OSK physical typing) intercept first.
  for (let i = keyHandlers.length - 1; i >= 0; i--) {
    try {
      if (keyHandlers[i](e)) { e.preventDefault(); return; }
    } catch (err) {
      console.error('key handler error', err);
    }
  }

  const key = e.key;
  const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
  if (dirs[key]) {
    e.preventDefault();
    move(dirs[key]);
    return;
  }
  if (ENTER_KEYS.includes(key)) {
    const cur = document.activeElement;
    if (cur && cur.classList && cur.classList.contains('focusable')) {
      e.preventDefault();
      activate(cur);
    }
    return;
  }
  if (BACK_KEYS.includes(key)) {
    e.preventDefault();
    if (backHandler) backHandler();
  }
}

export const Nav = {
  init() {
    window.addEventListener('keydown', onKeyDown);
    // Keep focus alive: if the focused node disappears, refocus something.
    const mo = new MutationObserver(() => {
      const cur = document.activeElement;
      if (!cur || cur === document.body || !isVisible(cur)) {
        const scope = currentScope();
        if (!focusables(scope).length) return;
        if (!lastFocused || !lastFocused.isConnected || !isVisible(lastFocused)) {
          focusFirstIn(scope);
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  },
  focus,
  move,
  activate,
  focusables: () => focusables(currentScope()),
  focusFirst(container) {
    focusFirstIn(container || currentScope());
  },
  pushScope(el) {
    scopes.push(el);
    this.focusFirst(el);
  },
  popScope() {
    scopes.pop();
  },
  scopeDepth: () => scopes.length,
  pushKeyHandler(fn) { keyHandlers.push(fn); },
  popKeyHandler(fn) {
    const i = keyHandlers.lastIndexOf(fn);
    if (i >= 0) keyHandlers.splice(i, 1);
  },
  setBackHandler(fn) { backHandler = fn; },
  isBackKey: (key) => BACK_KEYS.includes(key),
  isEnterKey: (key) => ENTER_KEYS.includes(key),
};
