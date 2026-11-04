// Minimal api.strem.io client — used only to import an account's addon
// collection. The session lasts for the import alone: it is logged out right
// after, and nothing about the account is stored.

import { Storage } from './storage.js';

const API = 'https://api.strem.io/api';

async function apiCall(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Stremio API HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error.message || data.error.code || 'Stremio API error');
  }
  return data.result;
}

// Logs in, returns the account's addon collection ([{ transportUrl,
// manifest }]) and logs out again.
export async function importAccountAddons(email, password) {
  const result = await apiCall('login', { type: 'Login', email, password });
  if (!result || !result.authKey) throw new Error('Login failed: no auth key returned');
  const { authKey } = result;
  try {
    const collection = await apiCall('addonCollectionGet', { type: 'AddonCollectionGet', authKey, update: true });
    return (collection.addons || [])
      .filter((a) => a.transportUrl && a.manifest)
      .map((a) => ({ transportUrl: a.transportUrl, manifest: a.manifest }));
  } finally {
    endSession(authKey);
  }
}

function endSession(authKey) {
  apiCall('logout', { type: 'Logout', authKey }).catch(() => {});
}

// Up to 0.6.1 the session was kept in localStorage: end it and forget it.
export function forgetSavedSession() {
  const saved = Storage.takeLegacyAuth();
  if (saved?.authKey) endSession(saved.authKey);
}
