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

// "2019 · 2h 10m · ★ 7.8 · Drama, Crime" as separate pieces.
export function metaFacts(meta, { genres = 3 } = {}) {
  const facts = [];
  if (meta.releaseInfo || meta.year) facts.push({ text: String(meta.releaseInfo || meta.year) });
  if (meta.runtime) facts.push({ text: meta.runtime });
  if (meta.imdbRating) facts.push({ text: meta.imdbRating, kind: 'rating' });
  if (Array.isArray(meta.genres) && meta.genres.length) facts.push({ text: meta.genres.slice(0, genres).join(', ') });
  return facts;
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
