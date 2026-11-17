import { executeRequest } from './bridge-protocol.js';
import { getMeta } from './addons.js';
import { Storage } from './storage.js';
import { closePlayer } from './player.js';
import { resumeFlow } from './streams.js';
import { runPlayerCommand } from './homeassistant.js';
import { closeTopModal, hasOpenModal } from './ui.js';
import { Nav } from './nav.js';

export function initBridgeControl(router) {
  const bridge = window.shell?.bridge;
  if (!bridge) return;
  const pending = new Map();
  const closeModals = () => { while (hasOpenModal()) closeTopModal(); };
  bridge.onCancel((id) => {
    const operation = pending.get(id);
    if (!operation) return;
    operation.cancelled = true;
    if (operation.changed) closeModals();
  });
  bridge.onRequest(async (request) => {
    const operation = {cancelled:false, changed:false, deadline:Date.now() + 18000};
    pending.set(request.id, operation);
    try {
      const result = await executeRequest(request, {
        getMeta, resumeFlow, runPlayerCommand,
        cancelled: () => operation.cancelled || Date.now() > operation.deadline,
        closePlayer: () => { operation.changed = true; closePlayer(); },
        getLibraryEntry: (type, id) => Storage.getLibraryEntry(type, id),
        getLibrary: () => Storage.getLibrary(),
        closeModals,
        push: (...args) => router.push(...args),
        focusEpisode: (screen, videoId) => {
          const item = [...screen.querySelectorAll('[data-video-id]')].find(el => el.dataset.videoId === videoId);
          if (!item) throw new Error('Requested episode was not rendered');
          Nav.focus(item);
        },
      });
      bridge.complete(request.id, {ok: true, result});
    } catch (error) {
      bridge.complete(request.id, {ok: false, error: {
        code: error.code || 'navigation_failed', message: error.code ? error.message : 'Application command failed',
      }});
    } finally {
      pending.delete(request.id);
    }
  });
  bridge.ready(true);
}
