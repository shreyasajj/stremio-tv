// Persistence via localStorage: installed addons, settings, watch progress,
// search history.

const KEYS = {
  addons: 'stv.addons',
  settings: 'stv.settings',
  library: 'stv.library',
  auth: 'stv.auth',
  searchHistory: 'stv.searchHistory',
};
const SEARCH_HISTORY_MAX = 20;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const DEFAULT_SETTINGS = {
  streamingServer: '',     // e.g. http://127.0.0.1:11470 — enables torrent (infoHash) streams
  subtitleSize: 100,       // percent
  subtitleLang: 'eng',
  trailerPreviews: 'sound', // resting on a title plays its trailer: sound | muted | off
  // Native (libmpv) shell only:
  audioDevice: 'auto',     // mpv audio-device, e.g. alsa/hdmi:CARD=PCH,DEV=0
  audioPassthrough: '',    // mpv audio-spdif codec list; '' = decode to PCM
  passthroughPause: 'close', // while paused: close the output | 'bursts' (Dolby/DTS pause signal, patched mpv)
  // Home Assistant over MQTT (native shell only); off until turned on.
  haEnabled: false,
  haHost: '',              // broker address, e.g. 192.168.1.10
  haPort: 1883,
  haUsername: '',
  haPassword: '',
  haBox: 'living_room',    // topic name: stremio_tv/<box>/...
};

export const Storage = {
  // ---- addons: [{ transportUrl, manifest }] ----
  getAddons: () => read(KEYS.addons, []),
  setAddons: (addons) => write(KEYS.addons, addons),

  // ---- settings ----
  getSettings: () => ({ ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) }),
  setSettings(patch) {
    write(KEYS.settings, { ...this.getSettings(), ...patch });
  },

  // ---- stremio account session saved by 0.6.1 and earlier: { authKey,
  // email }. Read once to end it, then removed; never written any more. ----
  takeLegacyAuth() {
    const auth = read(KEYS.auth, null);
    localStorage.removeItem(KEYS.auth);
    return auth;
  },

  // ---- search history: newest first, no duplicates (case-insensitive) ----
  getSearchHistory: () => read(KEYS.searchHistory, []),
  addSearchHistory(query) {
    const q = (query || '').trim();
    if (q.length < 2) return;
    const rest = this.getSearchHistory().filter((h) => h.toLowerCase() !== q.toLowerCase());
    write(KEYS.searchHistory, [q, ...rest].slice(0, SEARCH_HISTORY_MAX));
  },
  clearSearchHistory: () => localStorage.removeItem(KEYS.searchHistory),

  // ---- library / watch progress ----
  // entries keyed `${type}:${id}`:
  // { type, id, name, poster, videoId, videoLabel, time, duration, updatedAt }
  getLibrary: () => read(KEYS.library, {}),
  getLibraryEntry(type, id) {
    return this.getLibrary()[`${type}:${id}`] || null;
  },
  saveProgress(entry) {
    const lib = this.getLibrary();
    lib[`${entry.type}:${entry.id}`] = { ...entry, updatedAt: Date.now() };
    write(KEYS.library, lib);
  },
  removeLibraryEntry(type, id) {
    const lib = this.getLibrary();
    delete lib[`${type}:${id}`];
    write(KEYS.library, lib);
  },
  continueWatching() {
    return Object.values(this.getLibrary())
      .filter((e) => e.time > 10 && (!e.duration || e.time < e.duration * 0.95 || e.nextVideoId))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
};
