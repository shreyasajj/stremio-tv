// Discover: pick a catalog + genre, browse a paginated grid. A focused title
// that has a trailer gets a Trailer button over its poster (one press Down),
// which plays it full screen.

import { el, metaCard, toast, pickerModal } from '../ui.js';
import { browsableCatalogs, getCatalog, genreOptions } from '../addons.js';
import { Nav } from '../nav.js';
import { icon } from '../icons.js';
import { cachedMeta, trailerIds } from '../art.js';
import { playTrailer } from '../trailer.js';

const PAGE = 50;

export async function render({ router }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Discover' }));

  const catalogs = browsableCatalogs();
  if (!catalogs.length) {
    root.append(el('div', { class: 'empty-note', text: 'No browsable catalogs. Install a catalog addon (e.g. Cinemeta) in Add-ons.' }));
    return root;
  }

  const state = { index: 0, genre: '', skip: 0, loading: false, exhausted: false };

  const catalogLabelEl = el('span');
  const genreLabelEl = el('span');
  const catalogBtn = el('button', { class: 'focusable btn', 'data-nav-default': '' }, catalogLabelEl, icon('chevronDown'));
  const genreBtn = el('button', { class: 'focusable btn' }, genreLabelEl, icon('chevronDown'));
  const grid = el('div', { class: 'meta-grid', 'data-nav-stop': 'down' });
  // One Trailer button, moved to whichever title it belongs to. It lives in
  // the grid (positioned, so it takes no cell) to share the grid's Down edge.
  const trailerBtn = el('button', { class: 'focusable btn trailer-pill' }, icon('play'), 'Trailer');
  trailerBtn.hidden = true;
  root.append(el('div', { class: 'selector-bar' }, catalogBtn, genreBtn), grid);
  const cards = () => grid.querySelectorAll('.meta-card');
  let trailerFor = null; // { card, meta }

  async function offerTrailer(card) {
    trailerFor = null;
    trailerBtn.hidden = true;
    const meta = { ...card._meta, ...(await cachedMeta(card._type, card._meta.id)), type: card._type };
    if (document.activeElement !== card || !trailerIds(meta).length) return;
    trailerFor = { card, meta };
    trailerBtn.hidden = false;
    // centred over the bottom of the poster
    trailerBtn.style.left = `${card.offsetLeft + (card.offsetWidth - trailerBtn.offsetWidth) / 2}px`;
    trailerBtn.style.top = `${card.offsetTop + card.querySelector('.poster').offsetHeight - trailerBtn.offsetHeight - 14}px`;
  }

  grid.addEventListener('focusin', (e) => {
    const card = e.target.closest?.('.meta-card');
    if (card) offerTrailer(card);
  });
  // Leaving the grid hides it; the button keeps it (with its title).
  root.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !grid.contains(e.relatedTarget)) { trailerFor = null; trailerBtn.hidden = true; }
  });
  trailerBtn.addEventListener('click', () => { if (trailerFor) playTrailer(trailerFor.meta); });

  function current() { return catalogs[state.index]; }

  function catalogLabel({ addon, catalog }) {
    return `${catalog.name || catalog.id} · ${catalog.type} (${addon.manifest.name})`;
  }

  function refreshButtons() {
    catalogLabelEl.textContent = catalogLabel(current());
    const genres = genreOptions(current().catalog);
    genreLabelEl.textContent = state.genre || 'All genres';
    genreBtn.style.display = genres.length ? '' : 'none';
  }

  async function loadMore() {
    if (state.loading || state.exhausted) return;
    state.loading = true;
    const { addon, catalog } = current();
    const extra = {};
    if (state.genre) extra.genre = state.genre;
    if (state.skip) extra.skip = state.skip;
    try {
      const metas = await getCatalog(addon, catalog.type, catalog.id, extra);
      if (!metas.length) state.exhausted = true;
      metas.forEach((meta) => {
        const card = metaCard(meta, {
          onSelect: () => router.push('detail', { type: meta.type || catalog.type, id: meta.id, preview: meta }),
        });
        card._type = catalog.type;
        card.addEventListener('focus', () => {
          // infinite scroll: nearing the end loads the next page
          const all = [...cards()];
          if (all.indexOf(card) >= all.length - 10) loadMore();
        });
        grid.append(card);
      });
      state.skip += metas.length;
      if (metas.length < 20) state.exhausted = true;
    } catch (e) {
      toast('Catalog failed: ' + e.message, 'error');
      state.exhausted = true;
    } finally {
      state.loading = false;
      if (!cards().length) grid.append(el('div', { class: 'empty-note', text: 'Nothing here.' }));
    }
  }

  function reset() {
    trailerFor = null;
    trailerBtn.hidden = true;
    grid.replaceChildren(trailerBtn);
    state.skip = 0;
    state.exhausted = false;
    refreshButtons();
    loadMore();
  }

  catalogBtn.addEventListener('click', async () => {
    const chosen = await pickerModal('Choose a catalog',
      catalogs.map((c, i) => ({ label: catalogLabel(c), value: i })),
      { selectedValue: state.index });
    if (chosen !== null && chosen !== state.index) {
      state.index = chosen;
      state.genre = '';
      reset();
      Nav.focus(catalogBtn);
    }
  });

  genreBtn.addEventListener('click', async () => {
    const genres = genreOptions(current().catalog);
    const chosen = await pickerModal('Genre',
      [{ label: 'All genres', value: '' }, ...genres.map((g) => ({ label: g, value: g }))],
      { selectedValue: state.genre });
    if (chosen !== null && chosen !== state.genre) {
      state.genre = chosen;
      reset();
      Nav.focus(genreBtn);
    }
  });

  reset();
  return root;
}
