// Search: on-screen keyboard feeding every search-capable addon catalog.
// Results update live while you type (physical keyboard or OSK); the keyboard
// docks to the left so results stay visible. Typing a letter anywhere in the
// app lands here with the keyboard already open (see main.js).

import { el, metaCard } from '../ui.js';
import { searchableCatalogs, getCatalog } from '../addons.js';
import { oskPrompt } from '../keyboard.js';
import { Nav } from '../nav.js';

const LIVE_DEBOUNCE_MS = 450;

export async function render({ router, params = {} }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Search' }));

  const queryBtn = el('button', { class: 'focusable btn primary', 'data-nav-default': '', text: '⌨  Type to search' });
  const results = el('div');
  root.append(el('div', { class: 'btn-row' }, queryBtn), results);

  let seq = 0;
  let liveTimer = null;
  let keyboardOpen = false;

  function setQuery(q) {
    queryBtn.dataset.q = q;
    queryBtn.textContent = q ? `⌨  ${q}` : '⌨  Type to search';
  }

  async function runSearch(q) {
    const mySeq = ++seq;
    if (!q || q.trim().length < 2) { results.innerHTML = ''; return; }
    const catalogs = searchableCatalogs();
    if (!catalogs.length) {
      results.innerHTML = '';
      results.append(el('div', { class: 'empty-note', text: 'No search-capable addons installed.' }));
      return;
    }
    const groups = await Promise.allSettled(
      catalogs.map(async ({ addon, catalog }) => ({
        addon, catalog,
        metas: await getCatalog(addon, catalog.type, catalog.id, { search: q.trim() }),
      }))
    );
    if (mySeq !== seq) return; // a newer search superseded us
    results.innerHTML = '';
    let any = false;
    for (const g of groups) {
      if (g.status !== 'fulfilled' || !g.value.metas.length) continue;
      any = true;
      const { addon, catalog, metas } = g.value;
      results.append(el('h2', { class: 'row-title', text: `${catalog.name || 'Results'}` },
        el('span', { class: 'row-sub', text: `${catalog.type} · ${addon.manifest.name}` })));
      const row = el('div', { class: 'meta-row' });
      metas.slice(0, 30).forEach((meta) => row.append(metaCard(meta, {
        onSelect: () => router.push('detail', { type: meta.type || catalog.type, id: meta.id, preview: meta }),
      })));
      results.append(row);
    }
    if (!any) results.append(el('div', { class: 'empty-note', text: `No results for “${q}”.` }));
  }

  function liveSearch(q) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => runSearch(q), LIVE_DEBOUNCE_MS);
  }

  // seed: a character typed before the keyboard was open (type-anywhere).
  async function openKeyboard(seed) {
    if (keyboardOpen) return;
    keyboardOpen = true;
    const start = (queryBtn.dataset.q || '') + (seed || '');
    setQuery(start);
    if (seed) liveSearch(start);
    root.classList.add('osk-docked'); // shift results into the visible right half
    const q = await oskPrompt({
      title: 'Search',
      value: start,
      dock: 'left',
      onChange: (t) => { setQuery(t); liveSearch(t); },
    });
    keyboardOpen = false;
    root.classList.remove('osk-docked');
    if (q !== null) {
      setQuery(q);
      clearTimeout(liveTimer);
      await runSearch(q);
    }
    const firstCard = results.querySelector('.meta-card');
    if (firstCard) Nav.focus(firstCard);
  }

  queryBtn.addEventListener('click', () => openKeyboard());
  // Used by the global type-anywhere handler when this screen is already open.
  root._openSearchKeyboard = (ch) => openKeyboard(ch);

  if (params.autoOpen) setTimeout(() => openKeyboard(params.initialQuery || ''), 30);

  return root;
}
