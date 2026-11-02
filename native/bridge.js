// Injected into the web UI (after qwebchannel.js) by the native shell.
// Builds the same `window.shell` the Electron preload provides, plus
// `shell.mpv` for the embedded libmpv player. The UI awaits
// `window.shellReady` before booting.
(function () {
  'use strict';
  if (typeof qt === 'undefined' || !qt.webChannelTransport) return;

  window.shellReady = new Promise((resolve) => {
    new QWebChannel(qt.webChannelTransport, (channel) => {
      const native = channel.objects.native;
      const mpv = channel.objects.mpv;

      let fetchSeq = 0;
      const pendingFetches = new Map();
      native.proxyFetchDone.connect((id, result) => {
        const done = pendingFetches.get(id);
        if (done) { pendingFetches.delete(id); done(result); }
      });

      const listeners = (signal) => {
        const set = new Set();
        signal.connect((...args) => set.forEach((cb) => { try { cb(...args); } catch (e) { console.error(e); } }));
        return (cb) => { set.add(cb); return () => set.delete(cb); };
      };

      window.shell = {
        isNative: true,
        testMode: native.testMode,
        proxyFetch: (url) => new Promise((resolve) => {
          const id = ++fetchSeq;
          pendingFetches.set(id, resolve);
          native.proxyFetch(String(url), id);
        }),
        readClipboard: () => new Promise((resolve) => native.readClipboard(resolve)),
        quit: () => native.quit(),
        setPlaybackActive: (playing) => native.setPlaybackActive(!!playing),
        setVideoOnly: (on) => native.setVideoOnly(!!on),
        setPageTransparent: (on) => native.setPageTransparent(!!on),
        onWindowBlur: listeners(native.windowBlur),
        onWindowFocus: listeners(native.windowFocus),
        saveScreenshot: (path) => new Promise((resolve) => native.saveScreenshot(String(path), resolve)),
        mpv: mpv.available ? {
          command: (...args) => mpv.command(args.map(String)),
          set: (name, value) => mpv.setOption(name, value),
          get: (name) => new Promise((resolve) => mpv.getProperty(name, resolve)),
          onProperty: listeners(mpv.propertyChanged),
          onFileLoaded: listeners(mpv.fileLoaded),
          onEndFile: listeners(mpv.endFile),
        } : null,
      };
      resolve();
    });
  });
})();
