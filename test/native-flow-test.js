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
  await press('Enter', 200);
  check('OK pauses mpv', await page.evaluate(() => window.__fakeMpv.state.pause === true));
  await press('Enter', 200);
  check('OK resumes mpv', await page.evaluate(() => window.__fakeMpv.state.pause === false));

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

  await browser.close();
  ui.close();
  addon.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nAll native-flow checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
