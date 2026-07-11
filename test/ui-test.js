// End-to-end "remote control" test: drives the whole UI with arrow keys in
// headless Chromium against the local mock addon.
//   npm run test:ui        (add --headed to watch, SHOTS=1 for screenshots)

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const staticServer = require('./static-server.js');
const mockAddon = require('./mock-addon.js');

const UI_PORT = 8099;
const SHOT_DIR = process.env.SHOT_DIR || path.join(__dirname, 'shots');

function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium',
    ...(() => {
      try {
        return fs.readdirSync('/opt/pw-browsers')
          .filter((d) => d.startsWith('chromium'))
          .map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`);
      } catch { return []; }
    })(),
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch { /* ignore */ }
  }
  throw new Error('No chromium found; set CHROMIUM_PATH');
}

let failures = 0;
function check(name, cond, info = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  if (!cond) failures++;
}

(async () => {
  const ui = staticServer.createServer().listen(UI_PORT);
  const addon = mockAddon.createServer().listen(mockAddon.PORT);
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: !process.argv.includes('--headed'),
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('pageerror', (e) => { console.log('PAGE ERROR:', e.message); failures++; });

  const shot = async (name) => {
    if (process.env.SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
  };
  const key = async (k, times = 1, delay = 120) => {
    for (let i = 0; i < times; i++) { await page.keyboard.press(k); await page.waitForTimeout(delay); }
  };
  const focusedText = () => page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 60) || '');
  const focusedClass = () => page.evaluate(() => document.activeElement?.className || '');

  // Seed the mock addon + skip first-run before the app boots.
  const manifest = await (await fetch(`${mockAddon.BASE}/manifest.json`)).json();
  await page.addInitScript(([m, base]) => {
    localStorage.setItem('stv.addons', JSON.stringify([{ transportUrl: base + '/manifest.json', manifest: m }]));
    localStorage.setItem('stv.firstRunDone', '1');
  }, [manifest, mockAddon.BASE]);

  await page.goto(`http://127.0.0.1:${UI_PORT}/ui/index.html`);
  await page.waitForSelector('.meta-card', { timeout: 10000 });
  await page.waitForTimeout(400);

  // ---- Home renders + something is focused ----
  check('home shows mock catalog rows', await page.locator('h2.row-title').count() >= 2);
  check('a card is focused on boot', (await focusedClass()).includes('meta-card'), await focusedText());
  await shot('01-home');

  // ---- Arrow key navigation within a row ----
  const before = await focusedText();
  await key('ArrowRight');
  const after = await focusedText();
  check('ArrowRight moves to the next card', before !== after, `${before} -> ${after}`);
  await key('ArrowLeft');
  check('ArrowLeft moves back', (await focusedText()) === before);

  // ---- Left from leftmost card reaches the sidebar ----
  await key('ArrowLeft');
  check('sidebar reachable with Left', (await focusedClass()).includes('sidebar-item'), await focusedText());
  await shot('02-sidebar');

  // ---- Sidebar -> Discover ----
  await page.evaluate(() => document.querySelector('[data-screen="discover"]').focus());
  await key('Enter');
  await page.waitForSelector('.meta-grid .meta-card', { timeout: 10000 });
  check('discover grid renders', await page.locator('.meta-grid .meta-card').count() >= 10);
  await shot('03-discover');

  // ---- Catalog picker modal ----
  await page.evaluate(() => document.querySelector('.selector-bar .btn').focus());
  await key('Enter');
  await page.waitForSelector('.modal');
  check('catalog picker opens', await page.locator('.modal .list-item').count() >= 2);
  await key('ArrowDown');
  await key('Escape');
  check('Back closes the modal', (await page.locator('.modal').count()) === 0);

  // ---- Open a movie detail ----
  await page.evaluate(() => document.querySelector('.meta-grid .meta-card').focus());
  await key('Enter');
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  check('detail screen shows title', (await page.locator('.detail-title').textContent()).includes('Mock Movie'));
  check('play button focused', (await focusedText()).includes('Play'));
  await shot('04-detail');

  // ---- Streams picker ----
  await key('Enter');
  await page.waitForSelector('.modal .list-item', { timeout: 10000 });
  const streamCount = await page.locator('.modal .list-item').count();
  check('stream picker lists mock streams', streamCount >= 2, `${streamCount} streams`);
  check('torrent stream marked unplayable (no server set)',
    (await page.locator('.modal').textContent()).includes('streaming server'));
  await shot('05-streams');

  // ---- Play + player behaviour ----
  await key('Enter'); // first stream = playable webm
  await page.waitForSelector('#player-root:not(.hidden) video', { timeout: 10000 });
  await page.waitForFunction(() => {
    const v = document.querySelector('#player-root video');
    return v && v.currentTime > 0.5;
  }, { timeout: 15000 });
  check('video is actually playing', true);
  await shot('06-player');

  // OK toggles pause
  await key('Enter');
  check('OK pauses', await page.evaluate(() => document.querySelector('#player-root video').paused));
  await key('Enter');
  check('OK resumes', !(await page.evaluate(() => document.querySelector('#player-root video').paused)));

  // Right seeks forward (commit happens after ~650ms)
  const t0 = await page.evaluate(() => document.querySelector('#player-root video').currentTime);
  await key('ArrowRight', 2, 200);
  await page.waitForTimeout(1000);
  const t1 = await page.evaluate(() => document.querySelector('#player-root video').currentTime);
  check('ArrowRight seeks forward ~20s', t1 > t0 + 15, `${t0.toFixed(1)} -> ${t1.toFixed(1)}`);

  // Down reveals controls; buttons navigable
  await key('ArrowDown');
  check('controls overlay appears', await page.evaluate(() => document.getElementById('player-root').classList.contains('show-controls')));
  check('a player button is focused', (await focusedClass()).includes('player-btn'), await focusedText());
  await key('ArrowRight');
  check('arrow moves between player buttons', (await focusedText()).includes('Subtitles'), await focusedText());
  await shot('07-player-controls');

  // Subtitles menu lists the addon subtitle
  await key('Enter');
  await page.waitForSelector('.modal');
  const subText = await page.locator('.modal').textContent();
  check('subtitle menu lists addon subtitle', subText.includes('ENG'), subText.slice(0, 80));
  await page.waitForTimeout(200);
  await key('ArrowDown');
  await key('Enter'); // pick ENG
  await page.waitForTimeout(800);
  check('addon subtitle track active', await page.evaluate(() => {
    const v = document.querySelector('#player-root video');
    return [...v.textTracks].some((t) => t.mode === 'showing');
  }));

  // Back hides controls, then exits the player
  await key('Escape');
  check('Back hides controls', !(await page.evaluate(() => document.getElementById('player-root').classList.contains('show-controls'))));
  await key('Escape');
  await page.waitForTimeout(400);
  check('Back exits player', await page.evaluate(() => document.getElementById('player-root').classList.contains('hidden')));
  check('returns to detail screen', await page.locator('.detail-title').count() > 0);

  // ---- Continue watching got recorded ----
  const lib = await page.evaluate(() => JSON.parse(localStorage.getItem('stv.library') || '{}'));
  check('watch progress saved', Object.values(lib).some((e) => e.time > 5), JSON.stringify(Object.values(lib)[0] || {}).slice(0, 100));
  check('resume button appears on detail', (await page.locator('.screen:not(.hidden)').textContent()).includes('Resume'));
  await shot('08-detail-resume');

  // ---- Back to home; series flow ----
  await key('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-screen="home"]').focus());
  await key('Enter');
  await page.waitForSelector('.meta-card');
  check('continue watching row on home', (await page.locator('.screen:not(.hidden)').textContent()).includes('Continue Watching'));

  // Series detail: seasons + episodes
  await page.evaluate(() => {
    [...document.querySelectorAll('.screen:not(.hidden) .meta-card')].find((c) => c.textContent.includes('Mock Series'))?.focus();
  });
  check('series card focused', (await focusedText()).includes('Mock Series'));
  await key('Enter');
  await page.waitForSelector('.episode-item', { timeout: 10000 });
  check('episode list renders', await page.locator('.episode-item').count() === 3);
  await shot('09-series');

  // ---- Search with the on-screen keyboard (physical passthrough) ----
  await page.evaluate(() => document.querySelector('[data-screen="search"]').focus());
  await key('Enter');
  await page.waitForSelector('.btn.primary');
  await page.evaluate(() => document.querySelector('.btn.primary').focus());
  await key('Enter');
  await page.waitForSelector('.osk-rows');
  await shot('10-osk');
  await page.keyboard.type('series', { delay: 60 });
  // move to Done: bottom row last key
  await page.evaluate(() => {
    const keys = [...document.querySelectorAll('.osk-key')];
    keys.find((k) => k.textContent === 'Done').focus();
  });
  await key('Enter');
  await page.waitForTimeout(1200);
  const searchText = await page.locator('.screen:not(.hidden)').textContent();
  check('search finds the series', searchText.includes('Mock Series'), searchText.slice(0, 120));
  await shot('11-search-results');

  // ---- Settings + addons reachable ----
  await page.evaluate(() => document.querySelector('[data-screen="settings"]').focus());
  await key('Enter');
  await page.waitForSelector('.list-item');
  check('settings renders', (await page.locator('.screen:not(.hidden)').textContent()).includes('Streaming server'));
  await page.evaluate(() => document.querySelector('[data-screen="addons"]').focus());
  await key('Enter');
  await page.waitForTimeout(400);
  const addonsText = await page.locator('.screen:not(.hidden)').textContent();
  check('addons screen lists mock addon', addonsText.includes('Mock Addon'));
  check('addons screen has add-by-URL', addonsText.includes('Add addon by URL'));
  await shot('12-addons');

  // ---- Exit confirm on Home ----
  await page.evaluate(() => document.querySelector('[data-screen="home"]').focus());
  await key('Enter');
  await page.waitForTimeout(300);
  await key('Escape');
  await page.waitForTimeout(300);
  check('Back on home asks to exit', (await page.locator('.modal').textContent().catch(() => '')).includes('Exit'));
  await key('Escape');

  await browser.close();
  ui.close();
  addon.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nAll UI checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
