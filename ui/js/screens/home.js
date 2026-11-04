// Home: a full-bleed hero for the focused title above Continue Watching + one
// row per browsable addon catalog, then a few genre rows. The screen is three
// lanes of rows. The hero fills the top two while focus is on the first row
// (which sits in the bottom lane); it follows focus along that row (debounced,
// crossfaded) and its Play/Details buttons sit one press Up. Past the first
// row the hero fades out and the focused row slides to the middle lane.
// Resting on a title plays its trailer in the hero; below the first row the
// rows slide down a lane for it (the focused one to the bottom, the ones
// above it fading out) and slide back when focus moves on.

import { el, metaCard, toast, titleArt, factsRow, nextEpisodeLine } from '../ui.js';
import { Storage } from '../storage.js';
import { browsableCatalogs, getCatalog, catalogRequiredExtra, catalogSupportsExtra, genreOptions } from '../addons.js';
import { playFlow, resumeFlow } from '../streams.js';
import { Nav } from '../nav.js';
import { icon, iconSvg } from '../icons.js';
import { backdropUrl, logoUrl, cachedMeta, preload, imdbId, nextEpisodeText, trailerIds } from '../art.js';
import { trailerPreviews, playTrailer } from '../trailer.js';

const ROW_LIMIT = 8; // catalog rows on home; full browsing lives in Discover
const GENRE_ROWS = ['Drama', 'Comedy', 'Action', 'Thriller', 'Sci-Fi']; // when the catalog offers them
const HERO_DEBOUNCE_MS = 250;
const FADE_MS = 180;
const LOGO_WAIT_MS = 800;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function render({ router }) {
  const root = el('div', { class: 'screen home-screen' });

  // ---- hero ----
  const backdrops = [el('div', { class: 'hero-backdrop' }), el('div', { class: 'hero-backdrop' })];
  const artSlot = el('div');
  const factsSlot = el('div');
  const desc = el('div', { class: 'hero-desc' });
  const playLabel = el('span');
  const playIcon = el('span', { class: 'btn-icon' });
  const playBtn = el('button', { class: 'focusable btn primary hero-play' }, playIcon, playLabel);
  const detailsBtn = el('button', { class: 'focusable btn hero-details' }, icon('info'), 'Details');
  // shown for titles that list a trailer
  const trailerBtn = el('button', { class: 'focusable btn hero-trailer-btn' }, icon('play'), 'Trailer');
  trailerBtn.hidden = true;
  const heroContent = el('div', { class: 'hero-content hidden' },
    artSlot, factsSlot, desc, el('div', { class: 'btn-row' }, playBtn, detailsBtn, trailerBtn));
  const trailer = el('div', { class: 'hero-trailer' });
  // Down on the last row stays there rather than dropping onto the rail.
  const rows = el('div', { class: 'home-rows', 'data-scroll': 'start', 'data-nav-stop': 'down' });
  root.append(...backdrops, trailer, el('div', { class: 'hero-scrim' }), heroContent, rows);

  // card: the row card the hero describes; seq drops stale async updates.
  const hero = { card: null, pending: null, timer: null, seq: 0, front: 0, meta: null, type: null, entry: null };

  function setBackdrop(url) {
    const next = backdrops[1 - hero.front];
    next.style.backgroundImage = url ? `url("${url}")` : 'none';
    next.classList.add('on');
    backdrops[hero.front].classList.remove('on');
    hero.front = 1 - hero.front;
  }

  function fillText(meta, { logoLoaded } = {}) {
    artSlot.replaceChildren(titleArt(meta, { logoLoaded }));
    factsSlot.replaceChildren(factsRow(meta), nextEpisodeLine(meta) || '');
    desc.textContent = meta.description || '';
    heroContent.dataset.id = meta.id;
  }

  function fillButtons() {
    const { meta, type, entry } = hero;
    let label = 'Play';
    if (entry && entry.time > 10) label = entry.videoLabel ? `Resume ${entry.videoLabel.split(' — ')[0]}` : 'Resume';
    else if (type === 'series') label = 'Episodes';
    playLabel.textContent = label;
    playIcon.innerHTML = iconSvg('play');
    heroContent.dataset.type = type;
    detailsBtn.dataset.id = meta.id;
    trailerBtn.hidden = !trailerIds(meta).length;
  }

  async function showHero(card) {
    const seq = ++hero.seq;
    const meta = card._meta;
    hero.card = card;
    hero.meta = meta;
    hero.type = meta.type || card._type;
    hero.entry = Storage.getLibraryEntry(hero.type, meta.id);

    const first = heroContent.classList.contains('hidden');
    if (!first) heroContent.classList.add('swap');
    const logo = logoUrl(meta);
    const [logoLoaded] = await Promise.all([
      logo ? Promise.race([preload(logo), wait(LOGO_WAIT_MS).then(() => false)]) : false,
      first ? null : wait(FADE_MS),
    ]);
    if (seq !== hero.seq) return;
    fillText(meta, { logoLoaded });
    fillButtons();
    heroContent.classList.remove('hidden', 'swap');

    const bg = backdropUrl(meta);
    preload(bg).then((ok) => { if (seq === hero.seq) setBackdrop(ok ? bg : null); });

    // Catalog items are often thin (no synopsis, runtime or backdrop):
    // fill those in from the full meta without another fade.
    // Series also need their episode list for the next-episode line, and
    // the Trailer button the trailer list.
    if (meta.description && meta.background && meta.runtime && (hero.type !== 'series' || meta.videos)
      && trailerIds(meta).length) return;
    const full = await cachedMeta(hero.type, meta.id);
    if (!full || seq !== hero.seq) return;
    const merged = { ...meta, ...full, type: hero.type };
    hero.meta = merged;
    fillText(merged, { logoLoaded: logoLoaded && logoUrl(merged) === logo });
    trailerBtn.hidden = !trailerIds(merged).length;
    if (full.background && full.background !== bg && await preload(full.background) && seq === hero.seq) {
      setBackdrop(full.background);
    }
  }

  rows.addEventListener('focusin', (e) => {
    const card = e.target.closest?.('.meta-card');
    if (!card) return;
    // Below the first row: hide the hero (and keep its buttons out of reach)
    // so the rows get the whole screen. The hero only describes row one.
    const browsing = card.closest('.row-section') !== rows.querySelector('.row-section');
    root.classList.toggle('browsing', browsing);
    heroContent.inert = browsing;
    if (browsing || card === hero.pending) return;
    hero.pending = card;
    clearTimeout(hero.timer);
    if (!hero.card) showHero(card); // first fill: no wait
    else hero.timer = setTimeout(() => showHero(card), HERO_DEBOUNCE_MS);
  });

  async function fullMeta() {
    const { meta, type } = hero;
    const full = (await cachedMeta(type, meta.id)) || meta;
    return { ...meta, ...full, type };
  }

  playBtn.addEventListener('click', async () => {
    const { meta, type, entry } = hero;
    if (!meta) return;
    try {
      if (entry && entry.time > 10) await resumeFlow(await fullMeta(), entry);
      else if (type === 'series') router.push('detail', { type, id: meta.id, preview: meta });
      else await playFlow(await fullMeta(), null);
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  trailerBtn.addEventListener('click', () => { if (hero.meta) playTrailer(hero.meta); });
  detailsBtn.addEventListener('click', () => {
    if (hero.meta) router.push('detail', { type: hero.type, id: hero.meta.id, preview: hero.meta });
  });

  // Down from the hero buttons goes back to the card the hero describes,
  // not whichever card happens to sit under the button.
  function heroKeys(e) {
    if (!root.isConnected) { Nav.popKeyHandler(heroKeys); return false; }
    if (e.key !== 'ArrowDown' || !heroContent.contains(document.activeElement)) return false;
    if (!hero.card || !hero.card.isConnected) return false;
    Nav.focus(hero.card);
    return true;
  }
  Nav.pushKeyHandler(heroKeys);

  // A trailer below the first row: the hero comes back for that card, and
  // the rows slide down so the card's row sits in the bottom lane under it.
  function enterPreview(card) {
    if (document.activeElement !== card) return;
    clearTimeout(hero.timer);
    hero.pending = card;
    showHero(card);
    const sec = card.closest('.row-section');
    for (let s = sec.previousElementSibling; s; s = s.previousElementSibling) s.classList.add('above');
    root.classList.add('previewing');
    const cs = getComputedStyle(rows);
    // the bottom lane: one lane (the bottom padding) below where rows pin
    Nav.glideTo(rows, sec.offsetTop - parseFloat(cs.scrollPaddingTop) - parseFloat(cs.paddingBottom));
  }

  function exitPreview() {
    if (!root.classList.contains('previewing')) return;
    root.classList.remove('previewing');
    rows.querySelectorAll('.row-section.above').forEach((s) => s.classList.remove('above'));
    // Focus that moved on has already placed its row; a trailer that ended
    // by itself leaves the row to slide back up.
    const cur = document.activeElement;
    if (rows.contains(cur)) Nav.reveal(cur);
  }

  // Plays in the hero: on the first row while the hero shows the card (and
  // on through its buttons), below it in the preview layout.
  trailerPreviews(root, {
    inline: (card) => {
      if (!root.classList.contains('browsing')) {
        return hero.card === card ? { host: trailer, keeps: (t) => t === card || heroContent.contains(t) } : null;
      }
      return { host: trailer, keeps: (t) => t === card, onPlay: () => enterPreview(card), onStop: exitPreview };
    },
  });

  // ---- rows ----
  function section(title, row) {
    return el('section', { class: 'row-section' }, title, row);
  }

  const cw = Storage.continueWatching();
  if (cw.length) {
    const row = el('div', { class: 'meta-row' });
    cw.slice(0, 20).forEach((entry) => {
      const progress = entry.duration ? entry.time / entry.duration : 0;
      const left = entry.duration ? Math.max(1, Math.round((entry.duration - entry.time) / 60)) : null;
      const sub = [entry.videoLabel, left ? `${left} min left` : null].filter(Boolean).join(' · ');
      const card = metaCard(entry, {
        wide: true,
        progress,
        sub,
        onSelect: async () => {
          try {
            const meta = (await cachedMeta(entry.type, entry.id)) || entry;
            await resumeFlow(meta, entry);
          } catch (e) {
            toast('Could not resume: ' + e.message, 'error');
          }
        },
      });
      card._type = entry.type;
      // Saved progress only keeps the poster; non-IMDb titles get their
      // backdrop from the full meta, series their next episode's date.
      if (!imdbId(entry) || entry.type === 'series') {
        cachedMeta(entry.type, entry.id).then((m) => {
          if (!m) return;
          const art = card.querySelector('.poster');
          const next = entry.type === 'series' && nextEpisodeText(m);
          if (next) art.append(el('div', { class: 'card-badge', text: next }));
          if (imdbId(entry) || !m.background) return;
          art.dataset.bg = m.background;
          if (art.style.backgroundImage) art.style.backgroundImage = `url("${m.background}")`;
        });
      }
      row.append(card);
    });
    rows.append(section(el('h2', { class: 'row-title', text: 'Continue Watching' }), row));
  }

  // Catalogs that need a genre (Cinemeta's "New" by year) open on their
  // first option, the newest year.
  const specs = [];
  for (const { addon, catalog } of browsableCatalogs()) {
    const needsGenre = catalogRequiredExtra(catalog).includes('genre');
    const genre = needsGenre ? genreOptions(catalog)[0] : undefined;
    if (needsGenre && !genre) continue;
    specs.push({ addon, catalog, genre, title: catalog.name || catalog.id,
      sub: [catalog.type, genre, addon.manifest.name].filter(Boolean).join(' · ') });
  }
  specs.splice(ROW_LIMIT);
  // Genre rows come from the first movie catalog that can filter by genre.
  const byGenre = browsableCatalogs().find(({ catalog }) => catalog.type === 'movie'
    && catalogSupportsExtra(catalog, 'genre') && !catalogRequiredExtra(catalog).length);
  if (byGenre) {
    const offered = genreOptions(byGenre.catalog);
    for (const genre of GENRE_ROWS.filter((g) => offered.includes(g))) {
      specs.push({ ...byGenre, genre, title: genre, sub: `${byGenre.catalog.type} · ${byGenre.addon.manifest.name}` });
    }
  }

  if (!specs.length && !cw.length) {
    rows.append(el('div', { class: 'empty-note', text: 'No catalogs yet. Go to Add-ons (left menu) and install Cinemeta or your AIOStreams addon.' }));
  }

  for (const { addon, catalog, genre, title: name, sub } of specs) {
    const title = el('h2', { class: 'row-title', text: name }, el('span', { class: 'row-sub', text: sub }));
    const row = el('div', { class: 'meta-row' }, el('div', { class: 'empty-note', text: 'Loading…' }));
    const sec = section(title, row);
    rows.append(sec);
    getCatalog(addon, catalog.type, catalog.id, { genre })
      .then((metas) => {
        row.innerHTML = '';
        if (!metas.length) { sec.remove(); return; }
        metas.slice(0, 25).forEach((meta) => {
          const card = metaCard(meta, {
            onSelect: () => router.push('detail', { type: meta.type || catalog.type, id: meta.id, preview: meta }),
          });
          card._type = catalog.type;
          row.append(card);
        });
      })
      .catch(() => sec.remove());
  }

  return root;
}
