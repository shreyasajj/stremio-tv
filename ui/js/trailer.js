// Trailer previews: resting on a title for a few seconds plays its YouTube
// trailer. On Home, while the hero describes that title, it plays in the
// hero's backdrop and the rows stay usable; anywhere else it fills the
// screen behind the title's name, and the next key press closes it.
//
// YouTube's embedded player does the decoding. It is only revealed once it
// reports that it is playing, so loading spinners, ads gates and "video
// unavailable" pages never show: the artwork just stays.

import { el, titleArt, factsRow } from './ui.js';
import { Nav } from './nav.js';
import { Storage } from './storage.js';
import { cachedMeta, trailerIds } from './art.js';

const DWELL_MS = 3000;
const START_TIMEOUT_MS = 12000; // give up on a player that never starts
const FADE_MS = 600;            // matches the .on transitions in tv.css
const EMBED = 'https://www.youtube-nocookie.com/embed/';

let active = null; // the preview that is playing or starting

function stopActive() {
  if (active) { active.stop(); active = null; }
}

// One embedded player in `host`. onState gets 'playing', 'ended' or 'error'.
function embed(host, id, { muted }, onState) {
  const params = new URLSearchParams({
    autoplay: 1, mute: muted ? 1 : 0, controls: 0, disablekb: 1, fs: 0,
    iv_load_policy: 3, rel: 0, playsinline: 1, enablejsapi: 1,
  });
  const frame = el('iframe', {
    class: 'trailer-frame', src: `${EMBED}${id}?${params}`,
    allow: 'autoplay; encrypted-media', tabindex: '-1', title: 'Trailer',
    inert: '', // never takes the remote's keys
  });
  const send = (msg) => frame.contentWindow?.postMessage(JSON.stringify({ ...msg, id: 1, channel: 'widget' }), '*');
  let state = null;
  let listen = null;
  function onMessage(e) {
    if (e.source !== frame.contentWindow) return;
    clearInterval(listen);
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    const ps = data.event === 'onStateChange' ? data.info : data.info?.playerState;
    const next = data.event === 'onError' ? 'error' : ps === 1 ? 'playing' : ps === 0 ? 'ended' : null;
    if (next && next !== state) { state = next; onState(next); }
  }
  window.addEventListener('message', onMessage);
  // The player only reports to a page that says it is listening, and only
  // once its script is up, so keep asking until it answers.
  frame.addEventListener('load', () => {
    send({ event: 'listening' });
    listen = setInterval(() => send({ event: 'listening' }), 500);
  });
  host.prepend(frame); // under anything else in host
  return {
    // Silence now; the frame goes once its fade-out is over.
    remove() {
      clearInterval(listen);
      window.removeEventListener('message', onMessage);
      send({ event: 'command', func: 'mute', args: [] });
      setTimeout(() => frame.remove(), FADE_MS);
    },
  };
}

// Plays the first of `ids` that works in `host`; host gets .on while playing.
// Returns { stop }.
function play(host, ids, { onEnd }) {
  const muted = Storage.getSettings().trailerPreviews === 'muted';
  let player = null;
  let giveUp = null;
  let stopped = false;
  function next(i) {
    if (i >= ids.length) { onEnd(); return; }
    clearTimeout(giveUp);
    giveUp = setTimeout(onEnd, START_TIMEOUT_MS);
    player = embed(host, ids[i], { muted }, (state) => {
      if (stopped) return;
      if (state === 'playing') { clearTimeout(giveUp); host.classList.add('on'); }
      else if (state === 'ended') onEnd();
      else { player.remove(); next(i + 1); } // embedding disabled, removed, …
    });
  }
  next(0);
  return {
    stop() {
      stopped = true;
      clearTimeout(giveUp);
      host.classList.remove('on');
      player?.remove();
    },
  };
}

// Full screen: the trailer behind the title's name, over everything but
// dialogs and the player.
function stage(meta, ids) {
  const node = el('div', { class: 'trailer-stage' },
    el('div', { class: 'trailer-scrim' }),
    el('div', { class: 'trailer-info' },
      titleArt(meta),
      factsRow(meta),
      el('div', { class: 'trailer-desc', text: meta.description || '' })));
  document.getElementById('screens').after(node);
  const playback = play(node, ids, { onEnd: () => { if (active?.node === node) stopActive(); } });
  return {
    node,
    // Covering the screen once it plays; until then it is invisible.
    covers: () => node.classList.contains('on'),
    keeps: () => false,
    stop() {
      playback.stop();
      setTimeout(() => node.remove(), FADE_MS);
    },
  };
}

// Watch the cards in `root`. inline(card) may return { host, keeps } to play
// in place: `host` holds the video and keeps(el) says which focus moves leave
// it playing. Otherwise the trailer plays full screen.
export function trailerPreviews(root, { inline } = {}) {
  let timer = null;
  let pending = null;

  function cancel() {
    clearTimeout(timer);
    timer = null;
    pending = null;
  }

  function schedule(card) {
    cancel();
    if (Storage.getSettings().trailerPreviews === 'off') return;
    pending = card;
    timer = setTimeout(() => start(card), DWELL_MS);
  }

  async function start(card) {
    const meta = card._meta;
    const type = meta.type || card._type;
    // Catalog entries rarely list trailers; the full meta does (cached).
    const full = { ...meta, ...(await cachedMeta(type, meta.id)), type };
    const ids = trailerIds(full);
    // Still resting here, and nothing (dialog, player) on top of the screen?
    if (pending !== card || document.activeElement !== card || Nav.scopeDepth() || !ids.length) return;
    pending = null;
    stopActive();
    const spot = inline?.(card);
    if (spot) {
      const playback = play(spot.host, ids, { onEnd: () => { if (active?.playback === playback) stopActive(); } });
      active = { playback, covers: () => false, keeps: spot.keeps, stop: () => playback.stop() };
    } else {
      active = stage(full, ids);
    }
  }

  function onFocus(e) {
    if (!root.isConnected) { detach(); return; }
    if (active?.keeps(e.target)) return;
    stopActive();
    const card = root.contains(e.target) && e.target.closest?.('.meta-card');
    if (card) schedule(card);
    else cancel();
  }

  function onKey(e) {
    if (!root.isConnected) { detach(); return false; }
    // A press that leaves focus put (end of a row) restarts the wait.
    if (pending) schedule(pending);
    if (!active?.covers()) return false; // focus moves decide
    stopActive();
    // The screen was hidden: the first press only brings it back, except
    // OK, which also opens the title.
    return !Nav.isEnterKey(e.key);
  }

  function onBlur() {
    cancel();
    stopActive();
  }

  function detach() {
    cancel();
    stopActive();
    document.removeEventListener('focusin', onFocus);
    Nav.popKeyHandler(onKey);
    window.removeEventListener('blur', onBlur);
    offWindowBlur?.();
  }

  document.addEventListener('focusin', onFocus);
  Nav.pushKeyHandler(onKey);
  // In the native shell the page keeps DOM focus when the window loses it.
  window.addEventListener('blur', onBlur);
  const offWindowBlur = window.shell?.onWindowBlur?.(onBlur);
}
