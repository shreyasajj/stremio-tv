// Regression test for "video plays behind the stream dialogs" (native libmpv
// path, simulated in headless Chromium with test/fake-native-shell.js):
//   - slow stream addon (like AIOStreams) + impatient double OK press
//   - nothing may stay drawn over the video once playback starts
//   - inline spinner must spin in place
//   npm run test:native-flow     (SHOTS=1 for screenshots)

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const staticServer = require('./static-server.js');
const mockAddon = require('./mock-addon.js');
const installFakeNativeShell = require('./fake-native-shell.js');

const UI_PORT = 8098;
const STREAM_DELAY_MS = 1500;
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, 'shots');

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    ...(() => {
      try {
        return fs.readdirSync('/opt/pw-browsers')
          .filter((d) => d.startsWith('chromium-'))
          .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`);
      } catch { return []; }
    })(),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No chromium found; set CHROMIUM_PATH');
}

let failures = 0;
function check(name, cond, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  if (!cond) failures++;
}

(async () => {
  const ui = staticServer.createServer().listen(UI_PORT);
  const addon = mockAddon.createServer({ streamDelayMs: STREAM_DELAY_MS }).listen(mockAddon.PORT);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message); failures++; });
  const shot = async (name) => { if (process.env.SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
  const press = async (k, wait = 120) => { await page.keyboard.press(k); await page.waitForTimeout(wait); };
  const modalCount = () => page.locator('.modal-backdrop').count();
  const modalText = () => page.evaluate(() => document.getElementById('modal-root').textContent);
  const playerOpen = () => page.evaluate(() => !document.getElementById('player-root').classList.contains('hidden'));
  const loadfiles = () => page.evaluate(() => window.__fakeMpv.log.filter((l) => l[1] === 'loadfile').length);

  const manifest = await (await fetch(`${mockAddon.BASE}/manifest.json`)).json();
  await page.addInitScript(installFakeNativeShell);
  await page.addInitScript(([m, base]) => {
    localStorage.setItem('stv.addons', JSON.stringify([{ transportUrl: base + '/manifest.json', manifest: m }]));
    localStorage.setItem('stv.firstRunDone', '1');
  }, [manifest, mockAddon.BASE]);

  await page.goto(`http://127.0.0.1:${UI_PORT}/ui/index.html`);
  await page.waitForSelector('.meta-card', { timeout: 10000 });
  await page.evaluate(() => window.stremioTV.router.push('detail', { type: 'movie', id: 'mock:movie1' }));
  await page.waitForSelector('.detail-title');
  await page.waitForTimeout(300);
  check('Play is focused on the detail page', await page.evaluate(() => document.activeElement.textContent.includes('Play')));

  // ---- impatient remote: OK, nothing seems to happen, OK again ----
  await press('Enter', 300);
  check('"Finding streams" dialog shows', (await modalText()).includes('Finding streams'));
  const focusInDialog = await page.evaluate(() => !!document.activeElement.closest('#modal-root'));
  check('focus moves into the loading dialog (not left on Play behind it)', focusInDialog);
  await shot('n1-finding-streams');

  // inline spinner must rotate in place, not slide up-left
  const drift = await page.evaluate(() => {
    const sp = document.querySelector('.spinner-inline');
    if (!sp) return null;
    const m = new DOMMatrix(getComputedStyle(sp).transform);
    return Math.abs(m.m41) + Math.abs(m.m42);
  });
  check('loading spinner spins in place (no translate drift)', drift !== null && drift < 0.5, `drift=${drift}`);

  await press('Enter', 300);
  check('second OK does not start a second search', (await modalCount()) === 1, `${await modalCount()} dialogs`);

  // ---- streams arrive; pick the first ----
  await page.waitForFunction(() => document.querySelectorAll('#modal-root .list-item').length > 0, null, { timeout: 10000 });
  await page.waitForTimeout(STREAM_DELAY_MS + 300); // give any duplicate search time to land
  check('exactly one dialog (the stream list) is open', (await modalCount()) === 1, `${await modalCount()} dialogs`);
  check('first stream is focused', await page.evaluate(() => !!document.activeElement.closest('#modal-root .list-item')));
  await shot('n2-streams');
  await press('Enter', 200);

  // ---- playing: nothing may cover the video ----
  await page.waitForTimeout(STREAM_DELAY_MS + 800);
  check('player is open', await playerOpen());
  check('no dialog is drawn over the video', (await modalCount()) === 0, (await modalText()).slice(0, 60));
  check('mpv loaded the file exactly once', (await loadfiles()) === 1, `${await loadfiles()} loadfile calls`);
  check('page is see-through for mpv', await page.evaluate(() => document.documentElement.classList.contains('native-video-playing')));
  const t = await page.evaluate(() => window.__fakeMpv.state.time);
  check('playback is progressing', t > 0.5, `t=${t}`);
  await shot('n3-playing');

  // ---- remote keys reach the player, not a hidden dialog ----
  const aidSets = () => page.evaluate(() => window.__fakeMpv.log.filter((l) => l[0] === 'set' && l[1] === 'aid').map((l) => l[2]));
  await press('Enter', 200);
  check('OK pauses mpv', await page.evaluate(() => window.__fakeMpv.state.pause === true));
  check('passthrough via PipeWire: audio let go while paused (no loop)', (await aidSets()).at(-1) === 'no', (await aidSets()).join(','));
  await press('Enter', 200);
  check('OK resumes mpv', await page.evaluate(() => window.__fakeMpv.state.pause === false));
  check('and the audio track comes back', (await aidSets()).at(-1) === '1', (await aidSets()).join(','));
  const stall = async (ms) => {
    await page.evaluate(() => window.__fakeMpv.emit('paused-for-cache', true));
    await page.waitForTimeout(ms);
    const during = (await aidSets()).length;
    await page.evaluate(() => window.__fakeMpv.emit('paused-for-cache', false));
    await page.waitForTimeout(100);
    return during;
  };
  const before = (await aidSets()).length;
  check('a short buffering stall keeps the audio open', (await stall(1000)) === before && (await aidSets()).length === before, (await aidSets()).join(','));
  check('a long stall lets it go', (await stall(2500)) === before + 1, (await aidSets()).join(','));
  check('and takes it back when playback resumes', (await aidSets()).slice(before).join(',') === 'no,1', (await aidSets()).join(','));

  // ---- stats for nerds: Info key toggles a panel that names the bottleneck ----
  const tBefore = await page.evaluate(() => window.__fakeMpv.state.time);
  await page.evaluate(() => { window.__fakeMpv.state.slow = true; });
  await press('i', 2300);
  const tAfter = await page.evaluate(() => window.__fakeMpv.state.time);
  check('video keeps playing under the stats panel', tAfter - tBefore > 1.5 && !(await page.evaluate(() => window.__fakeMpv.state.pause)), `${tBefore} -> ${tAfter}`);
  check('the panel never takes focus or input', await page.evaluate(() => {
    const p = document.querySelector('.stats-panel');
    return getComputedStyle(p).pointerEvents === 'none' && !p.contains(document.activeElement);
  }));
  const stats = await page.evaluate(() => {
    const p = document.querySelector('.stats-panel');
    return p && !p.classList.contains('hidden') ? p.textContent : '';
  });
  check('Info key opens Stats for nerds', stats.includes('Stats for nerds'));
  check('stats show the decoder path', stats.includes('Software — CPU'), stats.slice(0, 200));
  check('stats blame the CPU decoder', /software decoding HEVC 3840×2160 on the CPU/.test(stats));
  check('stats blame the slow network', /downloading at 20\.0 Mbps, the stream needs 40\.6 Mbps/.test(stats));
  await shot('n3b-stats');
  await press('Enter', 200);
  check('OK still pauses with the panel open', await page.evaluate(() => window.__fakeMpv.state.pause === true));
  await press('Enter', 200);
  check('and resumes', await page.evaluate(() => window.__fakeMpv.state.pause === false));
  await press('i', 200);
  await page.evaluate(() => { window.__fakeMpv.state.slow = false; });
  check('Info key closes Stats for nerds', await page.evaluate(() => document.querySelector('.stats-panel').classList.contains('hidden')));

  // ---- a stream the connection can never keep up with ----
  await page.evaluate(() => { window.__fakeMpv.state.slow = true; });
  await page.waitForFunction(() => document.getElementById('modal-root').textContent.includes('too big'), null, { timeout: 20000 })
    .catch(() => {});
  const offer = await modalText();
  check('a hopeless stream offers a smaller one', offer.includes('too big for your connection'), offer.slice(0, 120));
  check('with the numbers', /gives 20\.0 Mbps; this stream needs 40\.6 Mbps/.test(offer) && /under about [\d.]+ GB/.test(offer), offer.slice(0, 300));
  await page.evaluate(() => { window.__fakeMpv.state.slow = false; });
  const switchAt = await page.evaluate(() => window.__fakeMpv.state.time);
  check('"Find a smaller stream" is focused', await page.evaluate(() => document.activeElement.textContent.includes('Find a smaller stream')));
  await press('Enter', 300);
  check('it closes the player', !(await playerOpen()));
  await page.waitForFunction(() => document.querySelectorAll('#modal-root .list-item').length > 0, null, { timeout: 10000 });
  const hint = await page.evaluate(() => document.querySelector('#modal-root .modal-hint')?.textContent || '');
  check('the stream list says what size fits', /plays files up to about [\d.]+ GB/.test(hint), hint);
  await shot('n3c-smaller-stream');
  await press('Enter', 200);
  await page.waitForTimeout(800);
  check('the new stream plays', await playerOpen());
  const resumed = await page.evaluate(() => window.__fakeMpv.log.filter((l) => l[1] === 'seek').at(-1));
  check('from where you were', !!resumed && Math.abs(Number(resumed[2]) - switchAt) < 2, JSON.stringify(resumed));

  // ---- Back during the search cancels it cleanly ----
  await press('Escape', 400);
  check('one Back press exits the player', !(await playerOpen()));
  check('mpv stopped', await page.evaluate(() => window.__fakeMpv.state.file === ''));
  check('page is opaque again', await page.evaluate(() => !document.documentElement.classList.contains('native-video-playing')));
  await page.waitForSelector('.detail-title', { timeout: 5000 });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('stv.library') || '{}')['movie:mock:movie1']);
  check('watch progress saved from mpv', !!saved && saved.time > 1, saved ? `t=${saved.time}` : 'none');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.screen:not(.hidden) .btn')].find((x) => x.textContent.includes('Play'));
    b.focus();
  });
  await press('Enter', 300);
  await press('Escape', 200);
  check('Back closes the loading dialog', (await modalCount()) === 0);
  await page.waitForTimeout(STREAM_DELAY_MS + 500);
  check('cancelled search does not pop up a stream list later', (await modalCount()) === 0, `${await modalCount()} dialogs`);
  check('focus is back on the page', await page.evaluate(() => !!document.activeElement.closest('#screens')));

  // ---- OK on the Cancel button also cancels ----
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.screen:not(.hidden) .btn')].find((x) => x.textContent.includes('Play'));
    b.focus();
  });
  await press('Enter', 300);
  await press('ArrowDown', 150);
  check('one arrow press reaches the Cancel button',
    await page.evaluate(() => document.activeElement.textContent.includes('Cancel')));
  await press('Enter', 200);
  await page.waitForTimeout(STREAM_DELAY_MS + 500);
  check('Cancel closes the search for good', (await modalCount()) === 0);

  await homeAssistantChecks();
  await passthroughPauseChecks();

  await browser.close();
  ui.close();
  addon.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nAll native-flow checks passed.');
  process.exit(failures ? 1 : 0);

  // ---- Home Assistant: Settings by remote alone, publishing, commands ----
  async function homeAssistantChecks() {
    const fakeHA = (expr) => page.evaluate(`(() => { const ha = window.__fakeHA; return ${expr}; })()`);
    const focused = (attr) => page.evaluate((a) => document.activeElement?.getAttribute(a), attr);
    const subOf = (which) => page.evaluate((w) => document.querySelector(`[data-ha="${w}"] .li-sub`)?.textContent || '', which);
    const lastConfigured = () => fakeHA('ha.configured[ha.configured.length - 1]');
    const lastPublished = () => fakeHA('ha.published[ha.published.length - 1]');
    // Arrow keys until `done()` holds (at most `max` presses).
    const pressUntil = async (k, done, max = 15) => {
      for (let i = 0; i < max; i++) {
        if (await done()) return true;
        await press(k, 100);
      }
      return done();
    };
    // Type on the on-screen keyboard with arrows + OK only, then Done.
    const oskKey = async (label) => {
      for (let i = 0; i < 40; i++) {
        const d = await page.evaluate((l) => {
          const target = [...document.querySelectorAll('#modal-root .osk-key')].find((k) => k.textContent === l);
          if (!target) return { missing: true };
          if (document.activeElement === target) return { here: true };
          const a = document.activeElement.getBoundingClientRect();
          const b = target.getBoundingClientRect();
          return { dx: b.left + b.width / 2 - (a.left + a.width / 2), dy: b.top + b.height / 2 - (a.top + a.height / 2) };
        }, label);
        if (d.missing) throw new Error(`no on-screen key "${label}"`);
        if (d.here) { await press('Enter', 60); return; }
        if (Math.abs(d.dy) > 10) await press(d.dy > 0 ? 'ArrowDown' : 'ArrowUp', 30);
        else await press(d.dx > 0 ? 'ArrowRight' : 'ArrowLeft', 30);
      }
      throw new Error(`could not reach on-screen key "${label}"`);
    };
    const oskType = async (text, { clear = false } = {}) => {
      if (clear) await oskKey('Clear');
      for (const ch of text) await oskKey(ch);
      await oskKey('Done');
      await page.waitForTimeout(200);
    };
    const toItem = async (which) => {
      const ok = await pressUntil('ArrowDown', async () => (await focused('data-ha')) === which)
        || await pressUntil('ArrowUp', async () => (await focused('data-ha')) === which);
      if (!ok) throw new Error(`could not reach the "${which}" item`);
    };

    check('HA: boot configures the link as off', (await fakeHA('ha.configured[0]'))?.enabled === false);
    check('HA: boot reports idle', (await fakeHA('ha.published[0]'))?.state === 'idle');

    // Into Settings from the detail page: Left into the rail, down to Settings.
    await pressUntil('ArrowLeft', () => page.evaluate(() => !!document.activeElement.closest('#sidebar')), 10);
    await pressUntil('ArrowDown', async () => (await page.evaluate(() => document.activeElement.dataset.screen)) === 'settings', 10);
    await press('Enter', 400);
    const haItem = () => page.evaluate(() => document.querySelector('[data-setting="home-assistant"]')?.textContent || '');
    check('HA: Settings lists Home Assistant', (await haItem()).includes('Home Assistant'));
    check('HA: the item says what is sent, and that it is off', /Off.*sends what you watch.*your own MQTT broker/.test(await haItem()), await haItem());
    await pressUntil('ArrowDown', async () => (await focused('data-setting')) === 'home-assistant');
    check('HA: reachable with arrow keys', (await focused('data-setting')) === 'home-assistant');
    await press('Enter', 400);
    check('HA: screen opens on the on/off item', (await focused('data-ha')) === 'toggle');
    await shot('ha-1-screen');

    // Enter manually: four keyboard prompts, then the connection test.
    await toItem('manual');
    await press('Enter', 300);
    check('HA: manual entry asks for the broker address', (await modalText()).includes('Broker address'));
    await oskType('broker.test');
    check('HA: then the port, pre-filled with 1883', (await modalText()).includes('port')
      && (await page.evaluate(() => document.querySelector('#modal-root .osk-display').textContent)).includes('1883'));
    await oskType('');
    check('HA: then the username', (await modalText()).includes('username'));
    await oskType('stremio');
    check('HA: then the password', (await modalText()).includes('password'));
    await oskType('secret');
    await page.waitForTimeout(400);
    const cfg = await lastConfigured();
    check('HA: manual entry configures the link',
      cfg && cfg.enabled && cfg.host === 'broker.test' && cfg.port === 1883 && cfg.username === 'stremio'
        && cfg.password === 'secret' && cfg.box === 'living_room', JSON.stringify(cfg));
    check('HA: and ends in a connection test', (await fakeHA('ha.tests.length')) === 1 && (await subOf('test')).includes('Connected'), await subOf('test'));
    check('HA: live status shows Connected', (await subOf('toggle')).includes('Connected to broker.test:1883'), await subOf('toggle'));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('stv.settings')));
    check('HA: settings stored', stored.haEnabled === true && stored.haHost === 'broker.test' && stored.haPassword === 'secret');
    await shot('ha-2-connected');

    // One field on its own: a wrong password shows the broker's error.
    await toItem('password');
    await press('Enter', 300);
    await oskType('nope', { clear: true });
    await page.waitForTimeout(200);
    check('HA: password changed alone', (await lastConfigured()).password === 'nope');
    check('HA: the broker error shows', (await subOf('toggle')).includes('Not authorised'), await subOf('toggle'));
    await toItem('test');
    await press('Enter', 400);
    check('HA: Test connection shows the error', (await subOf('test')).includes('Not authorised'), await subOf('test'));
    await toItem('box');
    await press('Enter', 300);
    await oskType('den', { clear: true });
    check('HA: box name editable', (await lastConfigured()).box === 'den' && (await subOf('box')).includes('stremio_tv/den/'), await subOf('box'));
    await press('Enter', 300);
    await oskType('living_room', { clear: true });

    // Set up with phone: QR + link; the phone's login fills the same fields.
    await toItem('phone');
    await press('Enter', 400);
    check('HA: phone setup shows a QR code', await page.evaluate(() => !!document.querySelector('#modal-root img.ha-qr')?.src.startsWith('data:image/png')));
    check('HA: and the same link in text', (await modalText()).includes('http://192.168.1.50:8765/setup?code=4F7K9Q'));
    check('HA: the setup page is running', await fakeHA('ha.setup.open'));
    check('HA: focus is on the dialog button', await page.evaluate(() => !!document.activeElement.closest('#modal-root')));
    await shot('ha-3-phone');
    await page.evaluate(() => window.__fakeHA.phone({ phase: 'testing' }));
    await page.waitForTimeout(100);
    check('HA: TV shows the test running', (await modalText()).includes('Testing'));
    await page.evaluate(() => window.__fakeHA.phone({ phase: 'done', ok: false, error: 'Not authorised: check the username and password' }));
    await page.waitForTimeout(100);
    check('HA: TV shows the phone attempt failing', (await modalText()).includes('Not authorised'));
    await page.evaluate(() => window.__fakeHA.phone({
      phase: 'done', ok: true, error: '', settings: { host: '10.0.0.2', port: 1884, username: 'phone', password: 'secret' },
    }));
    await page.waitForTimeout(300);
    check('HA: TV shows Connected', (await modalText()).includes('Connected'));
    const phoneCfg = await lastConfigured();
    check('HA: phone login configures the link', phoneCfg.host === '10.0.0.2' && phoneCfg.port === 1884
      && phoneCfg.username === 'phone' && phoneCfg.enabled, JSON.stringify(phoneCfg));
    check('HA: and fills the same fields', (await subOf('host')) === '10.0.0.2' && (await subOf('port')) === '1884');
    await press('Enter', 300);
    check('HA: Done closes the dialog', (await modalCount()) === 0);
    check('HA: closing stops the setup page', (await fakeHA('ha.setup.open')) === false);

    // Off and on again.
    await toItem('toggle');
    await press('Enter', 200);
    check('HA: turning off disconnects', (await lastConfigured()).enabled === false);
    check('HA: shows Off', (await page.evaluate(() => document.querySelector('.toggle-pill').textContent)) === 'Off');
    await press('Enter', 200);
    check('HA: turning on reconnects', (await lastConfigured()).enabled === true);
    await page.waitForTimeout(200);

    // ---- playback publishes; commands from HA drive the player ----
    await page.route((u) => u.pathname.includes('/meta/movie/') && u.pathname.includes('movie1'), async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.meta.imdb_id = 'tt0063350';
      body.meta.poster = 'https://images.metahub.space/poster/medium/tt0063350/img';
      await route.fulfill({ response: res, json: body });
    });
    await page.route('https://images.metahub.space/**', (route) => route.fulfill({ status: 404 }));
    await page.evaluate(() => window.stremioTV.router.push('detail', { type: 'movie', id: 'mock:movie1' }));
    await page.waitForSelector('.detail-title');
    await page.waitForTimeout(300);
    await page.evaluate(() => [...document.querySelectorAll('.screen:not(.hidden) .btn')].find((x) => /Play|Resume/.test(x.textContent)).focus());
    await press('Enter', 300);
    await page.waitForFunction(() => document.querySelectorAll('#modal-root .list-item').length > 0, null, { timeout: 10000 });
    await press('Enter', 200);
    await page.waitForFunction(() => window.__fakeMpv.state.time > 1, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    const st = await lastPublished();
    check('HA: playing is published', st.state === 'playing', JSON.stringify(st));
    check('HA: with title, type and IMDb id', st.title === 'Mock Movie 1' && st.type === 'movie' && st.imdb_id === 'tt0063350' && st.episode === null);
    check('HA: with the poster', st.poster === 'https://images.metahub.space/poster/medium/tt0063350/img');
    check('HA: with position, duration and progress', st.position >= 0 && st.duration === 1800 && st.progress >= 0 && st.progress < 5,
      `${st.position} / ${st.duration} = ${st.progress}%`);
    // While playing, the position is re-sent every 15 s.
    const sent = await fakeHA('ha.published.length');
    await page.waitForTimeout(15500);
    const tick = await lastPublished();
    check('HA: position re-sent every 15 s while playing', (await fakeHA('ha.published.length')) > sent
      && tick.state === 'playing' && tick.position >= 10 && tick.progress > 0, `${tick.position} s, ${tick.progress}%`);

    await page.evaluate(() => window.__fakeHA.command('pause'));
    await page.waitForTimeout(200);
    check('HA: "pause" pauses mpv', await page.evaluate(() => window.__fakeMpv.state.pause === true));
    check('HA: paused is published', (await lastPublished()).state === 'paused');
    await page.evaluate(() => window.__fakeHA.command('pause'));
    await page.waitForTimeout(200);
    check('HA: a second "pause" keeps it paused', await page.evaluate(() => window.__fakeMpv.state.pause === true));
    await page.evaluate(() => window.__fakeHA.command('play'));
    await page.waitForTimeout(200);
    check('HA: "play" resumes', await page.evaluate(() => window.__fakeMpv.state.pause === false));
    check('HA: playing is published again', (await lastPublished()).state === 'playing');
    const before = await page.evaluate(() => window.__fakeMpv.state.time);
    await page.evaluate(() => window.__fakeHA.command('seek:+30'));
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => window.__fakeMpv.state.time);
    check('HA: "seek:+30" skips forward', after >= before + 29, `${before.toFixed(1)} -> ${after.toFixed(1)}`);
    check('HA: the new position is published', (await lastPublished()).position >= Math.floor(before + 29));
    await page.evaluate(() => window.__fakeHA.command('seek:-30'));
    await page.waitForTimeout(200);
    check('HA: "seek:-30" skips back', (await page.evaluate(() => window.__fakeMpv.state.time)) < after - 25);
    await page.evaluate(() => window.__fakeHA.command('toggle'));
    await page.waitForTimeout(200);
    check('HA: "toggle" pauses', await page.evaluate(() => window.__fakeMpv.state.pause === true));
    await page.evaluate(() => window.__fakeHA.command('bogus'));
    await page.evaluate(() => window.__fakeHA.command('stop'));
    await page.waitForTimeout(400);
    check('HA: "stop" closes the player', !(await playerOpen()));
    check('HA: idle is published', (await lastPublished()).state === 'idle');
    await page.evaluate(() => window.__fakeHA.command('play'));
    await page.waitForTimeout(200);
    check('HA: commands with no player open are ignored', !(await playerOpen()));
  }
  // ---- Settings → Passthrough pause: Dolby/DTS pause signal (patched mpv) ----
  async function passthroughPauseChecks() {
    await page.evaluate(() => window.stremioTV.router.push('settings'));
    const sel = '.screen:not(.hidden) [data-setting="passthrough-pause"]';
    await page.waitForSelector(sel, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);
    const item = await page.$(sel);
    check('Settings offers Passthrough pause (patched mpv)', !!item);
    check('defaulting to closing the audio', !!item && (await item.textContent()).includes('Close the audio'));
    if (!item) return;
    await page.evaluate((q) => document.querySelector(q).focus(), sel);
    await press('Enter', 300);
    await page.evaluate(() => [...document.querySelectorAll('#modal-root .list-item')].find((x) => x.textContent.includes('pause signal')).focus());
    await press('Enter', 300);
    check('choosing the pause signal is stored', await page.evaluate(() => JSON.parse(localStorage.getItem('stv.settings')).passthroughPause === 'bursts'));

    await page.evaluate(() => window.stremioTV.router.push('detail', { type: 'movie', id: 'mock:movie1' }));
    await page.waitForSelector('.screen:not(.hidden) .detail-title');
    await page.waitForTimeout(300);
    await page.evaluate(() => [...document.querySelectorAll('.screen:not(.hidden) .btn')].find((x) => /Play|Resume/.test(x.textContent)).focus());
    await press('Enter', 300);
    await page.waitForFunction(() => document.querySelectorAll('#modal-root .list-item').length > 0, null, { timeout: 10000 });
    await press('Enter', 200);
    await page.waitForTimeout(1500);
    const log = () => page.evaluate(() => window.__fakeMpv.log.filter((l) => l[0] === 'set' && (l[1] === 'aid' || l[1] === 'audio-spdif-pause-bursts')).map((l) => `${l[1]}=${l[2]}`));
    check('mpv gets the pause-burst option', (await log()).includes('audio-spdif-pause-bursts=true'), (await log()).slice(-4).join(' '));
    const before = (await log()).filter((x) => x === 'aid=no').length;
    await press('Enter', 300);
    check('paused', await page.evaluate(() => window.__fakeMpv.state.pause === true));
    check('with the pause signal the audio stays open', (await log()).filter((x) => x === 'aid=no').length === before, (await log()).slice(-4).join(' '));
    await press('Enter', 200);
    await press('Escape', 400);
    check('player closed', !(await playerOpen()));
  }

})().catch((e) => { console.error('FATAL', e); process.exit(1); });
