// Browser stand-in for the native Qt shell's `window.shell.mpv` bridge, so
// the libmpv code path (MpvVideo, transparent page, track menus) can be
// driven in plain headless Chromium. Install with page.addInitScript().
// Simulates mpv loading a file, emitting time-pos while unpaused, and EOF.
module.exports = function installFakeNativeShell() {
  const subs = { prop: new Set(), loaded: new Set(), end: new Set() };
  const on = (set) => (cb) => { set.add(cb); return () => set.delete(cb); };
  const emit = (set, ...args) => set.forEach((cb) => { try { cb(...args); } catch (e) { console.error(e); } });
  const state = {
    pause: false, time: 0, duration: 0, file: '', timer: null, loadTimer: null,
    videoOnly: false, videoOnlyLog: [], noVideo: false, renderError: '',
  };
  const log = (window.__mpvLog = []);

  function stopFile(reason) {
    clearInterval(state.timer);
    clearTimeout(state.loadTimer);
    if (state.file) emit(subs.end, reason, '');
    state.file = '';
  }

  const mpv = {
    command: (...args) => {
      log.push(['command', ...args.map(String)]);
      const [cmd, a1, a2] = args;
      if (cmd === 'loadfile') {
        stopFile('stop');
        state.file = String(a1);
        state.time = 0;
        state.duration = 0;
        // A big remux takes a moment before the first frame.
        state.loadTimer = setTimeout(() => {
          state.duration = 1800;
          emit(subs.prop, 'duration', state.duration);
          emit(subs.prop, 'track-list', [
            { id: 1, type: 'video', selected: true, codec: 'hevc', 'demux-w': 3840, 'demux-h': 2160 },
            { id: 1, type: 'audio', selected: true, codec: 'truehd', lang: 'eng', 'demux-channel-count': 8 },
          ]);
          emit(subs.loaded);
          state.timer = setInterval(() => {
            if (state.pause) return;
            state.time += 0.25;
            emit(subs.prop, 'time-pos', state.time);
          }, 250);
        }, 400);
      } else if (cmd === 'stop') {
        stopFile('stop');
      } else if (cmd === 'seek') {
        state.time = a2 === 'absolute' ? Number(a1) : state.time + Number(a1);
        emit(subs.prop, 'time-pos', state.time);
      }
    },
    set: (name, value) => {
      log.push(['set', name, value]);
      if (name === 'pause') { state.pause = !!value; emit(subs.prop, 'pause', state.pause); }
    },
    get: (name) => {
      if (name === 'time-pos') return Promise.resolve(state.time);
      if (name === 'stv-render-error') return Promise.resolve(state.renderError || '');
      // A box that can't decode/display the video: audio plays, no frames.
      if (name === 'video-out-params') return Promise.resolve(state.file && state.duration && !state.noVideo ? { w: 1920, h: 1080 } : null);
      return Promise.resolve(null);
    },
    onProperty: on(subs.prop),
    onFileLoaded: on(subs.loaded),
    onEndFile: on(subs.end),
  };

  window.__fakeMpv = { state, log };
  window.shell = {
    isNative: true,
    testMode: true,
    quit: () => {},
    setPlaybackActive: () => {},
    setVideoOnly: (on) => { state.videoOnly = !!on; state.videoOnlyLog.push(!!on); },
    setPageTransparent: (on) => { state.pageTransparent = !!on; },
    onWindowBlur: () => () => {},
    onWindowFocus: () => () => {},
    mpv,
  };
  window.shellReady = Promise.resolve();
};
