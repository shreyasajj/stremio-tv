// App bootstrap: screen router with a Back stack, sidebar wiring, first-run
// addon install.

import { Nav } from './nav.js';
import { el, toast, closeTopModal, hasOpenModal, confirmModal } from './ui.js';
import { installedAddons, installDefaultAddons } from './addons.js';
import { Storage } from './storage.js';
import { isPlayerOpen } from './player.js';

import * as home from './screens/home.js';
import * as discover from './screens/discover.js';
import * as search from './screens/search.js';
import * as detail from './screens/detail.js';
import * as library from './screens/library.js';
import * as addons from './screens/addons.js';
import * as settings from './screens/settings.js';

const SCREENS = { home, discover, search, detail, library, addons, settings };
const container = document.getElementById('screens');
const sidebar = document.getElementById('sidebar');

const stack = []; // { name, params, el, returnFocus }

const router = {
  // Sidebar navigation: replace the whole stack.
  async show(name, params = {}) {
    while (stack.length) stack.pop().el.remove();
    await this.push(name, params, { returnFocus: null });
  },

  // Drill-down navigation (e.g. into a detail page).
  async push(name, params = {}, { returnFocus = document.activeElement } = {}) {
    const mod = SCREENS[name];
    if (!mod) return;
    let screenEl;
    try {
      screenEl = await mod.render({ router, params });
    } catch (e) {
      console.error(e);
      toast('Screen failed to load: ' + e.message, 'error');
      return;
    }
    if (stack.length) stack[stack.length - 1].el.classList.add('hidden');
    stack.push({ name, params, el: screenEl, returnFocus });
    container.append(screenEl);
    markSidebar(name);
    Nav.focusFirst(screenEl);
  },

  async back() {
    if (stack.length > 1) {
      const popped = stack.pop();
      popped.el.remove();
      const top = stack[stack.length - 1];
      top.el.classList.remove('hidden');
      markSidebar(top.name);
      if (popped.returnFocus && popped.returnFocus.isConnected) Nav.focus(popped.returnFocus);
      else Nav.focusFirst(top.el);
      return;
    }
    if (stack.length === 1 && stack[0].name !== 'home') {
      await this.show('home');
      return;
    }
    // Back on Home: offer to exit (Bigscreen remotes have no other way out).
    if (await confirmModal('Exit Stremio TV?', { okLabel: 'Exit' })) {
      if (window.shell?.quit) window.shell.quit();
      else window.close();
    }
  },

  // Re-render the current screen in place (after settings/addon changes).
  async refresh() {
    const top = stack[stack.length - 1];
    if (!top) return;
    const mod = SCREENS[top.name];
    try {
      const fresh = await mod.render({ router, params: top.params });
      top.el.replaceWith(fresh);
      top.el = fresh;
      Nav.focusFirst(fresh);
    } catch (e) {
      console.error(e);
    }
  },

  current: () => stack[stack.length - 1]?.name || null,
};

function markSidebar(name) {
  sidebar.querySelectorAll('.sidebar-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.screen === name);
  });
}

function wireSidebar() {
  sidebar.querySelectorAll('.sidebar-item').forEach((b) => {
    b.addEventListener('click', () => router.show(b.dataset.screen));
  });
}

async function boot() {
  Nav.init();
  Nav.setBackHandler(() => {
    if (hasOpenModal()) { closeTopModal(); return; }
    if (isPlayerOpen()) return; // the player consumes its own back presses
    router.back();
  });
  wireSidebar();
  // Re-render the underlying screen when playback ends so Resume buttons and
  // Continue Watching rows reflect the new progress.
  document.addEventListener('player:closed', () => router.refresh());

  // First run: pull in the default catalog/subtitle addons.
  if (!installedAddons().length && !localStorage.getItem('stv.firstRunDone')) {
    toast('First start — installing default addons (Cinemeta)…');
    await installDefaultAddons();
    localStorage.setItem('stv.firstRunDone', '1');
    if (!installedAddons().length) {
      toast('Could not reach the default addons. Check your network, then use “Restore default addons” in Add-ons.', 'error', 8000);
    }
  }

  await router.show('home');
}

window.stremioTV = { router, Storage }; // handy for debugging from devtools
boot();
