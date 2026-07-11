// Home: Continue Watching + one row per browsable addon catalog.

import { el, metaCard, toast } from '../ui.js';
import { Storage } from '../storage.js';
import { browsableCatalogs, getCatalog, getMeta } from '../addons.js';
import { resumeFlow } from '../streams.js';

const ROW_LIMIT = 8; // rows on home; full browsing lives in Discover

export async function render({ router }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Home' }));

  const cw = Storage.continueWatching();
  if (cw.length) {
    root.append(el('h2', { class: 'row-title', text: 'Continue Watching' }));
    const row = el('div', { class: 'meta-row' });
    cw.slice(0, 20).forEach((entry) => {
      const progress = entry.duration ? entry.time / entry.duration : 0;
      const card = metaCard(entry, {
        progress,
        onSelect: async () => {
          try {
            const meta = (await getMeta(entry.type, entry.id)) || entry;
            await resumeFlow(meta, entry);
          } catch (e) {
            toast('Could not resume: ' + e.message, 'error');
          }
        },
      });
      row.append(card);
    });
    root.append(row);
  }

  const catalogs = browsableCatalogs().slice(0, ROW_LIMIT);
  if (!catalogs.length && !cw.length) {
    root.append(el('div', { class: 'empty-note', text: 'No catalogs yet. Go to Add-ons (sidebar) and install Cinemeta or your AIOStreams addon.' }));
  }

  for (const { addon, catalog } of catalogs) {
    const title = el('h2', { class: 'row-title', text: catalog.name || catalog.id },
      el('span', { class: 'row-sub', text: `${catalog.type} · ${addon.manifest.name}` }));
    const row = el('div', { class: 'meta-row' }, el('div', { class: 'empty-note', text: 'Loading…' }));
    root.append(title, row);
    getCatalog(addon, catalog.type, catalog.id)
      .then((metas) => {
        row.innerHTML = '';
        if (!metas.length) { title.remove(); row.remove(); return; }
        metas.slice(0, 25).forEach((meta) => {
          row.append(metaCard(meta, {
            onSelect: () => router.push('detail', { type: meta.type || catalog.type, id: meta.id, preview: meta }),
          }));
        });
      })
      .catch(() => {
        title.remove();
        row.remove();
      });
  }

  return root;
}
