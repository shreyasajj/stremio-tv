// HTMLMediaElement-shaped facade over the native shell's embedded libmpv
// (window.shell.mpv), so the player overlay drives <video> under Electron and
// mpv under the native Qt shell with the same code.
//
// mpv draws underneath the page; while this exists the page is transparent.

export function nativeMpvAvailable() {
  return !!window.shell?.mpv;
}

// Passthrough presets for Settings: value is mpv's `audio-spdif` list.
export const PASSTHROUGH_PRESETS = [
  { label: 'Off — decode to PCM', value: '' },
  { label: 'Dolby Digital, Dolby Digital+ (incl. Atmos) and DTS', value: 'ac3,eac3,dts' },
  { label: 'All, incl. TrueHD (Atmos) and DTS-HD — needs HDMI eARC', value: 'ac3,eac3,dts,dts-hd,truehd' },
];

export function applyAudioOutput(mpv, settings) {
  mpv.set('audio-device', settings.audioDevice || 'auto');
  mpv.set('audio-spdif', settings.audioPassthrough || '');
}

// Rendering quality. "fast" is the default because mpv's high-quality
// defaults can be too slow for a TV box GPU, which shows up as black video
// with audio playing.
export const VIDEO_QUALITY_PRESETS = [
  { label: 'Fast — smooth on TV boxes (recommended)', value: 'fast' },
  { label: 'High quality — sharper scaling, needs a strong GPU', value: 'high-quality' },
];

export function applyVideoQuality(mpv, settings) {
  if (settings.videoQuality === 'high-quality') {
    mpv.command('apply-profile', 'high-quality');
  } else {
    mpv.command('apply-profile', 'fast');
    mpv.set('deband', false); // high-quality turns it on; fast doesn't reset it
  }
}

export class MpvVideo extends EventTarget {
  constructor() {
    super();
    this.isNative = true;
    this.mpv = window.shell.mpv;
    this.element = document.createElement('div');
    this.element.className = 'native-video';
    this.paused = false;
    this.ended = false;
    this.duration = NaN;
    this.error = null;
    this.tracks = [];
    this.audioOut = null;   // mpv `audio-out-params`
    this.currentAo = '';
    this._time = 0;
    this._cacheEnd = 0;
    this._speed = 1;
    this._src = '';
    this._loaded = false;
    this._buffering = true;
    this._unsubscribe = [
      this.mpv.onProperty((name, value) => this._onProperty(name, value)),
      this.mpv.onFileLoaded(() => this._onFileLoaded()),
      this.mpv.onEndFile((reason, error) => this._onEndFile(reason, error)),
    ];
    document.documentElement.classList.add('native-video-playing');
    // Switch the web view's own background to transparent only now: the
    // switch makes WebEngine repaint the whole page, so it doesn't keep
    // showing the old (opaque) screens over the video.
    window.shell.setPageTransparent?.(true);
    // The OpenGL renderer may already have failed at startup.
    Promise.resolve(this.mpv.get('stv-render-error')).then((msg) => {
      if (msg) this._renderError(msg);
    }).catch(() => {});
  }

  _renderError(message) {
    if (this.videoOutputError) return;
    this.videoOutputError = message;
    this._emit('videooutputerror');
  }

  // Resolves to a reason string if a video track exists but nothing reaches
  // the screen (decoder/hwdec failure), or null if video is being shown.
  async checkVideoOutput() {
    if (this.videoOutputError) return this.videoOutputError;
    const vtrack = this.tracks.find((t) => t.type === 'video' && t.selected && !t.albumart && !t.image);
    if (!vtrack) return null; // audio-only file: nothing to show anyway
    const out = await this.mpv.get('video-out-params');
    if (out && out.w) return null;
    const codec = [vtrack.codec, vtrack['demux-w'] && `${vtrack['demux-w']}x${vtrack['demux-h']}`].filter(Boolean).join(' ');
    return `the video (${codec || 'unknown codec'}) can't be decoded or displayed on this box`;
  }

  // ---- HTMLMediaElement subset used by player.js ----
  get src() { return this._src; }
  set src(url) {
    this._src = url;
    this._loaded = false;
    this._buffering = true;
    this.ended = false;
    this.error = null;
    this.duration = NaN;
    this._time = 0;
    this._cacheEnd = 0;
    // Track choices and speed are global in mpv; reset them per file.
    this.mpv.set('aid', 'auto');
    this.mpv.set('sid', 'auto');
    this.mpv.set('speed', 1);
    this.mpv.command('loadfile', url, 'replace');
  }

  get currentTime() { return this._time; }
  set currentTime(t) {
    this._time = t;
    this.mpv.command('seek', t, 'absolute');
  }

  get playbackRate() { return this._speed; }
  set playbackRate(rate) {
    this._speed = rate;
    this.mpv.set('speed', rate);
  }

  get buffered() {
    const end = this._cacheEnd;
    return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
  }

