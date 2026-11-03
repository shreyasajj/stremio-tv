// Detail (title page): full-screen backdrop, logo, fact chips and Play/Resume;
// series get season chips and a row of episode thumbnail cards.

import { el, toast, confirmModal, titleArt, factsRow, nextEpisodeLine, progressBar, formatTime } from '../ui.js';
import { getMeta } from '../addons.js';
import { Storage } from '../storage.js';
import { playFlow, resumeFlow, videoLabel } from '../streams.js';
import { icon } from '../icons.js';
import { backdropUrl, lazyBackground, preload } from '../art.js';

export async function render({ router, params }) {
  const { type, id, preview } = params;
  const root = el('div', { class: 'screen detail-screen' });

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

  const backdrop = el('div', { class: 'detail-backdrop' });
  const bg = backdropUrl(meta);
  preload(bg).then((ok) => {
    if (!ok) return;
    backdrop.style.backgroundImage = `url("${bg}")`;
    backdrop.classList.add('on');
  });
  const body = el('div', { class: 'detail-body' });
  root.append(backdrop, el('div', { class: 'detail-scrim' }), body);

  body.append(
    titleArt(meta, { tag: 'h1', cls: 'detail-title' }),
    factsRow(meta, { chips: true, cls: 'detail-facts' }),
    nextEpisodeLine(meta) || '',
    meta.description ? el('div', { class: 'detail-desc', text: meta.description }) : ''
  );

  const entry = Storage.getLibraryEntry(meta.type, meta.id);
  const btnRow = el('div', { class: 'btn-row' });
  body.append(btnRow);

  const isSeries = Array.isArray(meta.videos) && meta.videos.length > 0;
  const seasons = isSeries
    ? [...new Set(meta.videos.map((v) => v.season))].sort((a, b) => (a ?? 99) - (b ?? 99))
    : [];
  let season = entry?.videoId
    ? meta.videos?.find((v) => v.id === entry.videoId)?.season ?? seasons.find((s) => s !== 0) ?? seasons[0]
    : seasons.find((s) => s !== 0) ?? seasons[0];

  function episodesOf(s) {
    const vids = meta.videos.filter((v) => v.season === s);
    return vids.sort((a, b) => (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0));
  }

  if (entry && entry.time > 10) {
    const resumeBtn = el('button', { class: 'focusable btn primary', 'data-nav-default': '' },
      icon('play'), `Resume${entry.videoLabel ? ' ' + entry.videoLabel : ''} · ${formatTime(entry.time)}`);
    resumeBtn.addEventListener('click', () => resumeFlow(meta, entry).catch((e) => toast(e.message, 'error')));
    btnRow.append(resumeBtn);
  }

  if (!isSeries) {
    const playBtn = el('button', { class: `focusable btn${btnRow.children.length ? '' : ' primary'}` }, icon('play'), 'Play');
    if (!btnRow.children.length) playBtn.setAttribute('data-nav-default', '');
    playBtn.addEventListener('click', () => playFlow(meta, null).catch((e) => toast(e.message, 'error')));
    btnRow.append(playBtn);
  } else if (!btnRow.children.length) {
    // Nothing to resume: Play starts the first episode of the opening season.
    const first = episodesOf(season)[0];
    if (first) {
      const ep = first.episode ?? first.number;
      const playBtn = el('button', { class: 'focusable btn primary', 'data-nav-default': '' },
        icon('play'), ep !== undefined ? `Play S${first.season ?? 1} E${ep}` : 'Play');
      playBtn.addEventListener('click', () => playFlow(meta, first).catch((e) => toast(e.message, 'error')));
      btnRow.append(playBtn);
    }
  }

  if (entry) {
    const clearBtn = el('button', { class: 'focusable btn' }, icon('trash'), 'Remove from Continue Watching');
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
    const chips = el('div', { class: 'season-chips' });
    const epList = el('div', { class: 'meta-row episode-row' });
    body.append(chips, epList);

    function seasonName(s) {
      if (s === 0) return 'Specials';
      if (s === undefined || s === null) return 'Episodes';
      return `Season ${s}`;
    }

    function episodeCard(v) {
      const num = v.episode ?? v.number;
      const released = v.released ? new Date(v.released) : null;
      const upcoming = released && released.getTime() > Date.now();
      const thumb = el('div', { class: 'episode-thumb' },
        num !== undefined ? el('span', { class: 'episode-num', text: `E${num}` }) : null);
      lazyBackground(thumb, v.thumbnail || bg);
      if (entry?.videoId === v.id && entry.duration) thumb.append(progressBar(entry.time / entry.duration));
      const date = released && !isNaN(released)
        ? released.toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
        : null;
      const facts = [v.runtime || meta.runtime, date ? (upcoming ? 'Upcoming · ' : '') + date : null].filter(Boolean);
      const item = el('button', { class: 'focusable episode-item' },
        thumb,
        el('div', { class: 'ep-title', text: v.title || v.name || videoLabel(v) || v.id }),
        facts.length ? el('div', { class: 'ep-meta', text: facts.join(' · ') }) : null,
        v.overview ? el('div', { class: 'ep-overview', text: v.overview }) : null);
      item.addEventListener('click', () => playFlow(meta, v).catch((e) => toast(e.message, 'error')));
      return item;
    }

    function renderEpisodes() {
      chips.querySelectorAll('.season-chip').forEach((c) => c.classList.toggle('active', c._season === season));
      epList.innerHTML = '';
      epList.scrollLeft = 0;
      const vids = episodesOf(season);
      vids.forEach((v) => epList.append(episodeCard(v)));
      if (!vids.length) epList.append(el('div', { class: 'empty-note', text: 'No episodes in this season.' }));
    }

    seasons.forEach((s) => {
      const chip = el('button', { class: 'focusable season-chip', text: seasonName(s) });
      chip._season = s;
      if (!btnRow.children.length && s === season) chip.setAttribute('data-nav-default', '');
      chip.addEventListener('click', () => {
        if (season === s) return;
        season = s;
        renderEpisodes();
      });
      chips.append(chip);
    });

    renderEpisodes();
  }

  return root;
}
