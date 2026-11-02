// Stream selection flow: fetch streams for a (meta, video), show a picker,
// open the player. Also powers "Next episode" (binge groups auto-pick the
// matching stream from the same addon).

import { el, toast, openModal } from './ui.js';
import { Nav } from './nav.js';
import { getStreams, resolveStreamUrl, streamUnplayableReason } from './addons.js';
import { openPlayer } from './player.js';
import { Storage } from './storage.js';

function videoLabel(video) {
  if (!video) return null;
  if (video.season !== undefined && (video.episode !== undefined || video.number !== undefined)) {
    const ep = video.episode !== undefined ? video.episode : video.number;
    return `S${String(video.season).padStart(2, '0')}E${String(ep).padStart(2, '0')}${video.title || video.name ? ' — ' + (video.title || video.name) : ''}`;
  }
  return video.title || video.name || video.id;
}

function nextVideoOf(meta, video) {
  if (!meta?.videos || !video) return null;
  const idx = meta.videos.findIndex((v) => v.id === video.id);
  if (idx < 0 || idx + 1 >= meta.videos.length) return null;
  return meta.videos[idx + 1];
}

function streamLabel(addon, stream) {
  const name = stream.name || addon.manifest.name;
  const desc = stream.description || stream.title || '';
  return { name, desc };
}

// Only one search/pick at a time. Pressing OK again while streams are still
// loading (AIOStreams can take many seconds) must not start a second search
// whose dialogs would later pop up over the video.
let activeFlow = null;

// Entry point. meta required; video required for series (null for movies).
export async function playFlow(meta, video, { resumeTime, preferBinge } = {}) {
  if (activeFlow) return;
  const flow = (activeFlow = { cancelled: false, ctrl: new AbortController() });
  const finish = () => { if (activeFlow === flow) activeFlow = null; };
  const cancel = () => { flow.cancelled = true; flow.ctrl.abort(); finish(); };

  const targetId = video ? video.id : meta.id;
  const loading = openLoadingModal('Finding streams…', cancel);
  let result;
  try {
    result = await getStreams(meta.type, targetId, { signal: flow.ctrl.signal });
  } catch (e) {
    if (flow.cancelled) return;
    loading.close();
    finish();
    toast('Could not fetch streams: ' + e.message, 'error');
    return;
  }
  if (flow.cancelled) return; // user backed out while we were waiting
  loading.close();
  const { streams, errors } = result;
  errors.forEach(({ addon }) => toast(`${addon.manifest.name}: stream request failed`, 'error'));

  if (!streams.length) {
    finish();
    toast('No streams found. Install a streams addon (e.g. AIOStreams) in Add-ons.', 'error', 6000);
    return;
  }

  // Binge continue: if we know the previous stream's bingeGroup, auto-pick.
  if (preferBinge) {
    const match = streams.find(({ stream }) =>
      stream.behaviorHints?.bingeGroup && stream.behaviorHints.bingeGroup === preferBinge && resolveStreamUrl(stream));
    if (match) {
      finish();
      startPlayback(meta, video, match, { resumeTime });
      return;
    }
  }

  pickStream(meta, video, streams, { resumeTime, onDone: finish });
}

// "Finding streams…": focus moves into the dialog itself (not a button), so
// extra OK presses while waiting do nothing instead of re-activating the Play
// button behind it. Back cancels; Cancel is one arrow press away.
function openLoadingModal(text, onCancel) {
  const started = Date.now();
  const status = el('span', { text: ` ${text}` });
  const cancelBtn = el('button', { class: 'focusable btn', text: 'Cancel' });
  const modal = el('div', { class: 'modal loading-modal' },
    el('div', { class: 'modal-title' }, el('span', { class: 'spinner-inline' }), status),
    el('div', { class: 'btn-row' }, cancelBtn));
  let userClosed = true;
  const handle = openModal(modal, { onClose: () => { clearInterval(tick); if (userClosed) onCancel(); } });
  cancelBtn.addEventListener('click', () => handle.close());
  modal.setAttribute('tabindex', '-1');
  modal.focus({ preventScroll: true });
  // Slow aggregators: show that we are still waiting, and for how long.
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    if (s >= 3) status.textContent = ` ${text} ${s}s`;
  }, 1000);
  return {
    close() { userClosed = false; handle.close(); },
  };
}

function pickStream(meta, video, streams, { resumeTime, onDone } = {}) {
  const body = el('div', { class: 'modal-body' });
  const label = videoLabel(video);
  const modal = el('div', { class: 'modal', style: 'min-width: 900px' },
    el('div', { class: 'modal-title', text: `Streams — ${meta.name}${label ? ' · ' + label : ''}` }),
    body);
  const handle = openModal(modal, { onClose: () => onDone && onDone() });

  streams.forEach((entry) => {
    const { addon, stream } = entry;
    const { name, desc } = streamLabel(addon, stream);
    const reason = streamUnplayableReason(stream);
    const item = el('button', { class: 'focusable list-item' },
      el('div', { class: 'li-title', text: name }),
      el('div', { class: 'li-sub', text: (desc || '') + (reason ? `\n⚠ ${reason}` : '') }));
    item.addEventListener('click', () => {
      if (streamUnplayableReason(stream)) {
        toast(streamUnplayableReason(stream), 'error', 5000);
        return;
      }
      handle.close();
      startPlayback(meta, video, entry, { resumeTime });
    });
    body.append(item);
  });
  Nav.focusFirst(modal);
}

function startPlayback(meta, video, entry, { resumeTime } = {}) {
  const { addon, stream } = entry;
  const url = resolveStreamUrl(stream);
  if (!url) {
    toast('This stream has no playable URL', 'error');
    return;
  }
  const next = nextVideoOf(meta, video);
  const binge = stream.behaviorHints?.bingeGroup || null;
  openPlayer({
    url,
    meta,
    videoId: video ? video.id : null,
    videoLabel: videoLabel(video),
    streamTitle: stream.name || addon.manifest.name,
    resumeTime,
    nextVideo: next,
    onNext: (nextVideo) => playFlow(meta, nextVideo, { preferBinge: binge }),
  });
}

// Resume helper used by Continue Watching rows.
export async function resumeFlow(meta, entry) {
  let video = null;
  if (entry.videoId && meta.videos) {
    video = meta.videos.find((v) => v.id === entry.videoId) || null;
  }
  const finished = entry.duration && entry.time >= entry.duration * 0.95;
  if (finished && video) {
    const next = nextVideoOf(meta, video);
    if (next) { await playFlow(meta, next); return; }
  }
  await playFlow(meta, video, { resumeTime: finished ? 0 : entry.time });
}

export { videoLabel, nextVideoOf };
