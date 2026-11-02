// Search: an on-screen keyboard on the left, "Top matches" (or your recent
// searches while the query is empty) on the right, full result rows below.
// Results update live while you type; → moves from the keyboard into the
// matches and OK opens one, no Done needed. Physical keyboards type directly.
// Typing a letter anywhere in the app lands here (see main.js).

import { el, metaCard, hasOpenModal } from '../ui.js';
import { searchableCatalogs, getCatalog } from '../addons.js';
import { createKeyboard } from '../keyboard.js';
import { Storage } from '../storage.js';
import { Nav } from '../nav.js';
import { isPlayerOpen } from '../player.js';

const LIVE_DEBOUNCE_MS = 450;
const TOP_MATCHES = 6;

export async function render({ router, params = {} }) {
  const root = el('div', { class: 'screen search-screen' });
  const side = el('div', { class: 'search-side' });
  const results = el('div', { class: 'search-results' });

  let seq = 0;
  let liveTimer = null;

  const kb = createKeyboard({
    value: params.initialQuery || '',
    placeholder: 'Search movies & series…',
    onChange: (q) => liveSearch(q),
    onDone: (q) => {
      clearTimeout(liveTimer);
      Storage.addSearchHistory(q);
      runSearch(q).then(() => {
        const first = root.querySelector('.search-match, .search-results .meta-card');
        if (first) Nav.focus(first);
      });
    },
  });
  kb.firstLetterKey()?.setAttribute('data-nav-default', '');

  root.append(
    el('h1', { class: 'screen-title', text: 'Search' }),
    el('div', { class: 'search-top' }, el('div', { class: 'search-kbd' }, kb.element), side),
    results
  );

  // Opening a title counts as a finished search worth remembering.
  function open(meta, type) {
    Storage.addSearchHistory(kb.text());
    router.push('detail', { type: meta.type || type, id: meta.id, preview: meta });
  }

  function showHistory() {
    side.innerHTML = '';
    const history = Storage.getSearchHistory();
    side.append(el('h2', { class: 'row-title', text: 'Recent searches' }));
    if (!history.length) {
      side.append(el('div', { class: 'empty-note', text: 'Searches you make show up here.' }));
      return;
    }
    const list = el('div', { class: 'search-list' });
    history.slice(0, 8).forEach((q) => {
      const item = el('button', { class: 'focusable list-item search-recent' }, el('div', { class: 'li-title', text: q }));
      item.addEventListener('click', () => {
        kb.setText(q, { silent: true });
        Storage.addSearchHistory(q); // move to the top
        clearTimeout(liveTimer);
        runSearch(q).then(() => {
          const first = root.querySelector('.search-match');
          if (first) Nav.focus(first);
        });
      });
      list.append(item);
    });
    const clear = el('button', { class: 'focusable btn search-clear', text: 'Clear history' });
    clear.addEventListener('click', () => {
      Storage.clearSearchHistory();
      showHistory();
      kb.focus();
    });
    side.append(list, clear);
  }

  // Best few hits across all addons, interleaved so one catalog can't crowd
  // out the rest; duplicates (same id from several catalogs) dropped.
  function showTopMatches(groups) {
    side.innerHTML = '';
    side.append(el('h2', { class: 'row-title', text: 'Top matches' }));
    const seen = new Set();
    const picks = [];
    for (let i = 0; picks.length < TOP_MATCHES; i++) {
      let added = false;
      for (const g of groups) {
        const meta = g.metas[i];
        if (!meta) continue;
        added = true;
        if (seen.has(meta.id)) continue;
        seen.add(meta.id);
        picks.push({ meta, type: g.catalog.type });
        if (picks.length === TOP_MATCHES) break;
      }
      if (!added) break;
    }
    const list = el('div', { class: 'search-list' });
    picks.forEach(({ meta, type }) => {
      const thumb = el('div', { class: 'search-thumb' });
      if (meta.poster) thumb.style.backgroundImage = `url("${meta.poster}")`;
      const sub = [meta.releaseInfo || meta.year, meta.type || type].filter(Boolean).join(' · ');
      const item = el('button', { class: 'focusable list-item search-match' },
        thumb,
        el('div', { class: 'search-match-text' },
          el('div', { class: 'li-title', text: meta.name || meta.id }),
          sub ? el('div', { class: 'li-sub', text: sub }) : null));
      item.addEventListener('click', () => open(meta, type));
      list.append(item);
    });
    side.append(list);
  }

  async function runSearch(q) {
    const mySeq = ++seq;
    const query = (q || '').trim();
    if (query.length < 2) {
      results.innerHTML = '';
      showHistory();
      return;
    }
    const catalogs = searchableCatalogs();
    if (!catalogs.length) {
      results.innerHTML = '';
      side.innerHTML = '';
      side.append(el('div', { class: 'empty-note', text: 'No search-capable addons installed.' }));
      return;
    }
    const settled = await Promise.allSettled(
      catalogs.map(async ({ addon, catalog }) => ({
        addon, catalog,
        metas: await getCatalog(addon, catalog.type, catalog.id, { search: query }),
      }))
    );
    if (mySeq !== seq) return; // a newer search superseded us
    const groups = settled.filter((g) => g.status === 'fulfilled' && g.value.metas.length).map((g) => g.value);
    results.innerHTML = '';
    if (!groups.length) {
      side.innerHTML = '';
      side.append(el('h2', { class: 'row-title', text: 'Top matches' }),
        el('div', { class: 'empty-note', text: `No results for “${query}”.` }));
      return;
    }
    showTopMatches(groups);
    for (const { addon, catalog, metas } of groups) {
      results.append(el('h2', { class: 'row-title', text: `${catalog.name || 'Results'}` },
        el('span', { class: 'row-sub', text: `${catalog.type} · ${addon.manifest.name}` })));
      const row = el('div', { class: 'meta-row' });
      metas.slice(0, 30).forEach((meta) => row.append(metaCard(meta, { onSelect: () => open(meta, catalog.type) })));
      results.append(row);
    }
  }

  function liveSearch(q) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => runSearch(q), LIVE_DEBOUNCE_MS);
  }

  // Physical keyboard while this screen is on top. Backspace only edits when
  // there is text; on an empty query it still means "go back".
  function physicalKeys(e) {
    if (!root.isConnected) { Nav.popKeyHandler(physicalKeys); return false; }
    if (root.classList.contains('hidden') || hasOpenModal() || isPlayerOpen()) return false;
    if ((e.key === 'Backspace' || e.key === 'Delete') && !kb.text()) return false;
    return kb.handleKey(e);
  }
  Nav.pushKeyHandler(physicalKeys);

  // Used by the global type-anywhere handler.
  root._openSearchKeyboard = (ch) => {
    kb.setText(kb.text() + (ch || ''));
    kb.focus();
  };

  if (kb.text()) liveSearch(kb.text());
  else showHistory();
  return root;
}
