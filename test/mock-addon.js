// A local Stremio addon used for offline testing: deterministic catalogs,
// metas, streams (a real playable sample video) and subtitles.
//   npm run mock-addon  ->  http://127.0.0.1:7010/manifest.json
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.MOCK_ADDON_PORT || 7010;
const BASE = `http://127.0.0.1:${PORT}`;

function poster(name, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="285">
    <rect width="100%" height="100%" fill="hsl(${hue},45%,28%)"/>
    <text x="50%" y="50%" fill="#fff" font-size="22" font-family="sans-serif" text-anchor="middle">${name}</text>
  </svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const MOVIES = Array.from({ length: 14 }, (_, i) => ({
  id: `mock:movie${i + 1}`,
  type: 'movie',
  name: `Mock Movie ${i + 1}`,
  poster: poster(`Movie ${i + 1}`, (i * 47) % 360),
  description: `A thoroughly fictional test movie number ${i + 1}.`,
  releaseInfo: String(2000 + i),
  imdbRating: (5 + (i % 5)).toFixed(1),
  genres: ['Test', i % 2 ? 'Drama' : 'Action'],
}));

const SERIES = [{
  id: 'mock:series1',
  type: 'series',
  name: 'Mock Series',
  poster: poster('Series', 200),
  description: 'A test series with two seasons.',
  releaseInfo: '2020-',
  genres: ['Test'],
  videos: [1, 2].flatMap((season) =>
    [1, 2, 3].map((episode) => ({
      id: `mock:series1:${season}:${episode}`,
      season,
      episode,
      title: `Episode ${episode}`,
      released: `202${season}-01-0${episode}T00:00:00.000Z`,
      overview: `Season ${season}, episode ${episode} of the mock series.`,
    }))),
}];

const MANIFEST = {
  id: 'org.stremiotv.mock',
  version: '1.0.0',
  name: 'Mock Addon',
  description: 'Local test addon for Stremio TV',
  resources: ['catalog', 'meta', 'stream', 'subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['mock:'],
  catalogs: [
    { type: 'movie', id: 'mock-movies', name: 'Mock Movies', extra: [{ name: 'search' }, { name: 'skip' }, { name: 'genre', options: ['Action', 'Drama'] }] },
    { type: 'series', id: 'mock-series', name: 'Mock Series', extra: [{ name: 'search' }] },
  ],
};

const SRT = `1
00:00:00,500 --> 00:00:02,000
Hello from the mock subtitle.

2
00:00:02,500 --> 00:00:04,000
Second caption line.
`;

function json(res, obj) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function findMeta(id) {
  return MOVIES.find((m) => m.id === id) || SERIES.find((s) => s.id === id) || null;
}

function createServer() {
  return http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, BASE).pathname);
    if (p === '/manifest.json') return json(res, MANIFEST);

    let m;
    if ((m = p.match(/^\/catalog\/(movie|series)\/([^/]+?)(?:\/(.+?))?\.json$/))) {
      const [, type, , extraStr] = m;
      const extra = Object.fromEntries(new URLSearchParams(extraStr || ''));
      let metas = type === 'movie' ? MOVIES : SERIES;
      if (extra.search) metas = metas.filter((x) => x.name.toLowerCase().includes(extra.search.toLowerCase()));
      if (extra.genre) metas = metas.filter((x) => x.genres.includes(extra.genre));
      if (extra.skip) metas = metas.slice(Number(extra.skip));
      return json(res, { metas });
    }
    if ((m = p.match(/^\/meta\/(movie|series)\/(.+)\.json$/))) {
      return json(res, { meta: findMeta(m[2]) });
    }
    if ((m = p.match(/^\/stream\/(movie|series)\/(.+)\.json$/))) {
      return json(res, {
        streams: [
          { name: 'Mock HD', title: 'Sample stream 720p\nmock-server', url: `${BASE}/sample.webm`, behaviorHints: { bingeGroup: 'mock-hd' } },
          { name: 'Mock Torrent', title: 'Needs a streaming server', infoHash: '0000000000000000000000000000000000000000', fileIdx: 0 },
        ],
      });
    }
    if ((m = p.match(/^\/subtitles\/(movie|series)\/(.+?)(\/.*)?\.json$/))) {
      return json(res, { subtitles: [{ id: 'mock-en', lang: 'eng', url: `${BASE}/sample.srt` }] });
    }
    if (p === '/sample.srt') {
      res.writeHead(200, { 'Content-Type': 'application/x-subrip', 'Access-Control-Allow-Origin': '*' });
      return res.end(SRT);
    }
    if (p === '/sample.webm') {
      const file = path.join(__dirname, 'sample.webm');
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const stat = fs.statSync(file);
      const range = req.headers.range;
      if (range) {
        const [, s, e] = range.match(/bytes=(\d*)-(\d*)/) || [];
        const start = s ? Number(s) : 0;
        const end = e ? Number(e) : stat.size - 1;
        res.writeHead(206, {
          'Content-Type': 'video/webm',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Access-Control-Allow-Origin': '*',
        });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, {
        'Content-Type': 'video/webm',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
      });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
  });
}

module.exports = { createServer, MANIFEST, PORT, BASE };

if (require.main === module) {
  createServer().listen(PORT, () => console.log(`mock addon on ${BASE}/manifest.json`));
}
