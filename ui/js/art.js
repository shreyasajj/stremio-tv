// Artwork + presentation helpers: logos, backdrops, metadata lines, lazily
// loaded images, and a small cache of full metas for the hero and wide cards.

import { getMeta } from './addons.js';

const METAHUB = 'https://images.metahub.space';

export function imdbId(meta) {
  const id = meta?.imdb_id || meta?.id || '';
  const m = /^tt\d+/.exec(id);
  return m ? m[0] : null;
}

// Title logo: the meta's own, else metahub's for IMDb titles, else none
// (callers then show the name in large type).
export function logoUrl(meta) {
  if (meta?.logo) return meta.logo;
  const imdb = imdbId(meta);
  return imdb ? `${METAHUB}/logo/medium/${imdb}/img` : null;
}

// Backdrop art, or null. Never the poster: a 2:3 poster stretched to fill the
// screen looks poor, and in Qt WebEngine with software GL a stretched
// (SVG) poster under the cards' focus-scale animations crashed the renderer.
export function backdropUrl(meta) {
  if (meta?.background) return meta.background;
  const imdb = imdbId(meta);
  if (imdb) return `${METAHUB}/background/medium/${imdb}/img`;
  return null;
}

// YouTube ids of the title's trailers, best first (Cinemeta lists them twice:
// `trailerStreams` and the older `trailers`).
export function trailerIds(meta) {
  const ids = [
    ...(meta?.trailerStreams || []).map((t) => t.ytId),
    ...(meta?.trailers || []).filter((t) => !t.type || t.type === 'Trailer').map((t) => t.source),
  ];
  return [...new Set(ids.filter((id) => typeof id === 'string' && /^[\w-]{6,20}$/.test(id)))];
}

// "2019 · 2h 10m · ★ 7.8 · Drama, Crime" as separate pieces.
export function metaFacts(meta, { genres = 3 } = {}) {
  const facts = [];
  if (meta.releaseInfo || meta.year) facts.push({ text: String(meta.releaseInfo || meta.year) });
  if (meta.runtime) facts.push({ text: meta.runtime });
  if (meta.imdbRating) facts.push({ text: meta.imdbRating, kind: 'rating' });
  if (Array.isArray(meta.genres) && meta.genres.length) facts.push({ text: meta.genres.slice(0, genres).join(', ') });
  return facts;
}

// The series' next unreleased episode (specials aside), or null.
export function nextEpisode(meta, now = Date.now()) {
  let next = null;
  for (const v of meta?.videos || []) {
    const time = Date.parse(v.released);
    if (!(time > now) || v.season === 0) continue;
    if (!next || time < next.time) next = { video: v, time };
  }
  return next;
}

// "Today", "Tomorrow", "Friday, Nov 6" within the week, else "Nov 14" (+ year).
export function releaseDay(time, now = Date.now()) {
  const day = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(time) - day(now)) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  const d = new Date(time);
  if (days < 7) return d.toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

// "S2 E5 · Friday, Nov 6" for the next episode, or null when none is scheduled.
export function nextEpisodeText(meta) {
  const next = nextEpisode(meta);
  if (!next) return null;
  const { season, episode, number } = next.video;
  const ep = episode ?? number;
  const label = ep !== undefined && ep !== null ? `S${season ?? 1} E${ep}` : (next.video.title || next.video.name || 'New episode');
  return `${label} · ${releaseDay(next.time)}`;
}

const metaCache = new Map();

// getMeta, remembered for the session; resolves null instead of throwing.
export function cachedMeta(type, id) {
  const key = `${type}:${id}`;
  if (!metaCache.has(key)) {
    metaCache.set(key, getMeta(type, id).catch(() => null));
    if (metaCache.size > 200) metaCache.delete(metaCache.keys().next().value);
  }
  return metaCache.get(key);
}

// Background images are only fetched once their element nears the screen:
// home rows hold hundreds of posters and TV boxes have little memory.
let observer = null;
function lazyObserver() {
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.style.backgroundImage = `url("${e.target.dataset.bg}")`;
        observer.unobserve(e.target);
      }
    }, { rootMargin: '400px 800px' });
  }
  return observer;
}

export function lazyBackground(node, url) {
  if (!url) return;
  node.dataset.bg = url;
  if (typeof IntersectionObserver === 'undefined') node.style.backgroundImage = `url("${url}")`;
  else lazyObserver().observe(node);
}

// Resolves when the image has loaded (true) or failed (false).
export function preload(url) {
  return new Promise((resolve) => {
    if (!url) { resolve(false); return; }
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}