  play() {
    this.paused = false;
    this.mpv.set('pause', false);
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.mpv.set('pause', true);
  }

  removeAttribute(name) {
    if (name === 'src') { this._src = ''; this.mpv.command('stop'); }
  }

  load() {}

  destroy() {
    this._unsubscribe.forEach((off) => off());
    this._unsubscribe = [];
    this._src = '';
    this.mpv.command('stop');
    this.mpv.set('pause', false);
    document.documentElement.classList.remove('native-video-playing');
    window.shell.setPageTransparent?.(false);
  }

  // ---- mpv extras ----
  subtitleTracks() { return this.tracks.filter((t) => t.type === 'sub'); }
  audioTracks() { return this.tracks.filter((t) => t.type === 'audio'); }

  selectSubtitle(id) { this.mpv.set('sid', id == null ? 'no' : String(id)); }
  selectAudio(id) { this.mpv.set('aid', String(id)); }
  addSubtitle(url, title, lang) {
    const existing = this.subtitleTracks().find((t) => t.external && t['external-filename'] === url);
    if (existing) this.selectSubtitle(existing.id);
    else this.mpv.command('sub-add', url, 'select', title || lang || 'Subtitle', lang || '');
  }
  setSubtitleScale(scale) { this.mpv.set('sub-scale', scale); }

  // ---- mpv events -> media events ----
  _emit(type) { this.dispatchEvent(new Event(type)); }

  _onProperty(name, value) {
    if (name === 'stv-render-error') { if (value) this._renderError(value); return; }
    if (!this._src) return;
    switch (name) {
      case 'pause':
        this.paused = !!value;
        this._emit(value ? 'pause' : 'play');
        if (!value && this._loaded && !this._buffering) this._emit('playing');
        break;
      case 'time-pos':
        if (typeof value === 'number') { this._time = value; this._emit('timeupdate'); }
        break;
      case 'duration':
        this.duration = typeof value === 'number' ? value : NaN;
        break;
      case 'demuxer-cache-time':
        this._cacheEnd = typeof value === 'number' ? value : 0;
        break;
      case 'paused-for-cache':
      case 'seeking':
        if (!this._loaded) break;
        this._buffering = !!value;
        this._emit(value ? 'waiting' : (this.paused ? 'canplay' : 'playing'));
        break;
      case 'speed':
        if (typeof value === 'number') this._speed = value;
        break;
      case 'track-list':
        this.tracks = Array.isArray(value) ? value : [];
        break;
      case 'audio-out-params':
        this.audioOut = value && typeof value === 'object' ? value : null;
        break;
      case 'current-ao':
        this.currentAo = value || '';
        break;
    }
  }

  _onFileLoaded() {
    if (!this._src) return;
    this._loaded = true;
    this._buffering = false;
    this._emit('loadedmetadata');
    this._emit('canplay');
    if (!this.paused) this._emit('playing');
  }

  _onEndFile(reason, error) {
    if (!this._src) return;
    if (reason === 'eof') {
      this.ended = true;
      this.paused = true;
      this._emit('ended');
    } else if (reason === 'error') {
      this.error = { message: error };
      this._emit('error');
    }
  }
}

// ---- labels for the track pickers ----

const LANGS = {
  eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French',
  ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', por: 'Portuguese', pt: 'Portuguese',
  jpn: 'Japanese', ja: 'Japanese', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
  rus: 'Russian', ru: 'Russian', hin: 'Hindi', hi: 'Hindi', ara: 'Arabic', ar: 'Arabic', dut: 'Dutch', nld: 'Dutch',
  pol: 'Polish', pl: 'Polish', tur: 'Turkish', tr: 'Turkish', swe: 'Swedish', sv: 'Swedish',
};

export function trackLabel(t) {
  const lang = t.lang ? (LANGS[t.lang.toLowerCase()] || t.lang.toUpperCase()) : '';
  return [t.title, lang].filter(Boolean).join(' — ') || `Track ${t.id}`;
}

const CHANNELS = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };

export function audioTrackDetails(t) {
  const ch = t['demux-channel-count'];
  return [
    t.codec ? t.codec.toUpperCase() : '',
    ch ? (CHANNELS[ch] || `${ch} ch`) : '',
    t.default ? 'default' : '',
  ].filter(Boolean).join(' · ');
}

// What actually leaves the box, from mpv's audio-out-params. `spdif-*`
// formats mean the encoded bitstream is being passed through untouched.
export function audioOutputSummary(video) {
  const p = video.audioOut;
  // Nothing opened: wrong/missing device, or ALSA device busy.
  if (!p || !p.format) return 'Output: no audio device opened — check Settings → Audio output device';
  const ao = video.currentAo ? ` via ${video.currentAo}` : '';
  if (String(p.format).startsWith('spdif-')) {
    return `Output: ${p.format.slice(6).toUpperCase()} bitstream passthrough${ao}`;
  }
  return `Output: decoded PCM ${p['hr-channels'] || ''}${ao}`.replace(/\s+/g, ' ');
}
