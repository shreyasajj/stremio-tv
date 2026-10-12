// Settings: account, streaming server (for torrent addons), subtitles, exit.

import { el, toast, pickerModal, confirmModal } from '../ui.js';
import { Storage } from '../storage.js';
import { oskPrompt } from '../keyboard.js';
import { logout, loggedInEmail } from '../stremio-api.js';

export async function render({ router }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Settings' }));

  const list = el('div');
  root.append(list);

  function settingItem(title, subText, onClick, opts = {}) {
    const item = el('button', { class: 'focusable list-item', ...(opts.attrs || {}) },
      el('div', { class: 'li-title', text: title }),
      el('div', { class: 'li-sub', text: subText }));
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


  // Diagnostics are deliberately read-only. Chromium's channel profiles do
  // not establish Dolby Atmos bitstream passthrough capability.
  settingItem(
    'HDMI audio diagnostics',
    'View Wayland, PipeWire/PulseAudio and ALSA outputs (does not enable Atmos)',
    async () => {
      if (!window.shell?.audioDiagnostics) {
        toast('Audio diagnostics require the desktop app', 'error');
        return;
      }
      try {
        const info = await window.shell.audioDiagnostics();
        const report = [
          'Session: ' + info.session,
          'Audio server:',
          info.commands.server || 'Unknown',
          'Audio sinks:',
          info.commands.sinks || 'None found',
          'ALSA devices:',
          info.commands.alsa || 'None found',
          'NOTE: 5.1/7.1 PCM is not proof of Dolby Atmos passthrough.',
        ].join('\\n\\n');
        console.info('HDMI audio diagnostics\\n' + report);
        const copied = await confirmModal(
          'Audio diagnostics collected. Select Copy to copy the results. ' +
          'No audio settings were changed.',
          { okLabel: 'Copy', cancelLabel: 'Close' }
        );
        if (copied) {
          await window.shell.writeClipboard(report);
          toast('Diagnostics copied');
        }
      } catch (error) {
        console.error('Audio diagnostics failed', error);
        toast('Could not read audio diagnostics', 'error');
      }
    }
  );

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
