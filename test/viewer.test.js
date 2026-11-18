const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const EventEmitter = require('node:events');
const V = require('../viewer');
const { Viewer } = V;

class FakeGateway extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.sent = []; this.closed = false; this.connected = 0; this.open = true; }
  connect() { this.connected++; }
  send(op, d) { // like Gateway.send: dropped while the socket is down, returns whether it went out
    if (!this.open) return false;
    this.sent.push({ op, d });
    return true;
  }
  close() { this.closed = true; }
}

const ACC = { label: 'a1', token: 'T', username: 'alt', guildId: 'G', channelId: 'C' };
function setup({ watchJitterMs = 0 } = {}) {
  let gw;
  const v = new Viewer(ACC, { createGateway: o => (gw = new FakeGateway(o)), watchJitterMs });
  const notes = [], releases = [];
  v.on('notify', t => notes.push(t));
  v.on('release', r => releases.push(r));
  v.start();
  return { v, gw, notes, releases };
}
const ready = (gw, voice_states = []) => gw.emit('dispatch', 'READY', { user: { id: 'self', username: 'me' }, guilds: [{ id: 'G', voice_states }] });
const vs = (gw, user, channel, stream = false) => gw.emit('dispatch', 'VOICE_STATE_UPDATE', { guild_id: 'G', user_id: user, channel_id: channel, self_stream: stream });
const confirm = (gw, channel = 'C') => vs(gw, 'self', channel);
const ops = (gw, op) => gw.sent.filter(s => s.op === op);
const tick = ms => mock.timers.tick(ms);

test.beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
test.afterEach(() => mock.timers.reset());

test('joins muted and deafened after ready', () => {
  const { gw } = setup();
  assert.equal(gw.connected, 1);
  assert.equal(gw.opts.token, 'T');
  ready(gw);
  assert.deepEqual(ops(gw, 4)[0].d, { guild_id: 'G', channel_id: 'C', self_mute: true, self_deaf: true, self_video: false });
});

test('watches streamer already live at join', () => {
  const { gw } = setup();
  ready(gw, [{ user_id: 'u1', channel_id: 'C', self_stream: true }]);
  assert.equal(ops(gw, 20).length, 0);
  confirm(gw);
  assert.deepEqual(ops(gw, 20).map(s => s.d), [{ stream_key: 'guild:G:C:u1' }]);
});

