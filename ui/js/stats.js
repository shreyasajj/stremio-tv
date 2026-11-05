// "Stats for nerds": a live panel over the video showing what the stream,
// the network, the decoder and the machine are doing, plus a one-line
// verdict on why playback is (or might start) buffering.
//
// With mpv (native shell) everything comes from mpv's own properties and
// shell.systemStats(); in a plain browser (UI tests) the <video> element's
// few numbers stand in.

import { el } from './ui.js';
import { audioOutputSummary } from './mpv-video.js';

const POLL_MS = 1000;
const HISTORY = 60;          // samples kept for the sparklines (1 per second)
const WINDOW = 5;            // seconds over which frame drops count as "now"
const LOW_BUFFER_S = 3;

const PROPS = [
  'stream-open-filename', 'file-format', 'demuxer-via-network',
  'video-format', 'video-codec', 'video-params', 'hwdec', 'hwdec-current', 'hwdec-interop',
  'container-fps', 'estimated-vf-fps', 'display-fps', 'osd-dimensions', 'current-vo',
  'frame-drop-count', 'decoder-frame-drop-count', 'vo-delayed-frame-count', 'avsync',
  'video-bitrate', 'audio-bitrate', 'audio-codec-name', 'audio-params',
  'demuxer-cache-state', 'demuxer-cache-duration', 'cache-speed', 'paused-for-cache', 'cache-buffering-state',
  'eof-reached',
];

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const mbps = (bitsPerSec) => (bitsPerSec >= 1e6 ? `${(bitsPerSec / 1e6).toFixed(1)} Mbps` : `${Math.round(bitsPerSec / 1e3)} Kbps`);
const mib = (bytes) => `${(bytes / 1048576).toFixed(0)} MiB`;
const pct = (v) => `${Math.round(v)}%`;

function host(url) {
  try { return new URL(url).host; } catch { return url ? 'local file' : ''; }
}

// ---- verdict: where the bottleneck is ----

// Returns { level: 'ok' | 'warn' | 'bad', text }.
export function diagnose(d) {
  const issues = [];
  if (d.decoderDrops > 0) {
    issues.push({
      level: 'bad',
      text: d.hw
        ? `Decoder: the GPU decoder (${d.hwName}) is dropping frames — it can't keep up with ${d.res}`
        : `Decoder: software decoding ${d.codec} ${d.res} on the CPU can't keep up${d.cpu != null ? ` (CPU ${pct(d.cpu)})` : ''} — no hardware decoder is in use`,
    });
  } else if (!d.hw && d.cpu != null && d.cpu > 85) {
    issues.push({ level: 'warn', text: `Machine: CPU at ${pct(d.cpu)} with software decoding — close to its limit` });
  }
  if (d.voDrops > 0) {
    issues.push({ level: 'bad', text: 'Rendering: frames are dropped after decoding — the GPU/display can\'t keep up' });
  }
  const starving = d.buffering || (d.bufferS != null && d.bufferS < LOW_BUFFER_S && !d.eof && !d.cacheFull);
  if (starving) {
    if (d.netBps === 0) {
      issues.push({ level: 'bad', text: 'Network: no data arriving — the server or connection has stalled' });
    } else if (d.netBps != null && d.needBps && d.netBps < d.needBps) {
      issues.push({ level: 'bad', text: `Network: downloading at ${mbps(d.netBps)}, the stream needs ${mbps(d.needBps)} — the connection or server is too slow` });
    } else if (d.buffering) {
      issues.push({ level: 'warn', text: 'Network: refilling the buffer' + (d.netBps ? ` at ${mbps(d.netBps)}` : '') });
    } else {
      issues.push({ level: 'warn', text: `Network: buffer is low (${d.bufferS.toFixed(1)} s)` });
    }
  }
  if (issues.length) {
    const worst = issues.some((i) => i.level === 'bad') ? 'bad' : 'warn';
    return { level: worst, text: issues.map((i) => i.text).join('\n') };
  }
  const parts = ['Playing smoothly'];
  if (d.bufferS != null) parts.push(`${d.bufferS.toFixed(0)} s buffered`);
  if (d.cacheFull) parts.push('buffer full');
  else if (d.netBps && d.needBps) parts.push(`network ${(d.netBps / d.needBps).toFixed(1)}× the bitrate`);
  return { level: 'ok', text: parts.join(' · ') };
}

