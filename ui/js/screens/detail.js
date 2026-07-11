// Detail: hero + play button; series get a season picker + episode list.

import { el, toast, pickerModal, confirmModal } from '../ui.js';
import { getMeta } from '../addons.js';
import { Storage } from '../storage.js';
import { playFlow, resumeFlow, videoLabel } from '../streams.js';
import { formatTime } from '../ui.js';

export async function render({ router, params }) {
  const { type, id, preview } = params;
  const root = el('div', { class: 'screen' });

  let meta = null;
  try {
    meta = await getMeta(type, id);
  } catch (e) {
    console.error(e);
  }
  if (!meta) meta = preview || null;
  if (!meta) {
    root.append(el('div', { class: 'empty-note', text: 'Could not load this title.' }));
    return root;
  }
  meta.type = meta.type || type;

  const hero = el('div', { class: 'detail-hero' });
  const bg = meta.background || meta.poster;
  if (bg) hero.style.backgroundImage = `url("${bg}")`;

  const facts = [];
  if (meta.releaseInfo || meta.year) facts.push(String(meta.releaseInfo || meta.year));
  if (meta.runtime) facts.push(meta.runtime);
  if (meta.imdbRating) facts.push(`★ ${meta.imdbRating}`);
  if (Array.isArray(meta.genres) && meta.genres.length) facts.push(meta.genres.slice(0, 4).join(' / '));

  hero.append(
    el('div', { class: 'detail-title', text: meta.name || id }),
    el('div', { class: 'detail-facts' }, ...facts.map((f) => el('span', { text: f }))),
    meta.description ? el('div', { class: 'detail-desc', text: meta.description }) : ''
  );
  root.append(hero);

  const entry = Storage.getLibraryEntry(meta.type, meta.id);
  const btnRow = el('div', { class: 'btn-row' });
  root.append(btnRow);

  const isSeries = Array.isArray(meta.videos) && meta.videos.length > 0;

  if (entry && entry.time > 10) {
    const resumeBtn = el('button', { class: 'focusable btn primary', 'data-nav-default': '' },
      `▶  Resume${entry.videoLabel ? ' ' + entry.videoLabel : ''} · ${formatTime(entry.time)}`);
    resumeBtn.addEventListener('click', () => resumeFlow(meta, entry).catch((e) => toast(e.message, 'error')));
    btnRow.append(resumeBtn);
  }

  if (!isSeries) {
    const playBtn = el('button', { class: 'focusable btn primary', text: '▶  Play' });
    if (!btnRow.children.length) playBtn.setAttribute('data-nav-default', '');
    playBtn.addEventListener('click', () => playFlow(meta, null).catch((e) => toast(e.message, 'error')));
    btnRow.append(playBtn);
  }

  if (entry) {
    const clearBtn = el('button', { class: 'focusable btn', text: 'Remove from Continue Watching' });
    clearBtn.addEventListener('click', async () => {
      if (await confirmModal('Remove watch progress for this title?', { okLabel: 'Remove', danger: true })) {
        Storage.removeLibraryEntry(meta.type, meta.id);
        toast('Removed.');
        router.refresh();
      }
    });
    btnRow.append(clearBtn);
  }

  if (isSeries) {
    const seasons = [...new Set(meta.videos.map((v) => v.season))].sort((a, b) => (a ?? 99) - (b ?? 99));
    let season = entry?.videoId
      ? meta.videos.find((v) => v.id === entry.videoId)?.season ?? seasons.find((s) => s !== 0) ?? seasons[0]
      : seasons.find((s) => s !== 0) ?? seasons[0];

    const seasonBtn = el('button', { class: 'focusable btn' });
    if (!btnRow.children.length) seasonBtn.setAttribute('data-nav-default', '');
    btnRow.append(seasonBtn);
    const epList = el('div');
    root.append(epList);

    function seasonName(s) {
      if (s === 0) return 'Specials';
      if (s === undefined || s === null) return 'Episodes';
      return `Season ${s}`;
    }

    function renderEpisodes() {
      seasonBtn.textContent = '▾ ' + seasonName(season);
      epList.innerHTML = '';
      const vids = meta.videos.filter((v) => v.season === season);
      vids.sort((a, b) => (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0));
      vids.forEach((v) => {
        const released = v.released ? new Date(v.released) : null;
        const upcoming = released && released.getTime() > Date.now();
        const item = el('button', { class: 'focusable list-item episode-item' },
          el('div', { class: 'li-title' },
            el('span', { text: videoLabel(v) || v.id }),
            released ? el('span', { class: 'ep-released', text: (upcoming ? 'Upcoming · ' : '') + released.toISOString().slice(0, 10) }) : ''),
          v.overview ? el('div', { class: 'li-sub', text: v.overview.slice(0, 220) }) : '');
        item.addEventListener('click', () => playFlow(meta, v).catch((e) => toast(e.message, 'error')));
        epList.append(item);
      });
      if (!vids.length) epList.append(el('div', { class: 'empty-note', text: 'No episodes in this season.' }));
    }

    seasonBtn.addEventListener('click', async () => {
      const chosen = await pickerModal('Season', seasons.map((s) => ({ label: seasonName(s), value: s })), { selectedValue: season });
      if (chosen !== null) { season = chosen; renderEpisodes(); }
    });

    renderEpisodes();
  }

  return root;
}