test('watches every streamer in channel', () => {
  const { v, gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  vs(gw, 'u2', 'C', true);
  vs(gw, 'u3', 'OTHER', true);
  assert.equal(ops(gw, 20).length, 2);
  assert.deepEqual(v.status(), { state: 'standby', watching: ['u1', 'u2'] });
});

test('stops on stream end and rewatches when live again', () => {
  const { v, gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  vs(gw, 'u1', 'C', false);
  assert.deepEqual(v.status().watching, []);
  vs(gw, 'u1', 'C', true);
  assert.equal(ops(gw, 20).length, 2);
});

test('never watches itself', () => {
  const { gw } = setup();
  ready(gw);
  vs(gw, 'self', 'C', true);
  assert.equal(ops(gw, 20).length, 0);
});

test('rejoins after being disconnected', () => {
  const { gw, releases } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'self', null);
  assert.equal(ops(gw, 4).length, 1);
  tick(V.REJOIN_DELAY_MS);
  assert.equal(ops(gw, 4).length, 2);
  assert.equal(ops(gw, 4)[1].d.channel_id, 'C');
  assert.equal(releases.length, 0);
});

test('releases after 3 kicks in 5 minutes', () => {
  const { v, gw, releases } = setup();
  ready(gw);
  for (let i = 0; i < V.KICK_LIMIT; i++) {
    confirm(gw);
    vs(gw, 'self', null);
    tick(V.REJOIN_DELAY_MS);
  }
  assert.equal(releases.length, 1);
  assert.equal(gw.closed, true);
  assert.equal(v.status().state, 'stopped');
});

test('kicks spread over more than 5 minutes are not released', () => {
  const { gw, releases } = setup();
  ready(gw);
  for (let i = 0; i < V.KICK_LIMIT; i++) {
    confirm(gw);
    vs(gw, 'self', null);
    tick(V.KICK_WINDOW_MS / 2);
  }
  assert.equal(releases.length, 0);
});

test('move() is not counted as a kick', () => {
  const { v, gw, releases } = setup();
  ready(gw);
  confirm(gw);
  v.move('G', 'C2');
  assert.equal(ops(gw, 4).at(-1).d.channel_id, 'C2');
  confirm(gw, 'C2');
  assert.equal(v.status().state, 'standby');
  tick(V.KICK_WINDOW_MS * 2);
  assert.equal(ops(gw, 4).length, 2);
  assert.equal(releases.length, 0);
});

test('move() to another server watches who is already live there', () => {
  const { v, gw } = setup();
  gw.emit('dispatch', 'READY', { user: { id: 'self' }, guilds: [{ id: 'G', voice_states: [] }, { id: 'G2', voice_states: [{ user_id: 'u9', channel_id: 'C9', self_stream: true }] }] });
  confirm(gw);
  v.move('G2', 'C9');
  gw.emit('dispatch', 'VOICE_STATE_UPDATE', { guild_id: 'G2', user_id: 'self', channel_id: 'C9' });
  assert.deepEqual(ops(gw, 20).map(s => s.d), [{ stream_key: 'guild:G2:C9:u9' }]);
});

test('join timeout: join_failed, notify once, retry', () => {
  const { v, gw, notes } = setup();
  ready(gw);
  tick(V.JOIN_TIMEOUT_MS);
  assert.equal(v.status().state, 'join_failed');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /a1/);
  assert.match(notes[0], /@alt/);
  assert.match(notes[0], /<#C>/);
  tick(V.JOIN_RETRY_MS);
  assert.equal(ops(gw, 4).length, 2);
  tick(V.JOIN_TIMEOUT_MS);
  assert.equal(notes.length, 1);
  confirm(gw);
  assert.equal(v.status().state, 'standby');
  assert.equal(notes.length, 2); // "berhasil join" after a failure
});

test('releases when removed from server', () => {
  const { gw, releases } = setup();
  ready(gw);
  confirm(gw);
  gw.emit('dispatch', 'GUILD_DELETE', { id: 'G' });
  assert.equal(releases.length, 1);
  assert.equal(gw.closed, true);
});

test('waits on server outage', () => {
  const { gw, releases } = setup();
  ready(gw);
  gw.emit('dispatch', 'GUILD_DELETE', { id: 'G', unavailable: true });
  gw.emit('dispatch', 'GUILD_DELETE', { id: 'OTHER' });
  assert.equal(releases.length, 0);
});

test('releases when channel deleted', () => {
  const { gw, releases } = setup();
  ready(gw);
  gw.emit('dispatch', 'CHANNEL_DELETE', { id: 'OTHER' });
  assert.equal(releases.length, 0);
  gw.emit('dispatch', 'CHANNEL_DELETE', { id: 'C' });
  assert.equal(releases.length, 1);
});

test('STREAM_DELETE rewatches after cooldown, notifies after 3 rejections', () => {
  const { v, gw, notes } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  for (let i = 1; i <= V.STREAM_REJECT_NOTIFY; i++) {
    gw.emit('dispatch', 'STREAM_DELETE', { stream_key: 'guild:G:C:u1', reason: 'stream_full' });
    assert.deepEqual(v.status().watching, []);
    vs(gw, 'u2', 'C', false); // unrelated update must not bypass the cooldown
    assert.equal(ops(gw, 20).length, i);
    tick(V.STREAM_RETRY_MS);
    assert.equal(ops(gw, 20).length, i + 1);
  }
  assert.equal(notes.length, 1);
  assert.match(notes[0], /stream_full/);
});

test('normal stream end does not count as a rejection', () => {
  const { gw, notes } = setup();
  ready(gw);
  confirm(gw);
  for (let i = 0; i < V.STREAM_REJECT_NOTIFY; i++) {
    vs(gw, 'u1', 'C', true);
    gw.emit('dispatch', 'STREAM_DELETE', { stream_key: 'guild:G:C:u1', reason: 'stream_ended' });
    vs(gw, 'u1', 'C', false);
    tick(V.STREAM_RETRY_MS);
  }
  assert.equal(notes.length, 0);
});

test('fresh READY after reconnect rejoins and rewatches', () => {
  const { gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  ready(gw, [{ user_id: 'u1', channel_id: 'C', self_stream: true }]);
  assert.equal(ops(gw, 4).length, 2);
  confirm(gw);
  assert.equal(ops(gw, 20).length, 2);
});

test('resume keeps watching without rejoining', () => {
  const { v, gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  gw.emit('reconnecting', 1006);
  assert.equal(v.status().state, 'connecting');
  gw.emit('dispatch', 'RESUMED', {});
  assert.deepEqual(v.status(), { state: 'standby', watching: ['u1'] });
  assert.equal(ops(gw, 4).length, 1);
});

test('RESUMED rejoins when the rejoin was sent while the socket was down', () => {
  const { gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'self', null); // kicked
  gw.open = false;
  gw.emit('reconnecting', 1006);
  tick(V.REJOIN_DELAY_MS); // rejoin op 4 goes nowhere
  const before = ops(gw, 4).length;
  gw.open = true;
  gw.emit('dispatch', 'RESUMED', {});
  assert.equal(ops(gw, 4).length, before + 1);
  assert.equal(ops(gw, 4).at(-1).d.channel_id, 'C');
});

test('stream retry rewatches even when the timer fires before Date.now reaches the cooldown', () => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] }); // real Date: the retry timer fires "early"
  const { gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  gw.emit('dispatch', 'STREAM_DELETE', { stream_key: 'guild:G:C:u1', reason: 'stream_full' });
  tick(V.STREAM_RETRY_MS);
  assert.equal(ops(gw, 20).length, 2);
});

