// Trailers. Resting on a title on Home for a few seconds plays its YouTube
// trailer in the hero's backdrop while the rows stay usable; the Trailer
// buttons (Home's hero, Discover) play it full screen until the next key.
//
// YouTube's embedded player does the decoding. It is only revealed once it
// reports that it is playing, so loading spinners, ads gates and "video
// unavailable" pages never show: the artwork just stays.

import { el, titleArt, factsRow, toast } from './ui.js';
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

// Plays the first of `ids` that works in `host`; host gets .on while playing
// and onPlay() runs when it starts. onEnd(played) runs when it finishes, or
// with false when none would play. Returns { stop }.
function play(host, ids, { muted = false, onEnd, onPlay }) {
  let player = null;
  let giveUp = null;
  let stopped = false;
  let played = false;
  const end = () => onEnd(played);
  function next(i) {
    if (i >= ids.length) { end(); return; }
    clearTimeout(giveUp);
    giveUp = setTimeout(end, START_TIMEOUT_MS);
    player = embed(host, ids[i], { muted }, (state) => {
      if (stopped) return;
      if (state === 'playing') { played = true; clearTimeout(giveUp); host.classList.add('on'); onPlay?.(); }
      else if (state === 'ended') end();
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

// The Trailer buttons (Home's hero, Discover): the trailer full screen,
// behind the title's name, over everything but dialogs and the player. Any
// key closes it, and focus stays on the button. Returns false when the title
// lists no trailer.
export function playTrailer(meta) {
  const ids = trailerIds(meta);
  if (!ids.length) return false;
  stopActive();
  const node = el('div', { class: 'trailer-stage' },
    el('div', { class: 'trailer-scrim' }),
    el('div', { class: 'trailer-info' },
      titleArt(meta),
      factsRow(meta),
      el('div', { class: 'trailer-desc', text: meta.description || '' })));
  document.getElementById('screens').after(node);
  const self = {
    keeps: () => false,
    stop() {
      playback.stop();
      Nav.popKeyHandler(onKey);
      window.removeEventListener('blur', close);
      offWindowBlur?.();
      setTimeout(() => node.remove(), FADE_MS);
    },
  };
  const close = () => { if (active === self) stopActive(); };
  // Until it plays the screen is still in view, so keys go on to it.
  const onKey = (e) => {
    const covering = node.classList.contains('on');
    // a held OK (the press that opened it) repeats; one press = one action
    if (e.repeat && Nav.isEnterKey(e.key)) return true;
    close();
    return covering;
  };
  const playback = play(node, ids, {
    onEnd: (played) => {
      if (!played && active === self) toast('This trailer can’t be played here');
      close();
    },
  });
  Nav.pushKeyHandler(onKey);
  window.addEventListener('blur', close);
  const offWindowBlur = window.shell?.onWindowBlur?.(close);
  active = self;
  return true;
}

// Watch the cards in `root`: resting on one plays its trailer in place when
// inline(card) returns { host, keeps, onPlay, onStop }. `host` holds the
// video, keeps(el) says which focus moves leave it playing, and onPlay/onStop
// run when it starts showing and when it ends.
export function trailerPreviews(root, { inline }) {
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
    const ids = trailerIds({ ...meta, ...(await cachedMeta(type, meta.id)) });
    // Still resting here, and nothing (dialog, player) on top of the screen?
    if (pending !== card || document.activeElement !== card || Nav.scopeDepth() || !ids.length) return;
    pending = null;
    const spot = inline(card);
    if (!spot) return;
    stopActive();
    const playback = play(spot.host, ids, {
      muted: Storage.getSettings().trailerPreviews === 'muted',
      onPlay: spot.onPlay,
      onEnd: () => { if (active?.playback === playback) stopActive(); },
    });
    active = {
      playback,
      keeps: spot.keeps,
      stop() { playback.stop(); spot.onStop?.(); },
    };
  }

  function onFocus(e) {
    if (!root.isConnected) { detach(); return; }
    if (active?.keeps(e.target)) return;
    stopActive();
    const card = root.contains(e.target) && e.target.closest?.('.meta-card');
    if (card) schedule(card);
    else cancel();
  }

  function onKey() {
    if (!root.isConnected) { detach(); return false; }
    // A press that leaves focus put (end of a row) restarts the wait.
    if (pending) schedule(pending);
    return false;
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
