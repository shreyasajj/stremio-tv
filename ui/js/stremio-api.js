// Minimal api.strem.io client — used only to log in and import the
// account's addon collection.

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

export async function login(email, password) {
  const result = await apiCall('login', { type: 'Login', email, password });
  if (!result || !result.authKey) throw new Error('Login failed: no auth key returned');
  Storage.setAuth({ authKey: result.authKey, email });
  return result;
}

export function logout() {
  const auth = Storage.getAuth();
  Storage.clearAuth();
  if (auth?.authKey) {
    apiCall('logout', { type: 'Logout', authKey: auth.authKey }).catch(() => {});
  }
}

export function loggedInEmail() {
  return Storage.getAuth()?.email || null;
}

// Returns the account's addon collection: [{ transportUrl, manifest }]
export async function fetchAccountAddons() {
  const auth = Storage.getAuth();
  if (!auth) throw new Error('Not logged in');
  const result = await apiCall('addonCollectionGet', {
    type: 'AddonCollectionGet',
    authKey: auth.authKey,
    update: true,
  });
  return (result.addons || [])
    .filter((a) => a.transportUrl && a.manifest)
    .map((a) => ({ transportUrl: a.transportUrl, manifest: a.manifest }));
}
