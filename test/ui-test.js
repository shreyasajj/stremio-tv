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
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
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
    if (window !== window.top) return; // not in the (fake) YouTube frame
    localStorage.setItem('stv.addons', JSON.stringify([{ transportUrl: base + '/manifest.json', manifest: m }]));
    localStorage.setItem('stv.firstRunDone', '1');
    // Trailers would start during any pause and swallow the next key; the
    // trailer checks turn them on.
    localStorage.setItem('stv.settings', JSON.stringify({ trailerPreviews: 'off' }));
  }, [manifest, mockAddon.BASE]);

  // Offline stand-in for YouTube's embedded player: reports "playing" to a
  // page that is listening, or an embedding error for ids starting mockBroken.
  await page.route('https://www.youtube-nocookie.com/embed/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<body style="background:#246"><script>
      const id = location.pathname.split('/').pop();
      addEventListener('message', (e) => {
        const d = JSON.parse(e.data);
        if (d.event === 'command') document.body.dataset[d.func] = '1';
        if (d.event !== 'listening') return;
        parent.postMessage(JSON.stringify(id.startsWith('mockBroken')
          ? { event: 'onError', info: 150 } : { event: 'infoDelivery', info: { playerState: 1, currentTime: 0 } }), '*');
      });
    </script></body>`,
  }));
  const trailers = (on) => page.evaluate((v) => window.stremioTV.Storage.setSettings({ trailerPreviews: v }), on ? 'sound' : 'off');
  const TRAILER_WAIT = 3800; // dwell (3 s) + meta fetch + fade

  await page.goto(`http://127.0.0.1:${UI_PORT}/ui/index.html`);
  await page.waitForSelector('.meta-card', { timeout: 10000 });
  await page.waitForTimeout(400);

  // ---- Home renders + something is focused ----
  check('home shows mock catalog rows', await page.locator('h2.row-title').count() >= 2);
  check('a card is focused on boot', (await focusedClass()).includes('meta-card'), await focusedText());
  await shot('01-home');

  // ---- Past the first row the hero gives way to three rows ----
  const browsing = () => page.evaluate(() => document.querySelector('.home-screen').classList.contains('browsing'));
  // Which of the three lanes (0 top … 2 bottom) the focused row sits in, and
  // the one above it; null when off the lane grid.
  const lanes = () => page.evaluate(() => {
    if (!document.activeElement.closest(".row-section")) return { focused: null, outside: document.activeElement.className };
    const safeY = innerHeight * 0.05;
    const lane = (innerHeight - safeY) / 3;
    const laneOf = (sec) => {
      if (!sec) return null;
      const n = (sec.getBoundingClientRect().top - safeY) / lane;
      return Math.abs(n - Math.round(n)) < 0.03 ? Math.round(n) : +n.toFixed(2);
    };
    const sec = document.activeElement.closest('.row-section');
    return { focused: laneOf(sec), above: laneOf(sec.previousElementSibling) };
  });
  check('the first row sits in the bottom lane under the hero', (await lanes()).focused === 2, JSON.stringify(await lanes()));
  await key('ArrowDown', 1, 0);
  await page.waitForTimeout(150);
  const midway = (await lanes()).focused;
  check('the rows glide to the next lane rather than jump', typeof midway === 'number' && midway > 1.05 && midway < 2.95, String(midway));
  await page.waitForTimeout(800);
  check('Down past the first row hides the hero', await browsing());
  check('the focused row moves to the middle lane, the first row to the top', JSON.stringify(await lanes()) === '{"focused":1,"above":0}', JSON.stringify(await lanes()));
  const fullRows = await page.evaluate(() => [...document.querySelectorAll('.home-screen .row-section')].filter((sec) => {
    const r = sec.querySelector('.meta-card .poster')?.getBoundingClientRect();
    return r && r.top >= 0 && r.bottom <= innerHeight;
  }).length);
  check('three rows fit on screen while browsing', fullRows >= 3, `${fullRows} rows`);
  check('genre rows are listed', (await page.locator('.home-screen h2.row-title').allTextContents()).some((t) => t.startsWith('Drama')));
  await shot('01b-home-browsing');
  await key('ArrowDown');
  await page.waitForTimeout(800);
  check('each Down keeps the focused row in the middle lane', JSON.stringify(await lanes()) === '{"focused":1,"above":0}', JSON.stringify(await lanes()));
  const rowCount = await page.locator('.home-screen .row-section').count();
  await key('ArrowDown', rowCount, 150);
  await page.waitForTimeout(900);
  check('Down on the last row stays there', await page.evaluate(() => !!document.activeElement.closest('.row-section') && !document.activeElement.closest('.row-section').nextElementSibling), await focusedText());
  check('the last row also stops in the middle lane', (await lanes()).focused === 1, JSON.stringify(await lanes()));
  await key('ArrowUp', rowCount - 2, 150);
  await page.waitForTimeout(800);
  check('Up keeps the focused row in the middle lane', JSON.stringify(await lanes()) === '{"focused":1,"above":0}', JSON.stringify(await lanes()));
  await key('ArrowUp');
  await page.waitForTimeout(800);
  check('Up to the first row brings the hero back', !(await browsing()), await focusedText());
  check('the first row is back in the bottom lane', (await lanes()).focused === 2, JSON.stringify(await lanes()));

  // ---- Focus zoom: animated once the app has settled ----
  await page.waitForFunction(() => document.documentElement.classList.contains('motion'), null, { timeout: 8000 }).catch(() => {});
  const poster = () => page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement.querySelector('.poster'));
    return { scale: new DOMMatrix(cs.transform).a, transition: cs.transitionDuration };
  });
  check('card focus animates once the app has settled', (await poster()).transition !== '0s', JSON.stringify(await poster()));
  await key('ArrowRight');
  const midZoom = (await poster()).scale;
  await page.waitForTimeout(400);
  const zoom = (await poster()).scale;
  check('the focused card grows', zoom > 1.12, String(zoom));
  check('the zoom animates in', midZoom < zoom, `${midZoom} -> ${zoom}`);
  await key('ArrowLeft');
  await page.waitForTimeout(400);

  // ---- Trailer previews ----
  await trailers(true);
  await key('ArrowRight');
  await key('ArrowLeft');
  await page.waitForTimeout(400);
  check('no trailer before resting on a title', (await page.locator('.hero-trailer.on').count()) === 0);
  await page.waitForTimeout(TRAILER_WAIT);
  check('resting on a first-row title plays its trailer in the hero', (await page.locator('.hero-trailer.on').count()) === 1);
  check('a trailer that cannot be embedded falls back to the next',
    (await page.locator('.hero-trailer .trailer-frame').getAttribute('src').catch(() => '')).includes('/mockTrailer'),
    await page.locator('.hero-trailer .trailer-frame').first().getAttribute('src').catch(() => 'none'));
  check('the hero trailer leaves focus on the card', (await focusedClass()).includes('meta-card'), await focusedText());
  await shot('01c-home-trailer');
  await key('ArrowUp');
  check('the trailer keeps playing on the hero buttons', (await page.locator('.hero-trailer.on').count()) === 1);
  await key('ArrowRight', 2);
  check('the hero has a Trailer button after Play and Details', (await focusedText()) === 'Trailer', await focusedText());
  await key('Enter');
  await page.waitForTimeout(800);
  check('the Trailer button plays it full screen', (await page.locator('.trailer-stage.on').count()) === 1);
  const stageTitle = await page.locator('.trailer-stage .title-text').textContent().catch(() => '');
  check('the full-screen trailer names the title', stageTitle === 'Mock Movie 1', stageTitle);
  await shot('01d-home-trailer-full');
  await key('ArrowLeft');
  await page.waitForTimeout(700);
  check('a key closes the full-screen trailer', (await page.locator('.trailer-stage').count()) === 0);
  check('the key that closes it does not move focus', (await focusedText()) === 'Trailer', await focusedText());
  await key('ArrowDown');
  await key('ArrowRight');
  check('moving on stops the trailer', (await page.locator('.hero-trailer.on').count()) === 0);
  await key('ArrowLeft');
  // down to a row of movies (the mock series has no trailer)
  let downs = 0;
  do { await key('ArrowDown'); downs++; } while (!(await focusedText()).startsWith('Mock Movie') && downs < 5);
  await page.waitForTimeout(TRAILER_WAIT + 400);
  const previewing = () => page.evaluate(() => document.querySelector('.home-screen').classList.contains('previewing'));
  check('below the first row the trailer plays in the hero', (await previewing()) && (await page.locator('.hero-trailer.on').count()) === 1);
  const heroTitle = await page.locator('.hero-content .title-text').textContent().catch(() => '');
  check('the hero comes back for that title', heroTitle && (await focusedText()).includes(heroTitle), `${heroTitle} / ${await focusedText()}`);
  check('its row slides down to the bottom lane', (await lanes()).focused === 2, JSON.stringify(await lanes()));
  check('the rows above it fade out', await page.evaluate(() =>
    getComputedStyle(document.activeElement.closest('.row-section').previousElementSibling).opacity === '0'));
  check('no full-screen trailer on Home', (await page.locator('.trailer-stage').count()) === 0);
  await shot('01e-home-trailer-preview');
  const beforeKey = await focusedText();
  await key('ArrowRight');
  await page.waitForTimeout(800);
  check('moving on ends the preview', !(await previewing()) && (await page.locator('.hero-trailer.on').count()) === 0);
  check('the key still moves focus', (await focusedText()) !== beforeKey, await focusedText());
  check('the rows slide back: focused row in the middle lane', (await lanes()).focused === 1, JSON.stringify(await lanes()));
  check('the rows above show again', await page.evaluate(() =>
    getComputedStyle(document.activeElement.closest('.row-section').previousElementSibling).opacity === '1'));
  await key('ArrowLeft');
  await trailers(false);
  await key('ArrowUp', downs);
  await page.waitForTimeout(800);

  // ---- Arrow key navigation within a row ----
  const before = await focusedText();
  await key('ArrowRight');
  const after = await focusedText();
  check('ArrowRight moves to the next card', before !== after, `${before} -> ${after}`);
  await key('ArrowLeft');
  check('ArrowLeft moves back', (await focusedText()) === before);

  // ---- Hero follows focus (debounced) and is one press Up ----
  const heroId = () => page.evaluate(() => document.querySelector('.screen:not(.hidden) .hero-content')?.dataset.id || '');
  await page.waitForTimeout(600);
  check('hero shows the focused title', (await heroId()) === 'mock:movie1', await heroId());
  await key('ArrowRight');
  check('hero waits while focus is moving (debounce)', (await heroId()) === 'mock:movie1', await heroId());
  await page.waitForTimeout(700);
  check('hero updates when focus moves along the row', (await heroId()) === 'mock:movie2', await heroId());
  check('hero shows the title name', (await page.locator('.hero-content .title-text').textContent()).includes('Mock Movie 2'));
  await key('ArrowUp');
  check('Up from the row reaches the hero Play button', (await focusedClass()).includes('hero-play'), await focusedText());
  await key('ArrowRight');
  check('Details sits next to Play', (await focusedClass()).includes('hero-details'), await focusedText());
  await key('Enter');
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  check('hero Details opens the focused title', (await page.locator('.detail-title').textContent()).includes('Mock Movie 2'));
  await key('Escape');
  await page.waitForTimeout(300);
  check('Back returns to the hero button', (await focusedClass()).includes('hero-details'), await focusedText());
  await key('ArrowDown');
  check('Down from the hero returns to the card it shows', (await focusedText()).includes('Mock Movie 2'), await focusedText());
  await key('ArrowLeft');
  await page.waitForTimeout(400);

  // ---- Left from leftmost card reaches the nav rail, on the current screen ----
  await key('ArrowLeft');
  check('sidebar reachable with Left', (await focusedClass()).includes('sidebar-item'), await focusedText());
  check('the rail opens on the current screen (Home)', (await focusedText()) === 'Home', await focusedText());
  await key('ArrowLeft');
  check('Left on the rail stays on the rail', (await focusedText()) === 'Home', await focusedText());
  await key('ArrowDown', 10, 60);
  check('Down at the bottom of the rail stays on the rail', (await focusedClass()).includes('sidebar-item'), await focusedText());
  await page.evaluate(() => document.querySelector('[data-screen="home"]').focus());
  await shot('02-sidebar');

  // ---- Sidebar -> Discover ----
  await page.evaluate(() => document.querySelector('[data-screen="discover"]').focus());
  await key('Enter');
  await page.waitForSelector('.meta-grid .meta-card', { timeout: 10000 });
  check('discover grid renders', await page.locator('.meta-grid .meta-card').count() >= 10);
  await shot('03-discover');

  // Discover: no trailer by itself; a Trailer button over the focused title
  await page.evaluate(() => document.querySelector('.meta-grid .meta-card').focus());
  await page.waitForTimeout(TRAILER_WAIT + 400);
  check('Discover does not start trailers by itself', (await page.locator('.trailer-stage').count()) === 0);
  const pill = page.locator('.trailer-pill');
  check('a focused Discover title gets a Trailer button', await pill.isVisible());
  check('the Trailer button sits over its poster', await page.evaluate(() => {
    const p = document.querySelector('.trailer-pill').getBoundingClientRect();
    const c = document.activeElement.getBoundingClientRect();
    return p.left > c.left && p.right < c.right && p.top > c.top && p.bottom < c.bottom;
  }));
  const discoverCard = await focusedText();
  await key('ArrowDown');
  check('Down from the title reaches its Trailer button', (await focusedClass()).includes('trailer-pill'), await focusedText());
  await shot('03a-discover-trailer-button');
  await key('Enter');
  await page.waitForTimeout(800);
  check('the Trailer button plays it full screen', (await page.locator('.trailer-stage.on').count()) === 1);
  check('the trailer is the focused title\'s',
    discoverCard.includes(await page.locator('.trailer-stage .title-text').textContent().catch(() => '?')));
  await shot('03b-discover-trailer');
  await key('Escape');
  await page.waitForTimeout(700);
  check('Back closes the trailer and stays on the button',
    (await page.locator('.trailer-stage').count()) === 0 && (await focusedClass()).includes('trailer-pill'), await focusedText());
  await key('ArrowUp');
  check('Up returns to the title', (await focusedText()) === discoverCard, await focusedText());
  await key('ArrowRight');
  await page.waitForTimeout(300);
  check('the button follows focus to the next title', await page.evaluate(() => {
    const p = document.querySelector('.trailer-pill').getBoundingClientRect();
    const c = document.activeElement.getBoundingClientRect();
    return !document.querySelector('.trailer-pill').hidden && p.left > c.left && p.right < c.right;
  }));

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

  // Backgrounding the app pauses playback and stays paused on return
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  check('hiding the app pauses playback', await page.evaluate(() => document.querySelector('#player-root video').paused));
  check('paused overlay is shown', await page.evaluate(() => document.getElementById('player-root').classList.contains('show-controls')));
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(6000); // longer than the 5s auto-hide
  check('stays paused after returning', await page.evaluate(() => document.querySelector('#player-root video').paused));
  check('overlay stays visible while paused', await page.evaluate(() => document.getElementById('player-root').classList.contains('show-controls')));
  await key('Enter'); // focused Play button resumes
  await page.waitForTimeout(300);
  check('OK resumes after background pause', !(await page.evaluate(() => document.querySelector('#player-root video').paused)));
  await key('Escape'); // hide controls, back to lean-back mode
  await page.waitForTimeout(300);

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
  check('continue watching uses wide cards with progress',
    await page.locator('.screen:not(.hidden) .meta-card.wide .progress-strip').count() > 0);
  await page.waitForTimeout(600);
  await shot('08b-home-continue');

  // Series detail: seasons + episodes
  await page.evaluate(() => {
    [...document.querySelectorAll('.screen:not(.hidden) .meta-card')].find((c) => c.textContent.includes('Mock Series'))?.focus();
  });
  check('series card focused', (await focusedText()).includes('Mock Series'));
  await key('Enter');
  await page.waitForSelector('.episode-item', { timeout: 10000 });
  check('episode list renders', await page.locator('.episode-item').count() === 3);
  check('detail shows when the next episode airs',
    ((await page.locator('.detail-body .next-episode').textContent().catch(() => '')) || '').includes('S2 E3'),
    await page.locator('.detail-body .next-episode').textContent().catch(() => 'missing'));
  await page.waitForTimeout(300);
  check('series Play starts at the first episode', (await focusedText()).includes('Play S1 E1'), await focusedText());
  await key('ArrowDown');
  check('Down reaches the season chips', (await focusedClass()).includes('season-chip'), await focusedText());
  await key('ArrowRight');
  await key('Enter');
  check('a season chip switches the episodes', (await page.locator('.episode-item').first().textContent()).includes('Season 2'));
  check('focus stays on the season chip', (await focusedText()) === 'Season 2', await focusedText());
  await key('ArrowDown');
  check('Down reaches the episode cards', (await focusedClass()).includes('episode-item'), await focusedText());
  await page.waitForTimeout(300);
  await shot('09-series');

  // ---- Type-anywhere search: pressing a letter jumps into Search ----
  await page.keyboard.type('m');
  await page.waitForSelector('.osk-rows', { timeout: 5000 });
  check('typing anywhere opens the search keyboard', true);
  await page.waitForTimeout(300);
  await page.keyboard.type('ock s', { delay: 80 });
  check('typed characters captured', (await page.locator('.osk-display').textContent()).includes('mock s'));

  // Backspace edits the query instead of closing the keyboard
  await key('Backspace');
  await page.waitForTimeout(150);
  check('keyboard stays open on Backspace', (await page.locator('.osk-rows').count()) === 1);
  const afterBs = await page.locator('.osk-display').textContent();
  check('Backspace deleted one character', afterBs.includes('mock') && !afterBs.includes('mock s'), afterBs.trim());

  // Live results while typing (no Done needed)
  await page.keyboard.type('series', { delay: 80 }); // query: "mock series"
  await page.waitForTimeout(1400); // debounce + fetch
  check('live results appear while typing', (await page.locator('.screen:not(.hidden)').textContent()).includes('Mock Series'));
  check('top matches list the series while typing',
    (await page.locator('.search-match').allTextContents()).some((t) => t.includes('Mock Series')));
  await shot('10-osk');

  // Paste with Ctrl+V
  await page.evaluate(() => navigator.clipboard.writeText('PASTED'));
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(400);
  check('Ctrl+V pastes from clipboard', (await page.locator('.osk-display').textContent()).includes('mock seriesPASTED'));
  check('a Paste key exists on the keyboard', await page.evaluate(() =>
    [...document.querySelectorAll('.osk-key')].some((k) => k.textContent === 'Paste')));
  await key('Backspace', 6, 60); // remove PASTED again

  // Done -> results kept, focus lands on a result
  await page.evaluate(() => {
    const keys = [...document.querySelectorAll('.osk-key')];
    keys.find((k) => k.textContent === 'Done').focus();
  });
  await key('Enter');
  await page.waitForTimeout(1200);
  const searchText = await page.locator('.screen:not(.hidden)').textContent();
  check('search finds the series', searchText.includes('Mock Series'), searchText.slice(0, 120));
  check('a top match is focused after Done', (await focusedClass()).includes('search-match'), await focusedText());
  await shot('11-search-results');

  // ---- Remote only: → from the keyboard reaches the matches, OK opens one ----
  await page.evaluate(() => [...document.querySelectorAll('.osk-key')].find((k) => k.textContent === '0').focus());
  await key('ArrowRight');
  check('→ from the keyboard moves into the top matches', (await focusedClass()).includes('search-match'), await focusedText());
  await key('Enter');
  await page.waitForSelector('.detail-title', { timeout: 10000 });
  check('OK on a top match opens its detail page', (await page.locator('.detail-title').textContent()).includes('Mock'));
  check('the search was saved to history', await page.evaluate(() =>
    JSON.parse(localStorage.getItem('stv.searchHistory') || '[]')[0] === 'mock series'));
  await key('Escape');
  await page.waitForTimeout(300);
  check('Back returns to the search with the query kept', (await page.locator('.osk-display').textContent()).includes('mock series'));

  // ---- Recent searches: an empty query lists them; OK reruns one ----
  await page.evaluate(() => document.querySelector('[data-screen="search"]').focus());
  await key('Enter');
  await page.waitForSelector('.search-recent', { timeout: 5000 });
  check('recent searches are listed', (await page.locator('.search-recent').first().textContent()).includes('mock series'));
  await page.evaluate(() => document.querySelector('.search-recent').focus());
  await key('Enter');
  await page.waitForSelector('.search-match', { timeout: 8000 });
  check('OK on a recent search runs it again', (await page.locator('.osk-display').textContent()).includes('mock series'));
  check('focus lands on the first match', (await focusedClass()).includes('search-match'), await focusedText());
  await shot('12-search-history');

  // ---- Settings + addons reachable ----
  await page.evaluate(() => document.querySelector('[data-screen="settings"]').focus());
  await key('Enter');
  await page.waitForSelector('.list-item');
  check('settings renders', (await page.locator('.screen:not(.hidden)').textContent()).includes('Streaming server'));
  await shot('12c-settings');
  await page.evaluate(() => document.querySelector('[data-screen="library"]').focus());
  await key('Enter');
  await page.waitForSelector('.meta-grid .meta-card', { timeout: 5000 });
  check('library lists the watched title', (await page.locator('.meta-grid .meta-card').first().textContent()).includes('Mock Movie 1'));
  check('library card is focused', (await focusedClass()).includes('meta-card'), await focusedText());
  await page.waitForTimeout(300);
  await shot('12d-library');
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