test('join timeout is paused while the gateway reconnects', () => {
  const { v, gw, notes } = setup();
  ready(gw);
  gw.open = false;
  gw.emit('reconnecting', 1006);
  tick(V.JOIN_TIMEOUT_MS * 2);
  assert.equal(notes.length, 0);
  assert.equal(v.status().state, 'connecting');
  gw.open = true;
  gw.emit('dispatch', 'RESUMED', {});
  assert.equal(ops(gw, 4).length, 2);
  tick(V.JOIN_TIMEOUT_MS);
  assert.equal(notes.length, 1); // a real failure after reconnecting still notifies
});

test('failed move leaves the old channel instead of sitting there', () => {
  const { v, gw } = setup();
  ready(gw);
  confirm(gw);
  v.move('G', 'C2');
  tick(V.JOIN_TIMEOUT_MS);
  assert.deepEqual(ops(gw, 4).at(-1).d, { guild_id: 'G', channel_id: null, self_mute: false, self_deaf: false });
  assert.equal(v.status().state, 'join_failed');
});

test('a join that simply fails from nowhere sends no leave', () => {
  const { gw } = setup();
  ready(gw);
  tick(V.JOIN_TIMEOUT_MS);
  assert.equal(ops(gw, 4).filter(s => s.d.channel_id === null).length, 0);
});

test('watch requests are spread out by a random delay', () => {
  const { gw } = setup({ watchJitterMs: 3000 });
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  vs(gw, 'u2', 'C', true);
  assert.equal(ops(gw, 20).length, 0);
  vs(gw, 'u2', 'C', false); // u2 stops before its delayed watch goes out
  tick(3000);
  assert.deepEqual(ops(gw, 20).map(s => s.d), [{ stream_key: 'guild:G:C:u1' }]);
});