// ---- panel ----

export function createStatsPanel(video) {
  const rows = el('div', { class: 'stats-rows' });
  const verdict = el('div', { class: 'stats-verdict' });
  const netGraph = el('canvas', { class: 'stats-graph', width: 240, height: 34 });
  const bufGraph = el('canvas', { class: 'stats-graph', width: 240, height: 34 });
  const element = el('div', { class: 'stats-panel hidden' },
    el('div', { class: 'stats-head', text: 'Stats for nerds' }),
    verdict, rows);

  const history = { net: [], buf: [] };
  const drops = [];           // [{ dec, vo }] per sample, for the WINDOW delta
  let peakNet = 0;
  let timer = null;
  let busy = false;

  function push(arr, v, max = HISTORY) { arr.push(v); if (arr.length > max) arr.shift(); }

  function row(label, value, graph) {
    if (value === null || value === undefined || value === '') return null;
    return el('div', { class: 'stats-row' },
      el('span', { class: 'stats-label', text: label }),
      el('span', { class: 'stats-value' }, value, graph || null));
  }

  function drawGraph(canvas, values, color) {
    const ctx = canvas.getContext?.('2d');
    if (!ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1e-9, ...values);
    ctx.fillStyle = color;
    const bw = w / HISTORY;
    values.forEach((v, i) => {
      const bh = Math.max(1, (v / max) * (h - 2));
      ctx.fillRect(w - (values.length - i) * bw, h - bh, Math.max(1, bw - 1), bh);
    });
  }

  async function sampleNative() {
    const mpv = video.mpv;
    const [p, sys] = await Promise.all([
      mpv.getMany ? mpv.getMany(PROPS) : Promise.resolve({}),
      window.shell?.systemStats ? window.shell.systemStats() : Promise.resolve({}),
    ]);
    const vp = p['video-params'] || {};
    const cache = p['demuxer-cache-state'] || {};
    const hwName = p['hwdec-current'] && p['hwdec-current'] !== 'no' ? p['hwdec-current'] : '';
    const fps = num(p['estimated-vf-fps']) ?? num(p['container-fps']);
    const res = vp.w ? `${vp.w}×${vp.h}` : '';
    const codec = (p['video-format'] || '').toUpperCase();

    const decTotal = num(p['decoder-frame-drop-count']) ?? 0;
    const voTotal = num(p['frame-drop-count']) ?? 0;
    push(drops, { dec: decTotal, vo: voTotal }, WINDOW + 1);
    const decoderDrops = decTotal - drops[0].dec;
    const voDrops = voTotal - drops[0].vo;

    const rawRate = num(cache['raw-input-rate']) ?? num(p['cache-speed']);
    const netBps = rawRate != null ? rawRate * 8 : null;
    const cacheFull = !!cache.idle && !cache.underrun;
    const bufferS = num(cache['cache-duration']) ?? num(p['demuxer-cache-duration']);
    const needBps = (num(p['video-bitrate']) ?? 0) + (num(p['audio-bitrate']) ?? 0);
    if (netBps != null) { peakNet = Math.max(peakNet, netBps); push(history.net, netBps); }
    if (bufferS != null) push(history.buf, bufferS);

    const cpu = num(sys.cpu);
    const diag = diagnose({
      hw: !!hwName, hwName, codec, res, cpu,
      decoderDrops, voDrops, netBps, needBps, bufferS, cacheFull,
      buffering: !!p['paused-for-cache'], eof: !!p['eof-reached'] || !!cache.eof,
    });

    const color = [vp.primaries, vp.gamma].filter(Boolean).join(' / ');
    const hdr = /pq|hlg/i.test(vp.gamma || '') ? ' HDR' : '';
    const osd = p['osd-dimensions'] || {};
    const aParams = p['audio-params'] || {};
    const stalls = video.stalls || { count: 0, seconds: 0 };

    const decoder = hwName
      ? `Hardware — GPU (${hwName}${p['hwdec-interop'] ? `, interop ${p['hwdec-interop']}` : ''})`
      : `Software — CPU${p.hwdec && p.hwdec !== 'no' ? ` (asked for "${p.hwdec}": no hardware decoder for ${codec || 'this codec'}${vp.pixelformat ? ' ' + vp.pixelformat : ''} on this GPU/driver)` : ' (hardware decoding is off)'}`;

    const sysParts = [];
    if (cpu != null) sysParts.push(`CPU ${pct(cpu)} of ${sys.cores} cores`);
    if (num(sys.process) != null) sysParts.push(`app ${pct(sys.process)} of one core`);
    if (num(sys.gpu) != null) sysParts.push(`GPU ${pct(sys.gpu)} busy`);

    let conn;
    if (netBps == null) conn = p['demuxer-via-network'] === false ? 'local file' : '';
    else if (cacheFull) conn = `idle — buffer full (peak ${mbps(peakNet)})`;
    else conn = `${mbps(netBps)} (peak ${mbps(peakNet)})`;

    render(diag, [
      row('Source', [host(p['stream-open-filename']), p['file-format']].filter(Boolean).join(' · ')),
      row('Resolution', res && `${res}${fps ? `@${Number(fps.toFixed(3))}` : ''}${hdr}${num(p['display-fps']) ? ` → display ${p['display-fps'].toFixed(0)} Hz` : ''}${osd.w ? ` · viewport ${osd.w}×${osd.h}` : ''}`),
      row('Codec', [codec, vp.pixelformat, color].filter(Boolean).join(' · ')),
      row('Decoder', decoder),
      row('Frames dropped', `decoder ${decTotal} · render ${voTotal} · late ${num(p['vo-delayed-frame-count']) ?? 0}`),
      row('Bitrate', needBps ? `${mbps(needBps)} (video ${mbps(num(p['video-bitrate']) ?? 0)}, audio ${mbps(num(p['audio-bitrate']) ?? 0)})` : ''),
      row('Connection', conn, conn && netBps != null ? netGraph : null),
      row('Buffer health', bufferS != null ? `${bufferS.toFixed(1)} s${num(cache['fw-bytes']) ? ` · ${mib(cache['fw-bytes'])}` : ''}` : '', bufferS != null ? bufGraph : null),
      row('Stalls', `${stalls.count}${stalls.count ? ` (${stalls.seconds.toFixed(1)} s total)` : ''}${p['paused-for-cache'] ? ` · buffering ${num(p['cache-buffering-state']) ?? 0}%` : ''}`),
      row('A/V sync', num(p.avsync) != null ? `${(p.avsync * 1000).toFixed(0)} ms` : ''),
      row('Audio', [(p['audio-codec-name'] || '').toUpperCase(), aParams['hr-channels'], aParams.samplerate ? `${aParams.samplerate / 1000} kHz` : ''].filter(Boolean).join(' · ')),
      row('Audio out', audioOutputSummary(video).replace(/^Output: /, '')),
      row('Machine', sysParts.join(' · ')),
    ]);
    drawGraph(netGraph, history.net, '#7c5cff');
    drawGraph(bufGraph, history.buf, '#4fd08a');
  }

  function sampleHtml() {
    const q = video.getVideoPlaybackQuality?.() || {};
    let ahead = null;
    try {
      const b = video.buffered;
      if (b.length) ahead = b.end(b.length - 1) - video.currentTime;
    } catch { /* ignore */ }
    if (ahead != null) push(history.buf, ahead);
    render({ level: 'ok', text: 'Browser playback — limited stats' }, [
      row('Resolution', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : ''),
      row('Frames dropped', `${q.droppedVideoFrames ?? 0} of ${q.totalVideoFrames ?? 0}`),
      row('Buffer health', ahead != null ? `${ahead.toFixed(1)} s` : '', ahead != null ? bufGraph : null),
    ]);
    drawGraph(bufGraph, history.buf, '#4fd08a');
  }

  function render(diag, rowEls) {
    verdict.className = `stats-verdict ${diag.level}`;
    verdict.textContent = diag.text;
    rows.replaceChildren(...rowEls.filter(Boolean));
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      if (video.isNative) await sampleNative();
      else sampleHtml();
    } catch (e) {
      console.error('stats', e);
    } finally {
      busy = false;
    }
  }

  const panel = {
    element,
    get shown() { return !element.classList.contains('hidden'); },
    show(on) {
      element.classList.toggle('hidden', !on);
      clearInterval(timer);
      timer = null;
      if (on) { tick(); timer = setInterval(tick, POLL_MS); }
    },
    toggle() { panel.show(!panel.shown); return panel.shown; },
    destroy() { clearInterval(timer); timer = null; },
  };
  return panel;
}
