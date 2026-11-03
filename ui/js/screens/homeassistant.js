// Settings → Home Assistant: turn the MQTT link on/off, enter the broker
// login (from a phone via QR code, or on the TV with the on-screen keyboard),
// name the box, and test the connection. Every field can be changed alone.

import { el, toast, openModal } from '../ui.js';
import { Storage } from '../storage.js';
import { oskPrompt } from '../keyboard.js';
import { icon } from '../icons.js';
import { applyHomeAssistant, brokerSettings, sanitizeBox, statusText } from '../homeassistant.js';

export async function render() {
  const ha = window.shell.homeAssistant;
  const root = el('div', { class: 'screen' });
  root.append(
    el('h1', { class: 'screen-title', text: 'Home Assistant' }),
    el('p', { class: 'screen-intro', text:
      'Shows what is playing in Home Assistant (title, episode, position, poster) and lets it play, pause, ' +
      'stop or skip. When on, Stremio TV sends what you watch to your own MQTT broker (e.g. the Mosquitto ' +
      'add-on) on your network, and nowhere else.' }));
  const list = el('div', { class: 'settings-list' });
  root.append(list);

  function item(title, onClick, { trailing, attrs } = {}) {
    const sub = el('div', { class: 'li-sub' });
    const node = el('button', { class: 'focusable list-item setting-item', ...(attrs || {}) },
      el('div', { class: 'setting-text' }, el('div', { class: 'li-title', text: title }), sub),
      trailing || icon('chevronRight'));
    node.addEventListener('click', onClick);
    list.append(node);
    return { node, sub };
  }

  let status = await ha.status();
  let lastTest = null; // { ok, error }

  const pill = el('span', { class: 'toggle-pill' });
  const toggle = item('Home Assistant', toggleEnabled, { trailing: pill, attrs: { 'data-nav-default': '', 'data-ha': 'toggle' } });
  const phone = item('Set up with phone', phoneSetup, { attrs: { 'data-ha': 'phone' } });
  const manual = item('Enter manually', enterManually, { attrs: { 'data-ha': 'manual' } });
  const host = item('Broker address', () => editField('haHost'), { attrs: { 'data-ha': 'host' } });
  const port = item('Port', () => editField('haPort'), { attrs: { 'data-ha': 'port' } });
  const user = item('Username', () => editField('haUsername'), { attrs: { 'data-ha': 'username' } });
  const pass = item('Password', () => editField('haPassword'), { attrs: { 'data-ha': 'password' } });
  const box = item('Box name', editBox, { attrs: { 'data-ha': 'box' } });
  const test = item('Test connection', runTest, { attrs: { 'data-ha': 'test' } });
  phone.sub.textContent = 'Scan a QR code and type the broker login on your phone';
  manual.sub.textContent = 'Broker address, port, username and password with the on-screen keyboard';

  function refresh() {
    const s = Storage.getSettings();
    pill.textContent = s.haEnabled ? 'On' : 'Off';
    pill.classList.toggle('on', !!s.haEnabled);
    toggle.sub.textContent = s.haEnabled
      ? statusText(status, s)
      : 'Off: nothing is sent. Turn on to send what you watch to your own broker.';
    toggle.sub.className = 'li-sub' + (s.haEnabled && status?.state === 'connected' ? ' ok'
      : s.haEnabled && status?.state === 'error' ? ' error' : '');
    host.sub.textContent = s.haHost || 'Not set';
    port.sub.textContent = String(s.haPort || 1883);
    user.sub.textContent = s.haUsername || 'None';
    pass.sub.textContent = s.haPassword ? 'Set (hidden)' : 'None';
    const b = sanitizeBox(s.haBox);
    box.sub.textContent = `${b}. Topics: stremio_tv/${b}/…`;
    test.sub.textContent = !lastTest ? 'Connect once with these settings and show the result'
      : lastTest.ok ? 'Connected: the broker accepted the login' : lastTest.error;
    test.sub.className = 'li-sub' + (lastTest ? (lastTest.ok ? ' ok' : ' error') : '');
  }

  // Live connection status while this screen exists.
  let shown = false;
  const off = ha.onStatus((s) => {
    if (root.isConnected) shown = true;
    else if (shown) { off(); return; }
    status = s;
    refresh();
  });

  function save(patch) {
    Storage.setSettings(patch);
    applyHomeAssistant();
    refresh();
  }

  function toggleEnabled() {
    const on = !Storage.getSettings().haEnabled;
    save({ haEnabled: on });
    if (on && !Storage.getSettings().haHost) toast('Now set up the broker: with your phone, or enter it manually');
  }

  async function runTest() {
    test.sub.textContent = 'Testing…';
    test.sub.className = 'li-sub';
    lastTest = await ha.test(brokerSettings());
    refresh();
    toast(lastTest.ok ? 'Connected to the broker' : `Could not connect: ${lastTest.error}`, lastTest.ok ? 'info' : 'error', 6000);
    return lastTest.ok;
  }

  // Both setup paths end here: store the login, turn on, test.
  async function finishSetup(values) {
    save({ ...values, haEnabled: true });
    await runTest();
  }

  const PROMPTS = {
    haHost: { title: 'Broker address (e.g. 192.168.1.10 or homeassistant.local)' },
    haPort: { title: 'Broker port (usually 1883)' },
    haUsername: { title: 'Broker username (empty for none)' },
    haPassword: { title: 'Broker password (empty for none)', password: true },
  };

  // One keyboard prompt; resolves with the cleaned value, or null.
  async function ask(key) {
    const current = Storage.getSettings()[key];
    const v = await oskPrompt({ ...PROMPTS[key], value: String(current ?? '') });
    if (v === null) return null;
    if (key === 'haPort') {
      const n = Number(v.trim());
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        toast('The port is a number from 1 to 65535', 'error');
        return null;
      }
      return n;
    }
    return key === 'haPassword' ? v : v.trim();
  }

  async function editField(key) {
    const v = await ask(key);
    if (v === null) return;
    save({ [key]: v });
  }

  async function enterManually() {
    const values = {};
    for (const key of ['haHost', 'haPort', 'haUsername', 'haPassword']) {
      const v = await ask(key);
      if (v === null) return;
      values[key] = v;
    }
    if (!values.haHost) { toast('Enter the broker address', 'error'); return; }
    await finishSetup(values);
  }

  async function editBox() {
    const v = await oskPrompt({ title: 'Box name (letters, digits, _)', value: Storage.getSettings().haBox });
    if (v === null) return;
    save({ haBox: sanitizeBox(v) });
  }

  async function phoneSetup() {
    const res = await ha.startPhoneSetup(brokerSettings());
    if (!res || res.error) { toast(res?.error || 'Could not start the setup page', 'error', 6000); return; }
    const state = el('div', { class: 'ha-setup-state', text: 'Waiting for your phone…' });
    const close = el('button', { class: 'focusable btn', 'data-nav-default': '' }, 'Cancel');
    const modal = el('div', { class: 'modal ha-setup' },
      el('div', { class: 'modal-title', text: 'Set up with phone' }),
      el('div', { class: 'ha-setup-body' },
        el('img', { class: 'ha-qr', src: res.qrPng, alt: 'QR code for the setup page' }),
        el('div', { class: 'ha-setup-text' },
          el('ol', { class: 'ha-steps' },
            el('li', {}, 'Scan the code with your phone’s camera, or open this link:',
              el('div', { class: 'ha-setup-url', text: res.url })),
            el('li', { text: 'Enter your broker’s address, username and password.' }),
            el('li', { text: 'Stremio TV connects and shows the result here and on the phone.' })),
          state,
          el('div', { class: 'ha-setup-note', text: 'The page works on your home network only, and closes after 5 minutes or once connected.' }))),
      el('div', { class: 'btn-row' }, close));

    const offSetup = ha.onPhoneSetup((ev) => {
      if (ev.phase === 'testing') {
        state.className = 'ha-setup-state';
        state.textContent = 'Testing the connection…';
      } else if (ev.phase === 'done' && ev.ok) {
        const s = ev.settings;
        save({ haHost: s.host, haPort: s.port, haUsername: s.username, haPassword: s.password, haEnabled: true });
        lastTest = { ok: true, error: '' };
        refresh();
        state.className = 'ha-setup-state ok';
        state.textContent = 'Connected';
        close.textContent = 'Done';
      } else if (ev.phase === 'done') {
        state.className = 'ha-setup-state error';
        state.textContent = `${ev.error}. Fix it on your phone and try again.`;
      } else if (ev.phase === 'expired') {
        state.className = 'ha-setup-state error';
        state.textContent = 'The setup page has closed. Open it again to retry.';
        close.textContent = 'Close';
      }
    });
    const handle = openModal(modal, {
      onClose: () => { offSetup(); ha.stopPhoneSetup(); },
    });
    close.addEventListener('click', () => handle.close());
  }

  refresh();
  return root;
}