test('a watch dropped while the socket is down is re-sent after RESUMED', () => {
  const { v, gw } = setup({ watchJitterMs: 3000 });
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  gw.open = false; // socket drops inside the jitter window (op 7 style, no reconnecting event)
  tick(3000);
  assert.equal(ops(gw, 20).length, 0);
  assert.deepEqual(v.status().watching, []); // not claiming to watch what never went out
  gw.open = true;
  gw.emit('dispatch', 'RESUMED', {});
  tick(3000);
  assert.equal(ops(gw, 20).length, 1);
  assert.deepEqual(v.status().watching, ['u1']);
});

test('a stream retry dropped while the socket is down is re-sent after RESUMED', () => {
  const { gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  gw.emit('dispatch', 'STREAM_DELETE', { stream_key: 'guild:G:C:u1', reason: 'unauthorized' });
  gw.open = false;
  tick(V.STREAM_RETRY_MS);
  gw.open = true;
  gw.emit('dispatch', 'RESUMED', {});
  assert.equal(ops(gw, 20).length, 2);
});

test('a move during an outage waits for the gateway instead of reporting gagal join', () => {
  const { v, gw, notes } = setup();
  ready(gw);
  confirm(gw);
  gw.emit('reconnecting', 1006);
  v.move('G', 'D');
  tick(V.JOIN_TIMEOUT_MS * 2);
  assert.equal(notes.length, 0);
  assert.equal(v.status().state, 'connecting');
  gw.emit('dispatch', 'RESUMED', {});
  assert.equal(ops(gw, 4).filter(s => s.d.channel_id === 'D').length, 1);
});

test('a kick rejoin during an outage waits for the gateway instead of reporting gagal join', () => {
  const { v, gw, notes } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'self', null); // kicked
  gw.emit('reconnecting', 1006);
  tick(V.REJOIN_DELAY_MS + V.JOIN_TIMEOUT_MS * 2);
  assert.equal(notes.length, 0);
  assert.equal(v.status().state, 'connecting');
  gw.emit('dispatch', 'RESUMED', {});
  assert.equal(ops(gw, 4).at(-1).d.channel_id, 'C');
});

test('a stream that stops and restarts inside the jitter window is watched once', () => {
  const { gw } = setup({ watchJitterMs: 3000 });
  ready(gw);
  confirm(gw);
  vs(gw, 'u1', 'C', true);
  vs(gw, 'u1', 'C', false);
  vs(gw, 'u1', 'C', true);
  tick(3000);
  assert.equal(ops(gw, 20).length, 1);
});

test('renames of the target channel or server are reported', () => {
  const { v, gw } = setup();
  const names = [];
  v.on('names', n => names.push(n));
  ready(gw);
  gw.emit('dispatch', 'CHANNEL_UPDATE', { id: 'OTHER', name: 'x' });
  gw.emit('dispatch', 'CHANNEL_UPDATE', { id: 'C', name: 'new-room' });
  gw.emit('dispatch', 'GUILD_UPDATE', { id: 'G', name: 'New Server' });
  assert.deepEqual(names, [{ channelName: 'new-room' }, { guildName: 'New Server' }]);
});

test('dead token emits dead', () => {
  const { v, gw } = setup();
  let dead = 0;
  v.on('dead', () => dead++);
  gw.emit('dead', 4004);
  assert.equal(dead, 1);
  assert.equal(v.status().state, 'dead');
  assert.equal(gw.closed, true);
});

test('stop() before ready never joins', () => {
  const { v, gw } = setup();
  v.stop();
  assert.equal(gw.closed, true);
  ready(gw);
  assert.equal(ops(gw, 4).filter(s => s.d.channel_id).length, 0);
});

test('stop() leaves voice and cancels pending rejoin', () => {
  const { v, gw } = setup();
  ready(gw);
  confirm(gw);
  vs(gw, 'self', null); // kicked, rejoin pending
  v.stop();
  assert.equal(ops(gw, 4).at(-1).d.channel_id, null);
  tick(V.REJOIN_DELAY_MS * 10);
  assert.equal(ops(gw, 4).filter(s => s.d.channel_id).length, 1);
  assert.equal(v.status().state, 'stopped');
});
