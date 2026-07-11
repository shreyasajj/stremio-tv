// Stremio addon-protocol client.
// Protocol: GET {base}/manifest.json, {base}/catalog/{type}/{id}[/{extra}].json,
// {base}/meta/{type}/{id}.json, {base}/stream/{type}/{id}.json,
// {base}/subtitles/{type}/{id}[/{extra}].json
// Works with any addon: Cinemeta, AIOStreams, Torrentio, OpenSubtitles, ...

import { Storage } from './storage.js';

export const OFFICIAL_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://opensubtitles-v3.strem.io/manifest.json',
];

const FETCH_TIMEOUT = 15000;

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export function normalizeManifestUrl(input) {
  let url = String(input || '').trim();
  if (!url) throw new Error('Empty addon URL');
  if (url.startsWith('stremio://')) url = 'https://' + url.slice('stremio://'.length);
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!url.endsWith('/manifest.json')) {
    url = url.replace(/\/+$/, '') + '/manifest.json';
  }
  return url;
}

export function addonBaseUrl(addon) {
  return addon.transportUrl.replace(/\/manifest\.json$/, '');
}

export async function fetchAddon(manifestUrl) {
  const transportUrl = normalizeManifestUrl(manifestUrl);
  const manifest = await getJSON(transportUrl);
  if (!manifest || !manifest.id || !manifest.resources) {
    throw new Error('Not a valid addon manifest');
  }
  return { transportUrl, manifest };
}

export function installedAddons() {
  return Storage.getAddons();
}

export function installAddon(addon) {
  const addons = Storage.getAddons().filter((a) => a.manifest.id !== addon.manifest.id);
  addons.push(addon);
  Storage.setAddons(addons);
}

export function removeAddon(manifestId) {
  Storage.setAddons(Storage.getAddons().filter((a) => a.manifest.id !== manifestId));
}

export async function installDefaultAddons() {
  for (const url of OFFICIAL_ADDONS) {
    try {
      installAddon(await fetchAddon(url));
    } catch (e) {
      console.error('default addon install failed', url, e);
    }
  }
}

// ---- resource matching -------------------------------------------------

// manifest.resources entries are either "stream" strings or
// { name, types, idPrefixes } objects.
function resourceDef(manifest, name) {
  for (const r of manifest.resources || []) {
    if (r === name) return { name, types: manifest.types || [], idPrefixes: manifest.idPrefixes || null };
    if (r && r.name === name) {
      return {
        name,
        types: r.types || manifest.types || [],
        idPrefixes: r.idPrefixes || manifest.idPrefixes || null,
      };
    }
  }
  return null;
}

function supports(manifest, resource, type, id) {
  const def = resourceDef(manifest, resource);
  if (!def) return false;
  if (def.types.length && !def.types.includes(type)) return false;
  if (def.idPrefixes && def.idPrefixes.length && !def.idPrefixes.some((p) => id.startsWith(p))) return false;
  return true;
}

export function addonsFor(resource, type, id) {
  return installedAddons().filter((a) => supports(a.manifest, resource, type, id));
}

// ---- catalogs ------------------------------------------------------------

function extraDefs(catalog) {
  // Old-style: catalog.extraSupported / extraRequired; new-style: catalog.extra
  if (Array.isArray(catalog.extra)) return catalog.extra;
  const supported = catalog.extraSupported || [];
  const required = catalog.extraRequired || [];
  return supported.map((name) => ({ name, isRequired: required.includes(name) }));
}

export function catalogSupportsExtra(catalog, name) {
  return extraDefs(catalog).some((e) => e.name === name);
}

export function catalogRequiredExtra(catalog) {
  return extraDefs(catalog).filter((e) => e.isRequired).map((e) => e.name);
}

// Catalogs suitable for browsing without input (Home rows / Discover).
export function browsableCatalogs() {
  const out = [];
  for (const addon of installedAddons()) {
    for (const catalog of addon.manifest.catalogs || []) {
      const required = catalogRequiredExtra(catalog);
      if (required.length === 0 || required.every((r) => r === 'genre')) {
        out.push({ addon, catalog });
      }
    }
  }
  return out;
}

export function searchableCatalogs() {
  const out = [];
  for (const addon of installedAddons()) {
    for (const catalog of addon.manifest.catalogs || []) {
      if (catalogSupportsExtra(catalog, 'search')) out.push({ addon, catalog });
    }
  }
  return out;
}

export function genreOptions(catalog) {
  const def = extraDefs(catalog).find((e) => e.name === 'genre');
  if (def && Array.isArray(def.options)) return def.options;
  if (Array.isArray(catalog.genres)) return catalog.genres;
  return [];
}

export async function getCatalog(addon, type, catalogId, extra = {}) {
  const pairs = Object.entries(extra).filter(([, v]) => v !== undefined && v !== null && v !== '');
  let path = `/catalog/${encodeURIComponent(type)}/${encodeURIComponent(catalogId)}`;
  if (pairs.length) {
    path += '/' + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }
  const data = await getJSON(addonBaseUrl(addon) + path + '.json');
  return data.metas || [];
}

// ---- meta ------------------------------------------------------------

export async function getMeta(type, id) {
  const candidates = addonsFor('meta', type, id);
  let lastErr = null;
  for (const addon of candidates) {
    try {
      const data = await getJSON(`${addonBaseUrl(addon)}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
      if (data.meta) return data.meta;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ---- streams ------------------------------------------------------------

// Returns [{ addon, stream }] aggregated across all stream-capable addons.
export async function getStreams(type, id) {
  const candidates = addonsFor('stream', type, id);
  const results = await Promise.allSettled(
    candidates.map(async (addon) => {
      const data = await getJSON(`${addonBaseUrl(addon)}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
      return (data.streams || []).map((stream) => ({ addon, stream }));
    })
  );
  const out = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push(...r.value);
    else errors.push({ addon: candidates[i], error: r.reason });
  });
  return { streams: out, errors };
}

// Resolve a stream object to a playable URL (or null if we can't play it).
export function resolveStreamUrl(stream) {
  if (stream.url) return stream.url;
  if (stream.infoHash) {
    const server = Storage.getSettings().streamingServer.replace(/\/+$/, '');
    if (!server) return null;
    const fileIdx = stream.fileIdx === undefined || stream.fileIdx === null ? -1 : stream.fileIdx;
    return `${server}/${stream.infoHash}/${fileIdx}`;
  }
  return null;
}

export function streamUnplayableReason(stream) {
  if (stream.url) return null;
  if (stream.infoHash) {
    return Storage.getSettings().streamingServer
      ? null
      : 'Torrent stream — set a streaming server URL in Settings to play it';
  }
  if (stream.ytId) return 'YouTube streams are not supported';
  if (stream.externalUrl) return 'Opens externally — not playable here';
  return 'No playable source in this stream';
}

// ---- subtitles ------------------------------------------------------------

export async function getSubtitles(type, id, extra = {}) {
  const candidates = addonsFor('subtitles', type, id);
  const pairs = Object.entries(extra).filter(([, v]) => v);
  let suffix = '';
  if (pairs.length) {
    suffix = '/' + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  }
  const results = await Promise.allSettled(
    candidates.map(async (addon) => {
      const data = await getJSON(
        `${addonBaseUrl(addon)}/subtitles/${encodeURIComponent(type)}/${encodeURIComponent(id)}${suffix}.json`
      );
      return (data.subtitles || []).map((s) => ({ ...s, addonName: addon.manifest.name }));
    })
  );
  return results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
}
