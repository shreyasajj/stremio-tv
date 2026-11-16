// UI bridge contract, kept independent of DOM/native APIs for deterministic tests.
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const validId = value => typeof value === 'string' && ID.test(value) && !/[\r\n]/.test(value);
export class BridgeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function validateRequest(request) {
  const fail = (message) => { throw new BridgeError('invalid_request', message); };
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('Expected an object');
  if (typeof request.id !== 'string' || !request.id.length || request.id.length > 128) fail('Request ID required');
  const allowed = new Set(['id', 'command']);
  if (request.command === 'open') {
    ['content_type', 'content_id', 'resume'].forEach(k => allowed.add(k));
    if (!['movie', 'series', 'episode'].includes(request.content_type)) throw new BridgeError('unsupported', 'Unsupported content type');
    if (request.resume !== undefined && typeof request.resume !== 'boolean') fail('Resume must be boolean');
    if (request.content_type === 'episode') {
      const c = request.content_id;
      if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== 2
          || !validId(c.series_id) || !validId(c.video_id)
          || typeof c.series_id !== 'string' || typeof c.video_id !== 'string') fail('Episode requires series_id and video_id');
    } else if (!validId(request.content_id)) fail('Invalid Stremio ID');
  } else if (request.command === 'seek') {
    allowed.add('position');
    if (typeof request.position !== 'number' || !Number.isFinite(request.position) || request.position < 0) fail('Invalid seek position');
  } else if (!['play', 'pause', 'stop'].includes(request.command)) throw new BridgeError('unsupported', 'Unsupported renderer command');
  if (Object.keys(request).some(k => !allowed.has(k))) fail('Unknown request fields');
  return request;
}

export async function executeRequest(raw, deps) {
  const request = validateRequest(raw);
  const guard = () => {
    if (deps.cancelled?.()) throw new BridgeError('command_timeout', 'The application command was cancelled');
  };
  guard();
  if (request.command !== 'open') {
    const cmd = request.command === 'seek' ? {action: 'seek_absolute', position: request.position} : {action: request.command};
    if (!deps.runPlayerCommand(cmd)) throw new BridgeError('not_playing', 'No active player supports this command');
    return {command: request.command};
  }
  const type = request.content_type === 'movie' ? 'movie' : 'series';
  const id = request.content_type === 'episode' ? request.content_id.series_id : request.content_id;
  let meta;
  try { meta = await deps.getMeta(type, id); } catch { throw new BridgeError('content_not_found', 'The installed addons could not resolve this title'); }
  guard();
  if (!meta || (meta.id && meta.id !== id)) throw new BridgeError('content_not_found', 'Title not found');
  const episode = request.content_type === 'episode'
    ? meta.videos?.find(v => v.id === request.content_id.video_id) : null;
  if (request.content_type === 'episode' && !episode) throw new BridgeError('content_not_found', 'Episode not found in this series');
  const entry = request.resume ? deps.getLibraryEntry(type, id) : null;
  if (request.resume && (!entry || !(entry.time > 10) || (episode && entry.videoId !== episode.id)))
    throw new BridgeError('resume_unavailable', 'No matching stored playback to resume');
  // Validate and resolve before changing the current UI/player.
  deps.closePlayer();
  deps.closeModals();
  const screen = await deps.push('detail', {type, id, resolvedMeta: meta, videoId: episode?.id});
  guard();
  if (!screen) throw new BridgeError('navigation_failed', 'The detail page did not open');
  if (episode) deps.focusEpisode(screen, episode.id);
  let delivery = 'detail';
  if (request.resume) {
    const result = await deps.resumeFlow(meta, entry);
    guard();
    if (!result || !['stream_selection', 'playing_requested'].includes(result.status))
      throw new BridgeError(result?.status || 'resume_failed', 'Stored playback could not be resumed');
    delivery = result.status;
  }
  return {type, id, video_id: episode?.id || null, delivery};
}
