// Discover: pick a catalog + genre, browse a paginated grid.

import { el, metaCard, toast, pickerModal } from '../ui.js';
import { browsableCatalogs, getCatalog, genreOptions } from '../addons.js';
import { Nav } from '../nav.js';

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

  const catalogBtn = el('button', { class: 'focusable btn', 'data-nav-default': '' });
  const genreBtn = el('button', { class: 'focusable btn' });
  const grid = el('div', { class: 'meta-grid' });
  root.append(el('div', { class: 'selector-bar' }, catalogBtn, genreBtn), grid);

  function current() { return catalogs[state.index]; }

  function catalogLabel({ addon, catalog }) {
    return `${catalog.name || catalog.id} · ${catalog.type} (${addon.manifest.name})`;
  }

  function refreshButtons() {
    catalogBtn.textContent = '▾ ' + catalogLabel(current());
    const genres = genreOptions(current().catalog);
    genreBtn.textContent = '▾ ' + (state.genre || 'All genres');
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
        card.addEventListener('focus', () => {
          // infinite scroll: nearing the end loads the next page
          const cards = [...grid.children];
          if (cards.indexOf(card) >= cards.length - 10) loadMore();
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
      if (!grid.children.length) grid.append(el('div', { class: 'empty-note', text: 'Nothing here.' }));
    }
  }

  function reset() {
    grid.innerHTML = '';
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
