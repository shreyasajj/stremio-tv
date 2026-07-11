// Search: on-screen keyboard feeding every search-capable addon catalog.

import { el, metaCard } from '../ui.js';
import { searchableCatalogs, getCatalog } from '../addons.js';
import { oskPrompt } from '../keyboard.js';
import { Nav } from '../nav.js';

export async function render({ router }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Search' }));

  const queryBtn = el('button', { class: 'focusable btn primary', 'data-nav-default': '', text: '⌨  Type to search' });
  const results = el('div');
  root.append(el('div', { class: 'btn-row' }, queryBtn), results);

  let seq = 0;

  async function runSearch(q) {
    const mySeq = ++seq;
    results.innerHTML = '';
    if (!q || q.trim().length < 2) return;
    const catalogs = searchableCatalogs();
    if (!catalogs.length) {
      results.append(el('div', { class: 'empty-note', text: 'No search-capable addons installed.' }));
      return;
    }
    results.append(el('div', { class: 'empty-note', text: `Searching for “${q}”…` }));
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

  queryBtn.addEventListener('click', async () => {
    const q = await oskPrompt({ title: 'Search', value: queryBtn.dataset.q || '' });
    if (q === null) return;
    queryBtn.dataset.q = q;
    queryBtn.textContent = q ? `⌨  ${q}` : '⌨  Type to search';
    await runSearch(q);
    const firstCard = results.querySelector('.meta-card');
    if (firstCard) Nav.focus(firstCard);
  });

  return root;
}
