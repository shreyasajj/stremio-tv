// Can this stream play to the end over this connection without stopping?
//
// While playing, the buffer gains rate/bitrate seconds of video per second
// and loses one. With a connection slower than the stream, playing the
// remaining T seconds through needs T × (1 − rate/bitrate) seconds banked
// first, beyond what's already buffered. Waiting banks rate/bitrate seconds
// per second. And mpv's cache only holds so much (demuxer-max-bytes), so past
// that no amount of waiting helps: only a smaller stream does.

export const WAIT_LIMIT_S = 120;   // a pause longer than this isn't a fix

// rateBps/bitrateBps in bits per second; times in seconds; cacheBytes the
// cache's capacity (0/undefined = unknown).
// Returns { keepsUp, neededS, waitS, fits, ratio, maxBytes } or null when
// unknown. maxBytes: the largest file of this length that would play through
// (average bitrate under 90% of the connection).
export function estimateCatchUp({ rateBps, bitrateBps, remainingS, durationS, bufferedS = 0, cacheBytes }) {
  if (!(bitrateBps > 0) || !(remainingS > 0) || rateBps == null) return null;
  const ratio = rateBps / bitrateBps;
  const maxBytes = durationS > 0 ? (rateBps * 0.9 / 8) * durationS : 0;
  if (ratio >= 1) return { keepsUp: true, neededS: 0, waitS: 0, fits: true, ratio, maxBytes };
  const neededS = Math.max(0, remainingS * (1 - ratio) - bufferedS);
  const waitS = ratio > 0 ? neededS / ratio : Infinity;
  const capacityS = cacheBytes > 0 ? (cacheBytes * 8) / bitrateBps : Infinity;
  const fits = bufferedS + neededS <= capacityS;
  return { keepsUp: false, neededS, waitS, fits, ratio, maxBytes };
}

// The verdict in words, for the stats panel.
export function describeCatchUp(e) {
  if (!e) return '';
  if (e.keepsUp) return `keeps up (connection ${e.ratio.toFixed(1)}× the bitrate)`;
  if (!isFinite(e.waitS)) return 'never — no data is arriving';
  if (!e.fits) return `never — it would need ${fmt(e.neededS)} buffered, more than the cache holds; try a smaller stream`;
  if (e.waitS > WAIT_LIMIT_S) return `only after waiting ${fmt(e.waitS)}; try a smaller stream`;
  return `after ${fmt(e.waitS)} more buffering`;
}

// Worth interrupting the viewer for: it will keep stalling.
export function hopeless(e) {
  return !!e && !e.keepsUp && (!e.fits || e.waitS > WAIT_LIMIT_S);
}

export function fmt(s) {
  if (!isFinite(s)) return '∞';
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

// Average network rate while mpv is actually downloading (an idle, full
// cache reads nothing and says nothing about the connection).
export class RateMeter {
  constructor(size = 30) { this.size = size; this.samples = []; }
  add(cacheState) {
    const rate = cacheState?.['raw-input-rate'];
    if (typeof rate !== 'number' || cacheState.idle) return;
    this.samples.push(rate * 8);
    if (this.samples.length > this.size) this.samples.shift();
  }
  get count() { return this.samples.length; }
  get bps() { return this.count ? this.samples.reduce((a, b) => a + b, 0) / this.count : null; }
}

// Average bitrate of the whole file (size/duration) beats the momentary
// packet bitrate, which swings with the scene.
export function streamBitrate(p) {
  const size = p['file-size'], dur = p.duration;
  if (size > 0 && dur > 0) return (size * 8) / dur;
  const sum = (p['video-bitrate'] || 0) + (p['audio-bitrate'] || 0);
  return sum > 0 ? sum : null;
}
