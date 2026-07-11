// Persistence via localStorage: installed addons, settings, watch progress.

const KEYS = {
  addons: 'stv.addons',
  settings: 'stv.settings',
  library: 'stv.library',
  auth: 'stv.auth',
};

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

  // ---- stremio account auth: { authKey, email } ----
  getAuth: () => read(KEYS.auth, null),
  setAuth: (auth) => write(KEYS.auth, auth),
  clearAuth: () => localStorage.removeItem(KEYS.auth),

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
