// Browser stand-in for the native Qt shell's `window.shell.mpv` bridge, so
// the libmpv code path (MpvVideo, transparent page, track menus) can be
// driven in plain headless Chromium. Install with page.addInitScript().
// Simulates mpv loading a file, emitting time-pos while unpaused, and EOF,
// and `shell.homeAssistant` (window.__fakeHA records what the UI configures
// and publishes; .command(c) and .phone(event) play Home Assistant's and the
// phone's part).
module.exports = function installFakeNativeShell() {
  const subs = { prop: new Set(), loaded: new Set(), end: new Set() };
  const on = (set) => (cb) => { set.add(cb); return () => set.delete(cb); };
  const emit = (set, ...args) => set.forEach((cb) => { try { cb(...args); } catch (e) { console.error(e); } });
  const state = { pause: false, time: 0, duration: 0, file: '', timer: null, loadTimer: null };
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
            { id: 1, type: 'video', selected: true, codec: 'hevc' },
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
    get: (name) => Promise.resolve(name === 'time-pos' ? state.time : null),
    // A software-decoded 4K HEVC stream over a connection slower than its
    // bitrate, mid-stall: the stats panel should blame both.
    getMany: (names) => Promise.resolve(Object.fromEntries(Object.entries({
      'stream-open-filename': state.file, 'file-format': 'mkv', 'video-format': 'hevc',
      'video-params': { w: 3840, h: 2160, pixelformat: 'yuv420p10', primaries: 'bt.2020', gamma: 'pq' },
      hwdec: 'auto-safe', 'hwdec-current': 'no', 'estimated-vf-fps': 23.976,
      'decoder-frame-drop-count': (state.drops = (state.drops || 0) + 3), 'frame-drop-count': 0,
      'video-bitrate': 40e6, 'audio-bitrate': 640e3, 'paused-for-cache': true,
      'demuxer-cache-state': { 'cache-duration': 0.4, 'raw-input-rate': 2.5e6, 'fw-bytes': 2e6 },
    }).filter(([k]) => names.includes(k)))),
    onProperty: on(subs.prop),
    onFileLoaded: on(subs.loaded),
    onEndFile: on(subs.end),
  };

  window.__fakeMpv = { state, log };

  // Fake broker: "broker.test" and "10.0.0.2" accept password "secret".
  const haSubs = { status: new Set(), command: new Set(), setup: new Set() };
  const accepts = (s) => (s.host === 'broker.test' || s.host === '10.0.0.2') && s.password === 'secret';
  const fakeHA = (window.__fakeHA = {
    configured: [],
    published: [],
    tests: [],
    setup: null,
    status: { state: 'off', error: '' },
    command: (c) => emit(haSubs.command, c),
    phone: (event) => emit(haSubs.setup, event),
  });
  const homeAssistant = {
    configure: (s) => {
      fakeHA.configured.push({ ...s });
      const next = !s.enabled || !s.host ? { state: 'off', error: '' }
        : accepts(s) ? { state: 'connected', error: '' }
          : { state: 'error', error: 'Not authorised: check the username and password' };
      setTimeout(() => {
        fakeHA.status = { ...next, host: s.host, port: s.port, box: s.box };
        emit(haSubs.status, fakeHA.status);
      }, 50);
    },
    publish: (st) => { fakeHA.published.push(JSON.parse(JSON.stringify(st))); },
    status: () => Promise.resolve(fakeHA.status),
    onStatus: on(haSubs.status),
    onCommand: on(haSubs.command),
    onPhoneSetup: on(haSubs.setup),
    test: (s) => {
      fakeHA.tests.push({ ...s });
      return new Promise((resolve) => setTimeout(() => resolve(accepts(s)
        ? { ok: true, error: '' }
        : { ok: false, error: 'Not authorised: check the username and password' }), 100));
    },
    startPhoneSetup: (current) => {
      fakeHA.setup = { open: true, current };
      return Promise.resolve({
        url: 'http://192.168.1.50:8765/setup?code=4F7K9Q',
        code: '4F7K9Q',
        qrPng: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==',
      });
    },
    stopPhoneSetup: () => { if (fakeHA.setup) fakeHA.setup.open = false; },
  };
  window.shell = {
    isNative: true,
    testMode: true,
    quit: () => {},
    setPlaybackActive: () => {},
    systemStats: () => Promise.resolve({ cpu: 97, process: 380, cores: 4 }),
    onWindowBlur: () => () => {},
    onWindowFocus: () => () => {},
    mpv,
    homeAssistant,
  };
  window.shellReady = Promise.resolve();
};
