// Video player with a YouTube-TV-style, remote-first overlay.
//
// Remote model while watching:
//   OK          -> play/pause (flash icon), or activate focused control
//   Left/Right  -> scrub (accelerates with repeated presses), commits after a beat
//   Up/Down     -> reveal the control overlay (progress bar + button row)
//   Back        -> hide overlay; if hidden, stop playback and return
//   Media keys  -> play/pause/stop/seek from anywhere

import { Nav } from './nav.js';
import { Storage } from './storage.js';
import { el, toast, formatTime, pickerModal, hasOpenModal } from './ui.js';
import { getSubtitles } from './addons.js';

const SEEK_COMMIT_MS = 650;
const AUTOHIDE_MS = 5000;

let session = null; // active playback session or null

export function isPlayerOpen() {
  return !!session;
}

// ctx: { url, meta, videoId, videoLabel, streamTitle, resumeTime, nextVideo, onNext }
export function openPlayer(ctx) {
  if (session) closePlayer();
  const root = document.getElementById('player-root');
  root.innerHTML = '';
  root.classList.remove('hidden');
  root.classList.add('loading');

  const video = el('video', { autoplay: '', preload: 'auto' });
  video.crossOrigin = 'anonymous';

  // ---- overlay DOM ----
  const title = ctx.meta?.name || 'Playing';
  const sub = [ctx.videoLabel, ctx.streamTitle].filter(Boolean).join('  ·  ');
  const seekPreview = el('div', { class: 'seek-preview' });
  const played = el('div', { class: 'played' });
  const buffered = el('div', { class: 'buffered' });
  const thumb = el('div', { class: 'thumb' });
  const seekBar = el('div', { class: 'focusable seek-bar' }, buffered, played, thumb);
  const timeNow = el('div', { class: 'seek-time', text: '0:00' });
  const timeTotal = el('div', { class: 'seek-time', text: '--:--' });
  const buttons = el('div', { class: 'player-buttons' });
  const flash = el('div', { class: 'player-flash' });
  const overlay = el(
    'div',
    { class: 'player-overlay' },
    el('div', { class: 'player-top' },
      el('div', { class: 'pl-title', text: title }),
      sub ? el('div', { class: 'pl-sub', text: sub }) : null),
    el('div', { class: 'player-bottom' },
      seekPreview,
      el('div', { class: 'seek-line' }, timeNow, seekBar, timeTotal),
      buttons),
    flash,
    el('div', { class: 'player-loading' })
  );
  root.append(video, overlay);

  const s = (session = {
    ctx, root, video, seekBar, buttons, hls: null,
    mode: 'hidden',            // hidden | seek | controls
    pendingSeek: null,         // target seconds while scrubbing
    seekStreak: 0,
    lastSeekPress: 0,
    seekCommitTimer: null,
    autohideTimer: null,
    saveTimer: null,
    addonSubs: [],
    subTrackEl: null,
    activeSubId: 'off',
    speed: 1,
    prevFocus: document.activeElement,
    scoped: false,
  });

  // ---- control buttons ----
  function button(icon, label, onClick, attrs = {}) {
    const b = el('button', { class: 'focusable player-btn', ...attrs },
      el('div', { class: 'icon', text: icon }),
      el('div', { class: 'label', text: label }));
    b.addEventListener('click', onClick);
    buttons.append(b);
    return b;
  }
  const playBtn = button('⏸', 'Pause', () => togglePlay(), { 'data-nav-default': '' });
  s.playBtn = playBtn;
  button('🗨', 'Subtitles', () => subtitleMenu());
  button('🔊', 'Audio', () => audioMenu());
  button('⏩', 'Speed', () => speedMenu());
  if (ctx.nextVideo && ctx.onNext) {
    button('⏭', 'Next episode', () => {
      const next = ctx.nextVideo;
      closePlayer();
      ctx.onNext(next);
    });
  }

  // ---- media source ----
  const isHls = /\.m3u8(\?|$)/i.test(ctx.url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    s.hls = new window.Hls();
    s.hls.loadSource(ctx.url);
    s.hls.attachMedia(video);
    s.hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) fail(`Stream error (${data.type})`);
    });
  } else {
    video.src = ctx.url;
  }

  // ---- video events ----
  video.addEventListener('loadedmetadata', () => {
    if (ctx.resumeTime && ctx.resumeTime > 5 && (!video.duration || ctx.resumeTime < video.duration - 10)) {
      video.currentTime = ctx.resumeTime;
    }
    applySubtitleSize();
    updateBar();
  });
  video.addEventListener('canplay', () => root.classList.remove('loading'));
  video.addEventListener('waiting', () => root.classList.add('loading'));
  video.addEventListener('playing', () => { root.classList.remove('loading'); refreshPlayButton(); });
  video.addEventListener('pause', refreshPlayButton);
  video.addEventListener('timeupdate', () => { if (s.pendingSeek === null) updateBar(); });
  video.addEventListener('ended', () => {
    saveProgress();
    if (ctx.nextVideo && ctx.onNext) {
      const next = ctx.nextVideo;
      closePlayer();
      ctx.onNext(next);
    } else {
      closePlayer();
    }
  });
  video.addEventListener('error', () => fail('This stream could not be played'));

  function fail(msg) {
    toast(msg, 'error');
    closePlayer();
  }

  // ---- overlay state machine ----
  function setMode(mode) {
    if (s.mode === 'controls' && mode !== 'controls' && s.scoped) {
      Nav.popScope();
      s.scoped = false;
    }
    s.mode = mode;
    root.classList.toggle('show-seek', mode === 'seek');
    root.classList.toggle('show-controls', mode === 'controls');
    if (mode === 'controls' && !s.scoped) {
      Nav.pushScope(root);
      s.scoped = true;
      refreshPlayButton();
      Nav.focus(playBtn);
    }
    bumpAutohide();
  }
  s.setMode = setMode;

  function bumpAutohide() {
    clearTimeout(s.autohideTimer);
    if (s.mode !== 'hidden') {
      s.autohideTimer = setTimeout(() => {
        if (hasOpenModal()) { bumpAutohide(); return; }
        if (s.pendingSeek !== null) { bumpAutohide(); return; }
        setMode('hidden');
      }, AUTOHIDE_MS);
    }
  }

  function refreshPlayButton() {
    const paused = video.paused;
    playBtn.querySelector('.icon').textContent = paused ? '▶' : '⏸';
    playBtn.querySelector('.label').textContent = paused ? 'Play' : 'Pause';
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    showFlash(video.paused ? '⏸' : '▶');
    refreshPlayButton();
    bumpAutohide();
  }
  s.togglePlay = togglePlay;

  function showFlash(icon) {
    flash.textContent = icon;
    flash.classList.remove('on');
    void flash.offsetWidth; // restart animation
    flash.classList.add('on');
  }

  // ---- seeking ----
  function updateBar(previewTime) {
    const dur = video.duration || 0;
    const t = previewTime !== undefined ? previewTime : video.currentTime;
    const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
    played.style.width = pct + '%';
    thumb.style.left = pct + '%';
    timeNow.textContent = formatTime(t);
    timeTotal.textContent = dur > 0 ? formatTime(dur) : '--:--';
    try {
      if (video.buffered.length && dur > 0) {
        buffered.style.width = Math.min(100, (video.buffered.end(video.buffered.length - 1) / dur) * 100) + '%';
      }
    } catch { /* ignore */ }
  }

  function scrub(dirSign) {
    const now = Date.now();
    s.seekStreak = now - s.lastSeekPress < 550 ? s.seekStreak + 1 : 0;
    s.lastSeekPress = now;
    const step = s.seekStreak < 4 ? 10 : s.seekStreak < 10 ? 30 : s.seekStreak < 18 ? 60 : 120;
    const base = s.pendingSeek !== null ? s.pendingSeek : video.currentTime;
    const dur = video.duration || Infinity;
    s.pendingSeek = Math.max(0, Math.min(isFinite(dur) ? dur - 1 : base + dirSign * step, base + dirSign * step));
    if (s.mode === 'hidden') setMode('seek');
    seekPreview.textContent = `${dirSign > 0 ? '⏩' : '⏪'} ${formatTime(s.pendingSeek)}`;
    updateBar(s.pendingSeek);
    bumpAutohide();
    clearTimeout(s.seekCommitTimer);
    s.seekCommitTimer = setTimeout(commitSeek, SEEK_COMMIT_MS);
  }
  s.scrub = scrub;

  function commitSeek() {
    if (s.pendingSeek === null) return;
    video.currentTime = s.pendingSeek;
    s.pendingSeek = null;
    s.seekStreak = 0;
    seekPreview.textContent = '';
    if (s.mode === 'seek') {
      // let the seek bar linger a moment, then hide
      setTimeout(() => { if (s.mode === 'seek' && s.pendingSeek === null) setMode('hidden'); }, 900);
    }
  }
  seekBar.addEventListener('click', () => togglePlay());

  // ---- menus ----
  async function subtitleMenu() {
    const options = [{ label: 'Off', value: 'off' }];
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i];
      if (s.subTrackEl && s.subTrackEl.track === tt) continue; // our own addon track, listed below
      options.push({ label: `${tt.label || tt.language || 'Track ' + (i + 1)} (embedded)`, value: `embedded:${i}` });
    }
    s.addonSubs.forEach((sub, i) => {
      options.push({ label: `${(sub.lang || '?').toUpperCase()} — ${sub.addonName}`, value: `addon:${i}`, sub: sub.id });
    });
    if (options.length === 1) options.push({ label: 'No subtitles found', value: 'off' });
    const chosen = await pickerModal('Subtitles', options, { selectedValue: s.activeSubId });
    if (chosen !== null) await selectSubtitle(chosen);
    bumpAutohide();
  }

  async function selectSubtitle(value) {
    // turn everything off first
    for (let i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = 'disabled';
    s.activeSubId = value;
    if (value === 'off') return;
    if (value.startsWith('embedded:')) {
      const idx = Number(value.split(':')[1]);
      if (video.textTracks[idx]) video.textTracks[idx].mode = 'showing';
      return;
    }
    if (value.startsWith('addon:')) {
      const sub = s.addonSubs[Number(value.split(':')[1])];
      try {
        const vtt = await loadSubtitleAsVtt(sub.url);
        if (s.subTrackEl) s.subTrackEl.remove();
        const blobUrl = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        s.subTrackEl = el('track', { kind: 'subtitles', label: sub.lang || 'sub', srclang: sub.lang || '' });
        s.subTrackEl.src = blobUrl;
        video.append(s.subTrackEl);
        s.subTrackEl.track.mode = 'showing';
      } catch (e) {
        console.error(e);
        toast('Could not load that subtitle', 'error');
        s.activeSubId = 'off';
      }
    }
  }

  async function audioMenu() {
    let options = [];
    if (s.hls && s.hls.audioTracks && s.hls.audioTracks.length > 1) {
      options = s.hls.audioTracks.map((t, i) => ({ label: t.name || t.lang || `Track ${i + 1}`, value: i }));
      const chosen = await pickerModal('Audio track', options, { selectedValue: s.hls.audioTrack });
      if (chosen !== null) s.hls.audioTrack = chosen;
    } else if (video.audioTracks && video.audioTracks.length > 1) {
      for (let i = 0; i < video.audioTracks.length; i++) {
        const t = video.audioTracks[i];
        options.push({ label: t.label || t.language || `Track ${i + 1}`, value: i });
      }
      let current = 0;
      for (let i = 0; i < video.audioTracks.length; i++) if (video.audioTracks[i].enabled) current = i;
      const chosen = await pickerModal('Audio track', options, { selectedValue: current });
      if (chosen !== null) {
        for (let i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = i === chosen;
      }
    } else {
      await pickerModal('Audio track', [{ label: 'Default (no alternate tracks available)', value: 0 }], { selectedValue: 0 });
    }
    bumpAutohide();
  }

  async function speedMenu() {
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    const chosen = await pickerModal('Playback speed', speeds.map((v) => ({ label: v === 1 ? 'Normal' : `${v}×`, value: v })), { selectedValue: s.speed });
    if (chosen !== null) {
      s.speed = chosen;
      video.playbackRate = chosen;
    }
    bumpAutohide();
  }

  function applySubtitleSize() {
    const size = Storage.getSettings().subtitleSize;
    document.documentElement.style.setProperty('--cue-size', size + '%');
  }

  // ---- addon subtitles (background fetch) ----
  if (ctx.meta) {
    getSubtitles(ctx.meta.type, ctx.videoId || ctx.meta.id).then((subs) => {
      s.addonSubs = dedupeSubs(subs).slice(0, 40);
    }).catch(() => {});
  }

  // ---- progress persistence ----
  function saveProgress() {
    if (!ctx.meta || !video.duration) return;
    Storage.saveProgress({
      type: ctx.meta.type,
      id: ctx.meta.id,
      name: ctx.meta.name,
      poster: ctx.meta.poster,
      videoId: ctx.videoId || null,
      videoLabel: ctx.videoLabel || null,
      nextVideoId: ctx.nextVideo?.id || null,
      time: video.currentTime,
      duration: video.duration,
    });
  }
  s.saveProgress = saveProgress;
  s.saveTimer = setInterval(saveProgress, 5000);

  // ---- keys ----
  s.keyHandler = makeKeyHandler(s);
  Nav.pushKeyHandler(s.keyHandler);
  setMode('hidden');
  video.play().catch(() => {});
}

function dedupeSubs(subs) {
  const seen = new Set();
  return subs.filter((s) => {
    const k = s.url;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function makeKeyHandler(s) {
  return (e) => {
    if (!session) return false;
    const k = e.key;

    // Media keys work regardless of overlay/modal state.
    if (k === 'MediaPlayPause' || k === 'MediaPlay' || k === 'MediaPause') { s.togglePlay(); return true; }
    if (k === 'MediaStop') { closePlayer(); return true; }
    if (k === 'MediaFastForward' || k === 'MediaTrackNext') { s.scrub(1); return true; }
    if (k === 'MediaRewind' || k === 'MediaTrackPrevious') { s.scrub(-1); return true; }

    // A modal (subtitle picker etc.) is open above us: let Nav drive it.
    if (hasOpenModal()) return false;

    if (s.mode === 'hidden' || s.mode === 'seek') {
      if (k === 'ArrowLeft') { s.scrub(-1); return true; }
      if (k === 'ArrowRight') { s.scrub(1); return true; }
      if (k === 'ArrowUp' || k === 'ArrowDown') { s.setMode('controls'); return true; }
      if (Nav.isEnterKey(k)) { s.togglePlay(); return true; }
      if (Nav.isBackKey(k)) {
        if (s.mode === 'seek') { s.setMode('hidden'); return true; }
        closePlayer();
        return true;
      }
      return true; // swallow everything else while lean-back
    }

    // controls mode
    if (Nav.isBackKey(k)) { s.setMode('hidden'); return true; }
    if (document.activeElement === s.seekBar) {
      if (k === 'ArrowLeft') { s.scrub(-1); return true; }
      if (k === 'ArrowRight') { s.scrub(1); return true; }
    }
    // otherwise let Nav move focus between overlay controls
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k) || Nav.isEnterKey(k)) {
      clearTimeout(s.autohideTimer);
      s.autohideTimer = setTimeout(() => { if (!hasOpenModal() && s.pendingSeek === null) s.setMode('hidden'); }, AUTOHIDE_MS);
      return false; // Nav handles the movement/activation
    }
    return true;
  };
}

export function closePlayer() {
  const s = session;
  if (!s) return;
  session = null;
  try { s.saveProgress(); } catch { /* ignore */ }
  clearInterval(s.saveTimer);
  clearTimeout(s.autohideTimer);
  clearTimeout(s.seekCommitTimer);
  Nav.popKeyHandler(s.keyHandler);
  if (s.scoped) Nav.popScope();
  if (s.hls) { try { s.hls.destroy(); } catch { /* ignore */ } }
  s.video.pause();
  s.video.removeAttribute('src');
  try { s.video.load(); } catch { /* ignore */ }
  s.root.innerHTML = '';
  s.root.classList.add('hidden');
  s.root.classList.remove('show-seek', 'show-controls', 'loading');
  if (s.prevFocus && s.prevFocus.isConnected) Nav.focus(s.prevFocus);
  document.dispatchEvent(new CustomEvent('player:closed'));
}

// Fetch an addon subtitle (usually .srt) and return WebVTT text.
async function loadSubtitleAsVtt(url) {
  let text;
  if (window.shell?.proxyFetch) {
    const res = await window.shell.proxyFetch(url);
    if (!res.ok) throw new Error(`subtitle HTTP ${res.status}`);
    text = res.body;
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`subtitle HTTP ${res.status}`);
    text = await res.text();
  }
  return srtToVtt(text);
}

export function srtToVtt(input) {
  const t = input.replace(/^﻿/, '').trim();
  if (/^WEBVTT/.test(t)) return t;
  const body = t
    .replace(/\r+/g, '')
    // 00:00:01,000 --> 00:00:02,500  =>  00:00:01.000 --> 00:00:02.500
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}
