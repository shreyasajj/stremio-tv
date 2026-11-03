// Home Assistant (MQTT) glue between the UI and the native shell's
// `shell.homeAssistant`: hands it the broker settings, reports what is
// playing, and routes HA's commands to the player. Off by default; nothing is
// sent anywhere until it is turned on in Settings.

import { Storage } from './storage.js';

const COMMANDS = ['play', 'pause', 'toggle', 'stop'];
const SEEK = /^seek:([+-]\d{1,5})$/;

let commandHandler = null;

export function haAvailable() {
  return !!window.shell?.homeAssistant;
}

export function sanitizeBox(box) {
  const b = String(box || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return b.slice(0, 64) || 'living_room';
}

// Settings -> the native client's shape.
export function brokerSettings(s = Storage.getSettings()) {
  return {
    enabled: !!s.haEnabled,
    host: (s.haHost || '').trim(),
    port: Number(s.haPort) || 1883,
    username: s.haUsername || '',
    password: s.haPassword || '',
    box: sanitizeBox(s.haBox),
  };
}

// (Re)connect with the stored settings; the shell ignores no-op changes.
export function applyHomeAssistant() {
  if (!haAvailable()) return;
  window.shell.homeAssistant.configure(brokerSettings());
}

export const IDLE_STATE = {
  state: 'idle', title: null, type: null, episode: null, position: null,
  duration: null, progress: null, poster: null, imdb_id: null,
};

export function publishState(state) {
  if (!haAvailable()) return;
  window.shell.homeAssistant.publish(state);
}

// The player registers how to carry out commands while it is open.
export function setCommandHandler(fn) {
  commandHandler = fn;
}

// Parse an incoming command: { action } or { action: 'seek', by }, or null.
export function parseCommand(raw) {
  const cmd = String(raw || '').trim().toLowerCase();
  if (COMMANDS.includes(cmd)) return { action: cmd };
  const m = SEEK.exec(cmd);
  return m ? { action: 'seek', by: Number(m[1]) } : null;
}

// Boot: connect if enabled, say nothing is playing, listen for commands.
export function initHomeAssistant() {
  if (!haAvailable()) return;
  applyHomeAssistant();
  publishState(IDLE_STATE);
  window.shell.homeAssistant.onCommand((raw) => {
    const cmd = parseCommand(raw);
    if (!cmd) { console.warn('Home Assistant: unknown command', raw); return; }
    if (commandHandler) commandHandler(cmd);
  });
}

// Human-readable connection status for Settings.
export function statusText(status, settings = Storage.getSettings()) {
  if (!settings.haEnabled) return 'Off';
  if (!settings.haHost) return 'On, but no broker yet: set it up below';
  const where = `${settings.haHost}:${Number(settings.haPort) || 1883}`;
  switch (status?.state) {
    case 'connected': return `Connected to ${where}`;
    case 'error': return status.error || 'Could not connect';
    case 'off': return 'Starting…';
    default: return `Connecting to ${where}…`;
  }
}
