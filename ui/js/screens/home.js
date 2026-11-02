// Home: a full-bleed hero for the focused title above Continue Watching + one
// row per browsable addon catalog. The hero follows focus along the rows
// (debounced, crossfaded); its Play/Details buttons sit one press Up.

import { el, metaCard, toast, titleArt, factsRow } from '../ui.js';
import { Storage } from '../storage.js';
import { browsableCatalogs, getCatalog } from '../addons.js';
import { playFlow, resumeFlow } from '../streams.js';
import { Nav } from '../nav.js';
import { icon, iconSvg } from '../icons.js';
import { backdropUrl, logoUrl, cachedMeta, preload, imdbId } from '../art.js';

const ROW_LIMIT = 8; // rows on home; full browsing lives in Discover
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
  const heroContent = el('div', { class: 'hero-content hidden' },
    artSlot, factsSlot, desc, el('div', { class: 'btn-row' }, playBtn, detailsBtn));
  const rows = el('div', { class: 'home-rows', 'data-scroll': 'start' });
  root.append(...backdrops, el('div', { class: 'hero-scrim' }), heroContent, rows);

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
    factsSlot.replaceChildren(factsRow(meta));
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
    if (meta.description && meta.background && meta.runtime) return;
    const full = await cachedMeta(hero.type, meta.id);
    if (!full || seq !== hero.seq) return;
    const merged = { ...meta, ...full, type: hero.type };
    hero.meta = merged;
    fillText(merged, { logoLoaded: logoLoaded && logoUrl(merged) === logo });
    if (full.background && full.background !== bg && await preload(full.background) && seq === hero.seq) {
      setBackdrop(full.background);
    }
  }

  rows.addEventListener('focusin', (e) => {
    const card = e.target.closest?.('.meta-card');
    if (!card || card === hero.pending) return;
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
      // backdrop from the full meta.
      if (!imdbId(entry)) {
        cachedMeta(entry.type, entry.id).then((m) => {
          if (!m?.background) return;
          const art = card.querySelector('.poster');
          art.dataset.bg = m.background;
          if (art.style.backgroundImage) art.style.backgroundImage = `url("${m.background}")`;
        });
      }
      row.append(card);
    });
    rows.append(section(el('h2', { class: 'row-title', text: 'Continue Watching' }), row));
  }

  const catalogs = browsableCatalogs().slice(0, ROW_LIMIT);
  if (!catalogs.length && !cw.length) {
    rows.append(el('div', { class: 'empty-note', text: 'No catalogs yet. Go to Add-ons (left menu) and install Cinemeta or your AIOStreams addon.' }));
  }

  for (const { addon, catalog } of catalogs) {
    const title = el('h2', { class: 'row-title', text: catalog.name || catalog.id },
      el('span', { class: 'row-sub', text: `${catalog.type} · ${addon.manifest.name}` }));
    const row = el('div', { class: 'meta-row' }, el('div', { class: 'empty-note', text: 'Loading…' }));
    const sec = section(title, row);
    rows.append(sec);
    getCatalog(addon, catalog.type, catalog.id)
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
