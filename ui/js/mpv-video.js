// HTMLMediaElement-shaped facade over the native shell's embedded libmpv
// (window.shell.mpv), so the player overlay drives mpv with the same code it
// uses for a <video> element (the browser-based UI tests).
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

// Passthrough through a sound server (PipeWire, Pulse) loops the last
// fraction of a second when the bitstream stops: the stream stays linked
// with nothing to send, and the HDMI sink can't fill an IEC 61937 stream with
// silence. While paused or buffering the audio track is let go instead, which
// closes the output just like stopping does, and taken back on resume.
// The receiver needs a moment to relock afterwards, so a buffering stall only
// lets go once it has lasted a while; a pause lets go at once.
const RELEASE_AOS = new Set(['pipewire', 'pulse']);
const STALL_RELEASE_MS = 2000;

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
    // Mid-playback stalls (mpv paused for cache), for the stats panel.
    this.stalls = { count: 0, seconds: 0 };
    this._stallStart = 0;
    this._userPaused = false;
    this._cachePaused = false;
    this._releasedAid = null;   // audio track id let go while paused, or null
    this._longStall = false;    // buffering for more than STALL_RELEASE_MS
    this._stallTimer = null;
    this._unsubscribe = [
      this.mpv.onProperty((name, value) => this._onProperty(name, value)),
      this.mpv.onFileLoaded(() => this._onFileLoaded()),
      this.mpv.onEndFile((reason, error) => this._onEndFile(reason, error)),
    ];
    document.documentElement.classList.add('native-video-playing');
    window.shell.setVideoLayer?.(true);
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
    this.stalls = { count: 0, seconds: 0 };
    this._stallStart = 0;
    this._userPaused = false;
    this._cachePaused = false;
    this._releasedAid = null;
    this._longStall = false;
    clearTimeout(this._stallTimer);
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
    clearTimeout(this._stallTimer);
    this._unsubscribe.forEach((off) => off());
    this._unsubscribe = [];
    this._src = '';
    this.mpv.command('stop');
    this.mpv.set('pause', false);
    document.documentElement.classList.remove('native-video-playing');
    window.shell.setVideoLayer?.(false);
  }

  // ---- mpv extras ----
  subtitleTracks() { return this.tracks.filter((t) => t.type === 'sub'); }
  audioTracks() { return this.tracks.filter((t) => t.type === 'audio'); }

  selectSubtitle(id) { this.mpv.set('sid', id == null ? 'no' : String(id)); }
  selectAudio(id) {
    // Chosen while let go: it's what comes back on resume.
    if (this._releasedAid !== null) this._releasedAid = String(id);
    else this.mpv.set('aid', String(id));
  }

  get audioReleased() { return this._releasedAid !== null; }

  _updateAudioRelease() {
    const halted = this._userPaused || this._longStall;
    if (halted && this._releasedAid === null) {
      const p = this.audioOut;
      if (!p || !String(p.format || '').startsWith('spdif-') || !RELEASE_AOS.has(this.currentAo)) return;
      const track = this.audioTracks().find((t) => t.selected);
      if (!track) return;
      this._releasedAid = String(track.id);
      this.mpv.set('aid', 'no');
    } else if (!halted && this._releasedAid !== null) {
      const aid = this._releasedAid;
      this._releasedAid = null;
      this.mpv.set('aid', aid);
    }
  }
  addSubtitle(url, title, lang) {
    const existing = this.subtitleTracks().find((t) => t.external && t['external-filename'] === url);
    if (existing) this.selectSubtitle(existing.id);
    else this.mpv.command('sub-add', url, 'select', title || lang || 'Subtitle', lang || '');
  }
  setSubtitleScale(scale) { this.mpv.set('sub-scale', scale); }

  // ---- mpv events -> media events ----
  _emit(type) { this.dispatchEvent(new Event(type)); }

  _onProperty(name, value) {
    if (!this._src) return;
    switch (name) {
      case 'pause':
        this.paused = !!value;
        this._userPaused = !!value;
        this._updateAudioRelease();
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
        if (value && !this._stallStart) {
          this._stallStart = performance.now();
          if (this._loaded) this.stalls.count++;
        } else if (!value && this._stallStart) {
          if (this._loaded) this.stalls.seconds += (performance.now() - this._stallStart) / 1000;
          this._stallStart = 0;
        }
        this._cachePaused = !!value;
        clearTimeout(this._stallTimer);
        this._longStall = false;
        if (value) {
          this._stallTimer = setTimeout(() => {
            if (!this._cachePaused) return;
            this._longStall = true;
            this._updateAudioRelease();
          }, STALL_RELEASE_MS);
        }
        this._updateAudioRelease();
        // falls through
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
        // Keep showing the real output while it's let go for a pause.
        if (this._releasedAid !== null && !(value && value.format)) break;
        this.audioOut = value && typeof value === 'object' ? value : null;
        break;
      case 'current-ao':
        if (this._releasedAid !== null && !value) break;
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
    const held = video.audioReleased ? ' (closed while paused, so it can\'t loop)' : '';
    return `Output: ${p.format.slice(6).toUpperCase()} bitstream passthrough${ao}${held}`;
  }
  return `Output: decoded PCM ${p['hr-channels'] || ''}${ao}`.replace(/\s+/g, ' ');
}
