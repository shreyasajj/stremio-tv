// End-to-end test of the native Qt shell: launches the real binary (Qt Quick
// + WebEngine + libmpv), attaches over Chromium's remote debugging protocol,
// and drives it with remote keys against the local mock addon. Playback is
// verified through mpv's own properties, and SHOTS=1 saves composited window
// grabs (video included) to test/shots/native-*.png.
//
//   NATIVE_BIN=native/build/stremio-tv-native node test/native-test.js
//
// Needs a display (Wayland or X11). In Docker: native/dev/run-tests.sh.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { CdpPage } = require('./cdp-page.js');
const { PNG } = require('playwright-core/lib/utilsBundle');
const mockAddon = require('./mock-addon.js');

const BIN = process.env.NATIVE_BIN || path.join(__dirname, '..', 'native', 'build', 'stremio-tv-native');
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, 'shots');

let failures = 0;
function check(name, cond, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  if (!cond) failures++;
}

async function waitFor(fn, { timeout = 15000, interval = 200 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Records a PulseAudio source for `ms` and returns the loudest 16-bit sample.
function recordPeak(source, ms) {
  return new Promise((resolve) => {
    const rec = spawn('parec', ['-d', source, '--format=s16le', '--rate=48000', '--channels=2', '--raw'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    let peak = 0;
    let rest = Buffer.alloc(0); // a sample split across chunks
    rec.stdout.on('data', (chunk) => {
      const buf = Buffer.concat([rest, chunk]);
      const end = buf.length & ~1;
      for (let i = 0; i < end; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)));
      rest = buf.subarray(end);
    });
    rec.on('error', () => resolve(0));
    setTimeout(() => { rec.kill(); resolve(peak); }, ms);
  });
}

(async () => {
  const addon = mockAddon.createServer().listen(mockAddon.PORT);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const app = spawn(BIN, [], {
    env: {
      ...process.env,
      STREMIO_TV_TEST: '1',
      QTWEBENGINE_REMOTE_DEBUGGING: `127.0.0.1:${CDP_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appLog = [];
  const onOutput = (d) => {
    for (const line of String(d).split('\n')) {
      if (!line.trim()) continue;
      appLog.push(line);
      if (process.env.VERBOSE || /\[mpv\]|GL:|error|Error|FAIL/.test(line)) console.log('  app:', line);
    }
  };
  app.stdout.on('data', onOutput);
  app.stderr.on('data', onOutput);
  let appExited = false;
  app.on('exit', (code) => { appExited = true; console.log(`  app exited (${code})`); });

  let lastConnectError = null;
  const page = await waitFor(() => CdpPage.connect(CDP_PORT, 'index.html')
    .catch((e) => { lastConnectError = e; return null; }), { timeout: 30000, interval: 500 });
  if (!page) {
    console.log(appLog.slice(-30).join('\n'));
    throw new Error(`could not attach to the native app over CDP: ${lastConnectError?.message}`);
  }
  page.onPageError((msg) => { console.log('PAGE ERROR:', msg); failures++; });

  const key = async (k, times = 1, delay = 150) => {
    for (let i = 0; i < times; i++) { await page.keyboard.press(k); await page.waitForTimeout(delay); }
  };
  const focusedText = () => page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 60) || '');
  const mpvGet = (name) => page.evaluate((n) => window.shell.mpv.get(n), name);
  const playerClass = (c) => page.evaluate((cls) => document.getElementById('player-root').classList.contains(cls), c);
  const shot = async (name) => {
    const file = path.join(SHOT_DIR, `native-${name}.png`);
    const ok = await page.evaluate((p) => window.shell.saveScreenshot(p), file);
    if (!ok) console.log(`  (screenshot ${name} failed)`);
    return ok ? file : null;
  };
  // Share of strongly coloured pixels in the centre of a window grab. The
  // sample is colour bars; the UI is greys and dark blues, so a stale page
  // frame left over the video doesn't count.
  const videoFraction = (file) => {
    const png = PNG.sync.read(fs.readFileSync(file));
    let lit = 0, total = 0;
    for (let y = Math.floor(png.height * 0.3); y < png.height * 0.7; y += 4) {
      for (let x = Math.floor(png.width * 0.3); x < png.width * 0.7; x += 4) {
        const i = (y * png.width + x) * 4;
        const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
        if (Math.max(r, g, b) - Math.min(r, g, b) > 120) lit++;
        total++;
      }
    }
    return lit / total;
  };

  // ---- Bridge ----
  await page.waitForFunction(() => window.shell && window.shell.isNative, undefined, { timeout: 15000 });
  check('native bridge exposes window.shell', true);
  check('embedded mpv is available', await page.evaluate(() => !!window.shell.mpv));

  // Seed the mock addon + skip first run, then reload into it.
  const manifest = await (await fetch(`${mockAddon.BASE}/manifest.json`)).json();
  await page.evaluate(([m, base]) => {
    localStorage.clear();
    localStorage.setItem('stv.addons', JSON.stringify([{ transportUrl: base + '/manifest.json', manifest: m }]));
    localStorage.setItem('stv.firstRunDone', '1');
  }, [manifest, mockAddon.BASE]);
  await page.reload();
  await page.waitForSelector('.meta-card', { timeout: 15000 });
  await page.waitForTimeout(500);
  check('home renders the mock catalog', await page.count('h2.row-title') >= 2);
  await shot('01-home');

  // ---- Remote navigation still works in WebEngine ----
  const before = await focusedText();
  await key('ArrowRight');
  check('ArrowRight moves focus', before !== (await focusedText()));
  await key('ArrowLeft');

  // ---- Detail -> streams -> play via mpv ----
  await page.evaluate(() => document.querySelector('.meta-card').focus());
  await key('Enter');
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  check('detail screen opens', (await page.text('.detail-title')).includes('Mock'));
  await key('Enter');
  await page.waitForSelector('.modal .list-item', { timeout: 10000 });
  await key('Enter'); // first stream: the playable sample
  const playing = await waitFor(async () => (await mpvGet('time-pos')) > 0.5, { timeout: 20000 });
  check('mpv is playing the stream', !!playing, `time-pos=${await mpvGet('time-pos')}`);
  check('page is transparent over the video',
    await page.evaluate(() => document.documentElement.classList.contains('native-video-playing')));
  check('mpv picked a video output', !!(await mpvGet('video-params')), JSON.stringify(await mpvGet('video-params') || {}).slice(0, 90));
  check('no HTML <video> element is used', await page.count('#player-root video') === 0);
  await page.waitForTimeout(1500);
  const playingShot = await shot('02-playing');
  // Overlay is hidden in lean-back mode: the centre must be mpv's video.
  const lit = playingShot ? videoFraction(playingShot) : 0;
  check('video is visible through the transparent UI', lit > 0.5, `${Math.round(lit * 100)}% video`);

  // ---- Audio reaches the sound server (dev container: PulseAudio null sink) ----
  const sink = process.env.STREMIO_TV_AUDIO_SINK;
  if (sink) {
    check('mpv outputs to PulseAudio', (await mpvGet('current-ao')) === 'pulse', String(await mpvGet('current-ao')));
    const peak = await recordPeak(`${sink}.monitor`, 1500);
    check('playback is audible on the sink', peak > 500, `peak ${peak}/32767`);
  } else {
    console.log('SKIP  audio checks (no STREMIO_TV_AUDIO_SINK)');
  }

  // ---- OK pauses / resumes ----
  await key('Enter');
  check('OK pauses mpv', await waitFor(() => mpvGet('pause'), { timeout: 3000 }));
  await key('Enter');
  check('OK resumes mpv', await waitFor(async () => (await mpvGet('pause')) === false, { timeout: 3000 }));

  // ---- Window blur pauses (focus-loss behaviour) ----
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  check('losing focus pauses mpv', await waitFor(() => mpvGet('pause'), { timeout: 3000 }));
  check('paused overlay shows', await playerClass('show-controls'));
  await shot('03-paused-overlay');
  await key('Enter'); // focused Play button
  check('OK on Play resumes', await waitFor(async () => (await mpvGet('pause')) === false, { timeout: 3000 }));
  await key('Escape');
  await page.waitForTimeout(300);

  // ---- Seek ----
  const t0 = await mpvGet('time-pos');
  await key('ArrowRight', 2, 200);
  const sought = await waitFor(async () => (await mpvGet('time-pos')) > t0 + 12, { timeout: 5000 });
  check('ArrowRight seeks mpv forward', !!sought, `${t0?.toFixed(1)} -> ${(await mpvGet('time-pos'))?.toFixed(1)}`);

  // ---- Subtitles: addon subtitle loaded by mpv ----
  await key('ArrowDown');
  check('controls overlay appears', await playerClass('show-controls'));
  await key('ArrowRight');
  check('focus on Subtitles button', (await focusedText()).includes('Subtitles'), await focusedText());
  await key('Enter');
  await page.waitForSelector('.modal');
  const subText = await page.text('.modal');
  check('subtitle menu lists the addon subtitle', subText.includes('ENG'), subText.slice(0, 80));
  await key('ArrowDown');
  await key('Enter');
  const subLoaded = await waitFor(async () => {
    const tracks = (await mpvGet('track-list')) || [];
    return tracks.find((t) => t.type === 'sub' && t.external && t.selected);
  }, { timeout: 8000 });
  check('mpv loaded + selected the addon subtitle', !!subLoaded, subLoaded ? subLoaded['external-filename'] : '');
  await page.waitForTimeout(500);
  await shot('04-subtitles');

  // ---- Audio menu shows the real output path ----
  await key('ArrowRight');
  check('focus on Audio button', (await focusedText()).includes('Audio'), await focusedText());
  await key('Enter');
  await page.waitForSelector('.modal');
  const audioText = await page.text('.modal');
  check('audio menu lists the track and output path', /Output:/.test(audioText) || /No audio/.test(audioText), audioText.slice(0, 120));
  await shot('05-audio-menu');
  await key('Escape');

  // ---- Back exits; mpv stops; progress saved ----
  await key('Escape');
  await key('Escape');
  await page.waitForTimeout(500);
  check('Back exits the player', await playerClass('hidden'));
  check('mpv stopped (idle)', await waitFor(() => mpvGet('idle-active'), { timeout: 3000 }));
  check('page opaque again', !(await page.evaluate(() => document.documentElement.classList.contains('native-video-playing'))));
  const lib = await page.evaluate(() => JSON.parse(localStorage.getItem('stv.library') || '{}'));
  check('watch progress saved', Object.values(lib).some((e) => e.time > 5));
  check('Resume offered on detail', (await page.text('.screen:not(.hidden)')).includes('Resume'));

  // ---- Resume starts where we left off ----
  await page.evaluate(() => [...document.querySelectorAll('.screen:not(.hidden) .focusable')]
    .find((b) => b.textContent.includes('Resume'))?.focus());
  await key('Enter');
  await page.waitForTimeout(500);
  if (await page.count('.modal .list-item')) await key('Enter'); // stream picker if shown
  const resumed = await waitFor(async () => (await mpvGet('time-pos')) > 10, { timeout: 15000 });
  check('Resume seeks to saved position', !!resumed, `time-pos=${(await mpvGet('time-pos'))?.toFixed(1)}`);
  await key('Escape');
  await page.waitForTimeout(500);

  // ---- Settings: native audio options ----
  await page.evaluate(() => document.querySelector('[data-screen="settings"]').focus());
  await key('Enter');
  await page.waitForSelector('.list-item');
  const settingsText = await page.text('.screen:not(.hidden)');
  check('settings has audio output device', settingsText.includes('Audio output device'));
  check('settings has surround passthrough', settingsText.includes('Surround passthrough'));
  await shot('06-settings');

  // ---- Clipboard bridge ----
  check('readClipboard works over the bridge', typeof (await page.evaluate(() => window.shell.readClipboard())) === 'string');

  // ---- Subtitle proxy fetch ----
  const fetched = await page.evaluate((u) => window.shell.proxyFetch(u), `${mockAddon.BASE}/sample.srt`);
  check('proxyFetch returns subtitle text', fetched.ok && fetched.body.includes('-->'), `status ${fetched.status}`);

  check('app still running', !appExited);
  page.close();
  app.kill('SIGTERM');
  const exited = await waitFor(() => appExited, { timeout: 8000 });
  check('app exits on SIGTERM', !!exited);
  addon.close();
  if (failures && !process.env.VERBOSE) {
    console.log('\n--- last app log lines ---\n' + appLog.slice(-30).join('\n'));
  }
  console.log(failures ? `\n${failures} FAILURES` : '\nAll native checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
