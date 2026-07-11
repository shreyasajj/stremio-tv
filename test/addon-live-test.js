// Smoke test against real public addons (needs internet):
//   npm run test:addons
// Verifies the addon-protocol request shapes the UI uses.

const CINEMETA = 'https://v3-cinemeta.strem.io';

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

(async () => {
  let failures = 0;
  const check = (name, cond, info = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
    if (!cond) failures++;
  };

  const manifest = await getJSON(`${CINEMETA}/manifest.json`);
  check('cinemeta manifest', manifest.id === 'com.linvo.cinemeta', manifest.id);
  check('cinemeta has catalogs', Array.isArray(manifest.catalogs) && manifest.catalogs.length > 0);

  const catalog = await getJSON(`${CINEMETA}/catalog/movie/top.json`);
  check('catalog/movie/top has metas', Array.isArray(catalog.metas) && catalog.metas.length > 10, `${catalog.metas?.length} metas`);
  const first = catalog.metas[0];
  check('meta preview shape', !!(first.id && first.name && first.poster), first.id);

  const search = await getJSON(`${CINEMETA}/catalog/movie/top/search=matrix.json`);
  check('catalog search works', Array.isArray(search.metas) && search.metas.some((m) => /matrix/i.test(m.name)));

  const skip = await getJSON(`${CINEMETA}/catalog/movie/top/skip=100.json`);
  check('catalog skip pagination', Array.isArray(skip.metas) && skip.metas.length > 0 && skip.metas[0].id !== first.id);

  const meta = await getJSON(`${CINEMETA}/meta/series/tt0903747.json`); // Breaking Bad
  check('series meta has videos', Array.isArray(meta.meta?.videos) && meta.meta.videos.length > 50, `${meta.meta?.videos?.length} videos`);
  const ep = meta.meta.videos.find((v) => v.season === 1 && (v.episode === 1 || v.number === 1));
  check('episode has id/season/episode', !!ep && !!ep.id, ep?.id);

  const subsManifest = await getJSON('https://opensubtitles-v3.strem.io/manifest.json');
  check('opensubtitles manifest', (subsManifest.resources || []).some((r) => r === 'subtitles' || r?.name === 'subtitles'));

  console.log(failures ? `\n${failures} FAILURES` : '\nAll live addon checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
