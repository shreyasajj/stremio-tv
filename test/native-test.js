// End-to-end test of the native Qt shell: launches the real binary (Qt Quick
// + WebEngine + libmpv), attaches over Chromium's remote debugging protocol,
// and drives it with remote keys against the local mock addon. Playback is
// verified through mpv's own properties, and SHOTS=1 saves composited window
// grabs (video included) to test/shots/native-*.png.
//
//   NATIVE_BIN=native/build/stremio-tv-native node test/native-test.js
//
// Needs a display (Wayland or X11). In Docker: native/dev/run-tests.sh.
// With mosquitto installed (the dev container), also tests the Home Assistant
// MQTT link against a real broker.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { CdpPage } = require('./cdp-page.js');
const { PNG } = require('playwright-core/lib/utilsBundle');
const mockAddon = require('./mock-addon.js');
const ha = require('./ha-helpers.js');

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
      if (process.env.VERBOSE || /\[mpv\]|GL:|error|Error|FAIL|terminated/.test(line)) console.log('  app:', line);
    }
  };
  app.stdout.on('data', onOutput);
  app.stderr.on('data', onOutput);
  let appExited = false;
  let stopping = false;
  app.on('exit', (code) => {
    appExited = true;
    console.log(`  app exited (${code})`);
    // Exiting on its own leaves the test waiting on a dead DevTools socket.
    if (!stopping) {
      console.log('\n--- last app log lines ---\n' + appLog.slice(-40).join('\n'));
      console.log(`\nFATAL app exited during the test (${failures} failures so far)`);
      process.exit(1);
    }
  });

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
  // The sample is SMPTE-style colour bars: in a correct frame the red and the
  // blue bar each cover about a sixth of the window. A stale UI frame over the
  // video, a black frame or a green (chroma-less) frame all score ~0.
  const barShares = (file) => {
    const png = PNG.sync.read(fs.readFileSync(file));
    let red = 0, blue = 0, total = 0;
    for (let y = 0; y < png.height; y += 4) {
      for (let x = 0; x < png.width; x += 4) {
        const i = (y * png.width + x) * 4;
        const [r, g, b] = [png.data[i], png.data[i + 1], png.data[i + 2]];
        if (r > 180 && g < 90 && b < 90) red++;
        if (b > 180 && r < 90 && g < 90) blue++;
        total++;
      }
    }
    return { red: red / total, blue: blue / total };
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
  const bars = playingShot ? barShares(playingShot) : { red: 0, blue: 0 };
  check('video is visible through the transparent UI', bars.red > 0.1 && bars.blue > 0.1,
    `red bar ${Math.round(bars.red * 100)}%, blue bar ${Math.round(bars.blue * 100)}%`);

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

  // ---- Home Assistant over MQTT, against a real Mosquitto ----
  let broker = null;
  let mdns = null;
  if (ha.haveMosquitto()) {
    broker = await ha.startBroker();
    mdns = await ha.mdnsResponder('10.1.2.3');
    await homeAssistantChecks();
  } else {
    console.log('SKIP  Home Assistant checks (no mosquitto)');
  }

  check('app still running', !appExited);
  page.close();
  stopping = true;
  app.kill('SIGTERM');
  const exited = await waitFor(() => appExited, { timeout: 8000 });
  check('app exits on SIGTERM', !!exited);
  if (broker) {
    // Killed without a clean disconnect: the broker publishes the last will.
    const offline = await waitFor(async () => (await ha.retained('stremio_tv/living_room/availability')) === 'offline',
      { timeout: 8000, interval: 300 });
    check('HA: last will marks the app offline when killed', !!offline,
      String(await ha.retained('stremio_tv/living_room/availability')));
    broker.proc.kill();
    mdns.close();
  }
  addon.close();
  if (failures && !process.env.VERBOSE) {
    console.log('\n--- last app log lines ---\n' + appLog.slice(-30).join('\n'));
  }
  console.log(failures ? `\n${failures} FAILURES` : '\nAll native checks passed.');
  process.exit(failures ? 1 : 0);

  async function homeAssistantChecks() {
    const base = 'stremio_tv/living_room';
    const watcher = ha.watch(['stremio_tv/#', 'homeassistant/#']);
    const focusedAttr = (a) => page.evaluate((x) => document.activeElement?.getAttribute(x), a);
    const sub = (w) => page.evaluate((x) => document.querySelector(`[data-ha="${x}"] .li-sub`)?.textContent || '', w);
    const modalText = () => page.evaluate(() => document.getElementById('modal-root').textContent);
    const pressUntil = async (k, done, max = 15) => {
      for (let i = 0; i < max && !(await done()); i++) await key(k);
      return done();
    };
    const stateMsgs = () => watcher.messages.filter((m) => m.topic === `${base}/state` && m.payload)
      .map((m) => ({ ...m, json: JSON.parse(m.payload) }));
    const retainedState = async () => JSON.parse((await ha.retained(`${base}/state`)) || 'null');

    // Settings -> Home Assistant -> on -> Set up with phone, by remote.
    await pressUntil('ArrowDown', async () => (await focusedAttr('data-setting')) === 'home-assistant');
    check('HA: Settings item reachable by arrow keys', (await focusedAttr('data-setting')) === 'home-assistant');
    await key('Enter');
    await page.waitForSelector('[data-ha="toggle"]');
    await page.waitForTimeout(300);
    check('HA: screen opens on the on/off item', (await focusedAttr('data-ha')) === 'toggle');
    await key('Enter');
    check('HA: turned on', (await page.text('.toggle-pill')) === 'On');
    await key('ArrowDown');
    check('HA: next is Set up with phone', (await focusedAttr('data-ha')) === 'phone');
    await key('Enter');
    await page.waitForSelector('#modal-root img.ha-qr');
    const url = (await page.text('.ha-setup-url')).trim();
    check('HA: TV shows the setup link', /^http:\/\/[\d.]+:\d+\/setup\?code=[A-Z2-9]{6}$/.test(url), url);
    check('HA: TV shows a QR code', !!(await waitFor(() => page.evaluate(() => document.querySelector('.ha-qr').naturalWidth > 100), { timeout: 3000 })));
    await page.waitForTimeout(300); // let the dialog fade in
    await shot('07-ha-phone-setup');

    // The phone: the form, pre-filled with HA's address from mDNS.
    const form = await waitFor(async () => {
      const body = await (await fetch(url)).text();
      return body.includes('value="10.1.2.3"') ? body : null;
    }, { timeout: 6000, interval: 500 });
    check('HA: phone page serves the form', !!form || (await (await fetch(url)).text()).includes('<form'));
    check('HA: broker address pre-filled from mDNS', !!form, `${mdns.queries.length} mDNS queries`);
    const wrongCode = await fetch(url.replace(/code=\w+/, 'code=AAAAAA'));
    check('HA: a wrong one-time code is refused', wrongCode.status === 403, String(wrongCode.status));
    const post = async (password) => (await fetch(url, {
      method: 'POST',
      body: new URLSearchParams({ host: ha.BROKER.host, port: String(ha.BROKER.port), username: ha.BROKER.username, password }),
    })).json();
    const bad = await post('wrong');
    check('HA: phone sees the broker rejecting a bad password', !bad.ok && /username or password|authoris/i.test(bad.error), bad.error);
    check('HA: TV shows the same error', /username or password|authoris/i.test(await modalText()), (await modalText()).slice(-120));
    const good = await post(ha.BROKER.password);
    check('HA: phone sees Connected', good.ok === true, JSON.stringify(good));
    check('HA: TV shows Connected', !!(await waitFor(async () => (await modalText()).includes('Connected'), { timeout: 3000 })));
    const after = await fetch(url).then(() => 'still up', () => 'closed');
    check('HA: setup page stops after a success', after === 'closed', after);
    await key('Enter');
    check('HA: Done closes the dialog', (await page.count('#modal-root .modal')) === 0);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stv.settings')));
    check('HA: phone login stored', saved.haEnabled && saved.haHost === ha.BROKER.host && saved.haUsername === ha.BROKER.username);
    const connected = await waitFor(async () => (await sub('toggle')).includes('Connected'), { timeout: 8000 });
    check('HA: status shows Connected', !!connected, await sub('toggle'));
    await shot('08-ha-connected');

    // Discovery, availability and the idle state, all retained.
    const discovery = JSON.parse((await ha.retained('homeassistant/device/stremio_tv_living_room/config')) || 'null');
    check('HA: device discovery published', discovery?.dev?.name === 'Stremio TV' && discovery.dev.ids?.[0] === 'stremio_tv_living_room');
    const cmps = discovery?.cmps || {};
    const platforms = Object.fromEntries(Object.entries(cmps).map(([k, v]) => [k, v.p]).sort());
    check('HA: discovery declares every entity', JSON.stringify(platforms) === JSON.stringify({
      duration: 'sensor', play_pause: 'button', position: 'sensor', poster: 'image', progress: 'sensor',
      skip_forward: 'button', state: 'sensor', stop: 'button', title: 'sensor',
    }), JSON.stringify(platforms));
    check('HA: discovery topics', discovery?.state_topic === `${base}/state` && discovery?.availability_topic === `${base}/availability`
      && discovery?.command_topic === `${base}/command`);
    check('HA: availability is online (retained)', (await ha.retained(`${base}/availability`)) === 'online');
    check('HA: idle state retained', (await retainedState())?.state === 'idle');

    // Playing: the retained state follows the player. From the start, so
    // the 30 s sample outlasts the checks below.
    await page.evaluate(() => localStorage.removeItem('stv.library'));
    await page.evaluate(() => window.stremioTV.router.push('detail', { type: 'movie', id: 'mock:movie1' }));
    await page.waitForSelector('.detail-title', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => [...document.querySelectorAll('.screen:not(.hidden) .btn')]
      .find((b) => /Play|Resume/.test(b.textContent))?.focus());
    await key('Enter');
    await page.waitForSelector('.modal .list-item', { timeout: 10000 });
    await key('Enter');
    await waitFor(async () => (await mpvGet('time-pos')) > 0.5, { timeout: 20000 });
    const playingState = await waitFor(async () => {
      const st = await retainedState();
      return st?.state === 'playing' && st.duration ? st : null;
    }, { timeout: 8000 });
    check('HA: playing state retained', !!playingState, JSON.stringify(playingState));
    if (playingState) {
      check('HA: state message has every field', JSON.stringify(Object.keys(playingState).sort()) === JSON.stringify(
        ['duration', 'episode', 'imdb_id', 'position', 'poster', 'progress', 'state', 'title', 'type', 'updated_at']));
      check('HA: title and type', playingState.title === 'Mock Movie 1' && playingState.type === 'movie' && playingState.episode === null);
      check('HA: duration in whole seconds', Number.isInteger(playingState.duration) && playingState.duration > 0, String(playingState.duration));
      check('HA: updated_at is UTC ISO 8601', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(playingState.updated_at), playingState.updated_at);
    }

    // Position updates every 15 s while playing.
    const first = stateMsgs().filter((m) => m.json.state === 'playing').pop();
    const update = await waitFor(() => stateMsgs().find((m) => m.at > first.at + 10000 && m.json.state === 'playing'),
      { timeout: 20000, interval: 500 });
    check('HA: position update while playing', !!update && update.json.position > first.json.position && update.retained === false,
      update ? `${first.json.position} s -> ${update.json.position} s after ${((update.at - first.at) / 1000).toFixed(1)} s` : 'none');
    check('HA: progress follows position', !!update && update.json.progress > 0 && update.json.progress <= 100,
      update ? `${update.json.progress}%` : '');

    // A command from Home Assistant: pause, then play.
    await ha.publish(`${base}/command`, 'pause');
    check('HA: "pause" from MQTT pauses mpv', !!(await waitFor(() => mpvGet('pause'), { timeout: 4000 })));
    const paused = await waitFor(async () => (await retainedState())?.state === 'paused', { timeout: 4000 });
    check('HA: paused state retained', !!paused);
    await shot('09-ha-paused-by-mqtt');
    await ha.publish(`${base}/command`, 'play');
    check('HA: "play" from MQTT resumes', !!(await waitFor(async () => (await mpvGet('pause')) === false, { timeout: 4000 })));
    check('HA: playing again', !!(await waitFor(async () => (await retainedState())?.state === 'playing', { timeout: 4000 })));
    watcher.stop();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
