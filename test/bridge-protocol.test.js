const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const protocol = import('data:text/javascript;base64,' + fs.readFileSync(require('node:path').join(__dirname, '../ui/js/bridge-protocol.js')).toString('base64'));
function deps() {
  const calls = [];
  return {calls, getMeta: async () => ({id: 'tt123', videos: [{id: 'tt123:2:3'}]}),
    getLibraryEntry: () => null, closePlayer: () => calls.push('close'), closeModals: () => {},
    push: async (name, params) => { calls.push(params); return {}; },
    focusEpisode: (_, id) => calls.push(id), resumeFlow: async () => ({status: 'stream_selection'}),
    runPlayerCommand: cmd => {calls.push(cmd); return true;}};
}
test('valid movie and exact episode navigation; no autoplay', async () => {
  const {executeRequest} = await protocol;
  const d = deps();
  let result = await executeRequest({id:'one', command:'open',content_type:'movie',content_id:'tt123'},d);
  assert.equal(result.delivery,'detail');
  result = await executeRequest({id:'two',command:'open',content_type:'episode',content_id:{series_id:'tt123',video_id:'tt123:2:3'}},d);
  assert.equal(result.video_id,'tt123:2:3');
  assert.equal(d.calls.at(-1),'tt123:2:3');
});
test('missing episode or resume preserves existing player', async () => {
  const {executeRequest} = await protocol;
  for (const patch of [{content_type:'episode',content_id:{series_id:'tt123',video_id:'missing'}},
                      {content_type:'movie',content_id:'tt123',resume:true}]) {
    const d=deps();
    await assert.rejects(executeRequest({id:'one',command:'open',...patch},d));
    assert.deepEqual(d.calls,[]);
  }
});
test('resume uses stored progress and reports stream selection, not playing', async () => {
  const {executeRequest} = await protocol;const d=deps();d.getLibraryEntry=()=>({time:42});
  assert.equal((await executeRequest({id:'one',command:'open',content_type:'movie',content_id:'tt123',resume:true},d)).delivery,'stream_selection');
});
test('unsafe IDs, extra fields and malformed seeks are rejected', async () => {
  const {validateRequest}=await protocol;
  for (const r of [{command:'open',content_type:'movie',content_id:'https://example.com'},
    {command:'open',content_type:'movie',content_id:'tt123\n'},
    {command:'open',content_type:'movie',content_id:'tt123',resume:'yes'},
    {command:'seek',position:-1},{command:'seek',position:NaN},{command:'seek',position:true},
    {command:'play',javascript:'alert(1)'},{command:'open',content_type:'episode',content_id:{series_id:'tt123',video_id:'tt123:1:2',extra:true}}])
    assert.throws(()=>validateRequest({id:'one',...r}));
});
test('playback requests use existing handler and fail if no player', async()=>{
  const {executeRequest}=await protocol;const d=deps();
  await executeRequest({id:'one',command:'seek',position:12},d);
  assert.deepEqual(d.calls,[{action:'seek_absolute',position:12}]);
  d.runPlayerCommand=()=>false;
  await assert.rejects(executeRequest({id:'two',command:'pause'},d),{code:'not_playing'});
});

test('a cancelled slow lookup cannot navigate or stop the existing player', async () => {
  const {executeRequest}=await protocol;const d=deps();
  let cancelled=false;
  d.cancelled=()=>cancelled;
  d.getMeta=async()=>{cancelled=true;return {id:'tt123'};};
  await assert.rejects(executeRequest({id:'one',command:'open',content_type:'movie',content_id:'tt123'},d),{code:'command_timeout'});
  assert.deepEqual(d.calls,[]);
});
test('browse pages the stored library without navigating', async () => {
  const {executeRequest} = await protocol;
  const d = deps();
  d.getLibrary = () => ({
    'movie:tt1': {type:'movie', id:'tt1', name:'Old', time:5, updatedAt:1},
    'series:tt2': {type:'series', id:'tt2', name:'New', time:90, updatedAt:9},
    'movie:bad': {type:'movie', id:'http://x/y', name:'Unsafe', updatedAt:5},
    'tv:tt3': {type:'tv', id:'tt3', name:'Other', updatedAt:7},
  });
  const first = await executeRequest({id:'b1', command:'browse', limit:1}, d);
  assert.deepEqual(first, {items:[{id:'tt2', name:'New', content_type:'series', path:null, resumable:true}], next_offset:1, total:2});
  const second = await executeRequest({id:'b2', command:'browse', offset:1, limit:1}, d);
  assert.equal(second.items[0].id, 'tt1');
  assert.equal(second.next_offset, null);
  assert.deepEqual(d.calls, []);
  for (const bad of [{limit:51}, {offset:-1}, {offset:1.5}, {path:'x'}])
    await assert.rejects(executeRequest({id:'b3', command:'browse', ...bad}, d));
});
