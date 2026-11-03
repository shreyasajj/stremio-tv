// Settings: account, streaming server (for torrent addons), subtitles, exit.

import { el, toast, pickerModal, confirmModal } from '../ui.js';
import { Storage } from '../storage.js';
import { oskPrompt } from '../keyboard.js';
import { logout, loggedInEmail } from '../stremio-api.js';
import { nativeMpvAvailable, PASSTHROUGH_PRESETS } from '../mpv-video.js';
import { haAvailable, statusText } from '../homeassistant.js';
import { icon } from '../icons.js';

export async function render({ router }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Settings' }));

  const list = el('div', { class: 'settings-list' });
  root.append(list);

  function settingItem(title, subText, onClick, opts = {}) {
    const item = el('button', { class: 'focusable list-item setting-item', ...(opts.attrs || {}) },
      el('div', { class: 'setting-text' },
        el('div', { class: 'li-title', text: title }),
        el('div', { class: 'li-sub', text: subText })),
      icon('chevronRight'));
    item.addEventListener('click', onClick);
    list.append(item);
    return item;
  }

  const settings = Storage.getSettings();

  // Account
  const email = loggedInEmail();
  settingItem(
    'Stremio account',
    email ? `Logged in as ${email}` : 'Not logged in — log in from the Add-ons screen to import your addons',
    async () => {
      if (!email) { router.show('addons'); return; }
      if (await confirmModal(`Log out of ${email}?`, { okLabel: 'Log out' })) {
        logout();
        toast('Logged out');
        router.refresh();
      }
    },
    { attrs: { 'data-nav-default': '' } }
  );

  // Streaming server
  settingItem(
    'Streaming server URL (for torrent addons)',
    settings.streamingServer
      ? settings.streamingServer
      : 'Not set. Debrid/HTTP streams (AIOStreams) play without this. Set e.g. http://127.0.0.1:11470 if you run Stremio’s streaming server for raw torrents.',
    async () => {
      const v = await oskPrompt({ title: 'Streaming server URL (empty to disable)', value: settings.streamingServer });
      if (v === null) return;
      Storage.setSettings({ streamingServer: v.trim() });
      toast(v.trim() ? 'Streaming server set' : 'Streaming server cleared');
      router.refresh();
    }
  );

  // Subtitle size
  settingItem(
    'Subtitle size',
    `${settings.subtitleSize}%`,
    async () => {
      const chosen = await pickerModal('Subtitle size',
        [75, 100, 125, 150, 200].map((v) => ({ label: v + '%', value: v })),
        { selectedValue: settings.subtitleSize });
      if (chosen !== null) {
        Storage.setSettings({ subtitleSize: chosen });
        document.documentElement.style.setProperty('--cue-size', chosen + '%');
        router.refresh();
      }
    }
  );

  // Audio output (native libmpv player only)
  if (nativeMpvAvailable()) {
    const devices = (await window.shell.mpv.get('audio-device-list')) || [];
    const deviceLabel = (name) => {
      if (!name || name === 'auto') return 'System default (PipeWire/PulseAudio)';
      const d = devices.find((x) => x.name === name);
      return d ? `${d.description} — ${d.name}` : name;
    };
    settingItem('Audio output device', deviceLabel(settings.audioDevice), async () => {
      const options = [{ label: deviceLabel('auto'), value: 'auto' }];
      devices.filter((d) => d.name !== 'auto').forEach((d) => {
        options.push({ label: d.description || d.name, sub: d.name, value: d.name });
      });
      const chosen = await pickerModal('Audio output device', options, { selectedValue: settings.audioDevice || 'auto' });
      if (chosen !== null) {
        Storage.setSettings({ audioDevice: chosen });
        toast('Applies from the next video you play');
        router.refresh();
      }
    });

    const preset = PASSTHROUGH_PRESETS.find((p) => p.value === (settings.audioPassthrough || '')) || PASSTHROUGH_PRESETS[0];
    settingItem(
      'Surround passthrough (Dolby / DTS bitstream)',
      `${preset.label}. Sends the encoded audio to your TV/soundbar untouched. ` +
        'Most reliable with an HDMI ALSA device (alsa/hdmi:…) selected above; volume is then controlled on the soundbar.',
      async () => {
        const chosen = await pickerModal('Surround passthrough',
          PASSTHROUGH_PRESETS.map((p) => ({ label: p.label, value: p.value })),
          { selectedValue: preset.value });
        if (chosen !== null) {
          Storage.setSettings({ audioPassthrough: chosen });
          toast('Applies from the next video you play');
          router.refresh();
        }
      }
    );
  }

  // Home Assistant (native shell only)
  if (haAvailable()) {
    const item = settingItem('Home Assistant', '', () => router.push('homeassistant'), { attrs: { 'data-setting': 'home-assistant' } });
    const sub = item.querySelector('.li-sub');
    const describe = (status) => {
      const s = Storage.getSettings();
      sub.textContent = s.haEnabled
        ? `${statusText(status, s)}. Sends what you watch to your own MQTT broker.`
        : 'Off. When on, sends what you watch (title, position, poster) to your own MQTT broker, and lets Home Assistant pause or stop playback.';
    };
    describe(await window.shell.homeAssistant.status());
    // Live status while this screen exists; a re-rendered screen subscribes anew.
    const off = window.shell.homeAssistant.onStatus((status) => {
      if (item.isConnected) item._shown = true;
      else if (item._shown) { off(); return; }
      describe(status);
    });
  }

  // Clear watch history
  settingItem('Clear watch history', 'Removes all Continue Watching / Library progress', async () => {
    if (await confirmModal('Clear all watch progress?', { okLabel: 'Clear', danger: true })) {
      localStorage.removeItem('stv.library');
      toast('Watch history cleared');
      router.refresh();
    }
  });

  // About + exit
  settingItem('About', 'Stremio TV — a remote-first Stremio client for Plasma Bigscreen. Addon-protocol compatible (AIOStreams, Cinemeta, …).', () => {});
  settingItem('Exit Stremio TV', 'Close the app and return to the Bigscreen launcher', async () => {
    if (await confirmModal('Exit Stremio TV?', { okLabel: 'Exit' })) {
      if (window.shell?.quit) window.shell.quit();
      else window.close();
    }
  });

  return root;
}
