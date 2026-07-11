// Library: everything with saved watch progress.

import { el, metaCard, toast } from '../ui.js';
import { Storage } from '../storage.js';

export async function render({ router }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Library' }));

  const entries = Object.values(Storage.getLibrary()).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!entries.length) {
    root.append(el('div', { class: 'empty-note', text: 'Nothing here yet — anything you start watching shows up in your Library.' }));
    return root;
  }

  const grid = el('div', { class: 'meta-grid' });
  entries.forEach((entry) => {
    const progress = entry.duration ? Math.min(1, entry.time / entry.duration) : 0;
    grid.append(metaCard(entry, {
      progress,
      onSelect: () => router.push('detail', { type: entry.type, id: entry.id, preview: entry }),
    }));
  });
  root.append(grid);
  return root;
}
