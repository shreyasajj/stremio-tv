// Add-ons manager: list/remove installed addons, add by URL (AIOStreams etc.),
// import the addon collection from a Stremio account, restore defaults.

import { el, toast, confirmModal } from '../ui.js';
import { oskPrompt } from '../keyboard.js';
import {
  installedAddons, installAddon, removeAddon, fetchAddon, installDefaultAddons,
} from '../addons.js';
import { login, logout, loggedInEmail, fetchAccountAddons } from '../stremio-api.js';

export async function render({ router }) {
  const root = el('div', { class: 'screen' });
  root.append(el('h1', { class: 'screen-title', text: 'Add-ons' }));

  const btnRow = el('div', { class: 'btn-row' });
  const list = el('div');
  root.append(btnRow, list);

  // ---- Add by URL (this is how you add AIOStreams) ----
  const addBtn = el('button', { class: 'focusable btn primary', 'data-nav-default': '', text: '+  Add addon by URL' });
  addBtn.addEventListener('click', async () => {
    const url = await oskPrompt({ title: 'Addon manifest URL (https://… or stremio://…)' });
    if (!url) return;
    try {
      const addon = await fetchAddon(url);
      installAddon(addon);
      toast(`Installed: ${addon.manifest.name}`);
      router.refresh();
    } catch (e) {
      toast('Could not install addon: ' + e.message, 'error', 6000);
    }
  });

  // ---- Import from Stremio account ----
  const importBtn = el('button', { class: 'focusable btn', text: '⇩  Import from Stremio account' });
  importBtn.addEventListener('click', async () => {
    try {
      if (!loggedInEmail()) {
        const email = await oskPrompt({ title: 'Stremio account email' });
        if (!email) return;
        const password = await oskPrompt({ title: 'Stremio account password', password: true });
        if (!password) return;
        await login(email.trim(), password);
        toast('Logged in as ' + email.trim());
      }
      const addons = await fetchAccountAddons();
      let n = 0;
      for (const a of addons) {
        installAddon(a);
        n++;
      }
      toast(`Imported ${n} addon${n === 1 ? '' : 's'} from your account`);
      router.refresh();
    } catch (e) {
      toast('Import failed: ' + e.message, 'error', 6000);
    }
  });

  // ---- Restore defaults ----
  const defaultsBtn = el('button', { class: 'focusable btn', text: '↺  Restore default addons' });
  defaultsBtn.addEventListener('click', async () => {
    await installDefaultAddons();
    toast('Default addons restored (Cinemeta, OpenSubtitles)');
    router.refresh();
  });

  btnRow.append(addBtn, importBtn, defaultsBtn);

  // ---- Installed list ----
  const addons = installedAddons();
  if (!addons.length) {
    list.append(el('div', { class: 'empty-note', text: 'No addons installed. Add your AIOStreams URL above, or restore the defaults.' }));
  }
  addons.forEach((addon) => {
    const m = addon.manifest;
    const caps = [
      m.catalogs?.length ? `${m.catalogs.length} catalog${m.catalogs.length === 1 ? '' : 's'}` : null,
      (m.resources || []).map((r) => (typeof r === 'string' ? r : r.name)).join(', '),
    ].filter(Boolean).join(' · ');
    const removeBtn = el('button', { class: 'focusable btn danger', text: 'Remove' });
    removeBtn.addEventListener('click', async () => {
      if (await confirmModal(`Remove “${m.name}”?`, { okLabel: 'Remove', danger: true })) {
        removeAddon(m.id);
        toast(`Removed ${m.name}`);
        router.refresh();
      }
    });
    const item = el('div', { class: 'list-item' },
      el('div', { class: 'addon-line' },
        m.logo ? el('img', { class: 'addon-logo', src: m.logo }) : el('div', { class: 'addon-logo' }),
        el('div', { class: 'grow' },
          el('div', { class: 'li-title', text: `${m.name}  ` }, el('span', { class: 'kv-label', text: 'v' + (m.version || '?') })),
          el('div', { class: 'li-sub', text: (m.description || '').slice(0, 180) }),
          el('div', { class: 'kv-label', text: caps })),
        removeBtn));
    list.append(item);
  });

  return root;
}
