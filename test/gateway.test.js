const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { Gateway, createLoginQueue } = require('../gateway');

class FakeWS {
  static all = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.l = {};
    this.readyState = 0;
    FakeWS.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.fire('open'); });
  }
  addEventListener(e, f) { this.l[e] = f; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code) { // client-side close
    if (this.readyState === 3) return;
    this.closedWith = code;
    this.readyState = 3;
    this.fire('close', { code });
  }
  drop(code) { this.readyState = 3; this.fire('close', { code }); } // server-side close
  fire(e, x) { this.l[e]?.(x); }
  server(msg) { this.fire('message', { data: JSON.stringify(msg) }); }
}

const flush = () => new Promise(r => setImmediate(r));
const noGap = () => createLoginQueue(() => 0);
async function hello(ws) {
  await flush();
  ws.server({ op: 10, d: { heartbeat_interval: 41250 } });
}
const READY = { op: 0, t: 'READY', s: 5, d: { session_id: 'S', resume_gateway_url: 'wss://r', user: { id: '1' } } };

test.beforeEach(() => {
  FakeWS.all = [];
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
});
test.afterEach(() => mock.timers.reset());

test('user identify after HELLO carries client properties', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  const id = ws.sent.find(p => p.op === 2);
  assert.equal(id.d.token, 'T');
  assert.ok(id.d.capabilities > 0);
  assert.equal(id.d.capabilities & (1 << 8), 0, 'no AUTH_TOKEN_REFRESH: Discord must not rotate a token we never store');
  assert.equal(id.d.capabilities & (1 << 11), 0, 'no PASSIVE_GUILD_UPDATE');
  assert.equal(id.d.capabilities & (1 << 14), 0, 'no PASSIVE_GUILD_UPDATE_V2: plain VOICE_STATE_UPDATE for every guild');
  assert.equal(id.d.properties.browser, 'Discord Client');
  g.close();
});

test('bot identify uses intents, no capabilities', async () => {
  const g = new Gateway({ token: 'B', bot: true, intents: 0, WS: FakeWS });
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  const id = ws.sent.find(p => p.op === 2);
  assert.equal(id.d.token, 'B');
  assert.equal(id.d.intents, 0);
  assert.equal(id.d.capabilities, undefined);
  g.close();
});

test('op 7 resumes on resume_gateway_url with seq', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  ws.server(READY);
  ws.server({ op: 7, d: null });
  await flush();
  assert.equal(ws.closedWith, 4000);
  const ws2 = FakeWS.all[1];
  assert.match(ws2.url, /^wss:\/\/r/);
  await hello(ws2);
  assert.deepEqual(ws2.sent.find(p => p.op === 6).d, { token: 'T', session_id: 'S', seq: 5 });
  assert.equal(ws2.sent.find(p => p.op === 2), undefined);
  g.close();
});

test('op 9 d=false re-identifies', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  ws.server(READY);
  ws.server({ op: 9, d: false });
  mock.timers.tick(5000);
  await flush();
  const ws2 = FakeWS.all[1];
  await hello(ws2);
  assert.ok(ws2.sent.find(p => p.op === 2));
  assert.equal(ws2.sent.find(p => p.op === 6), undefined);
  g.close();
});

test('repeated op 9 backs off instead of re-identifying every few seconds', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  g.connect();
  let ws = FakeWS.all[0];
  await hello(ws);
  for (let i = 0; i < 4; i++) {
    ws.server({ op: 9, d: false });
    mock.timers.tick(72000);
    await flush();
    ws = FakeWS.all.at(-1);
    await hello(ws);
  }
  const count = FakeWS.all.length;
  assert.equal(count, 5);
  ws.server({ op: 9, d: false });
  mock.timers.tick(6000); // plain 1–5 s would have reconnected by now
  await flush();
  assert.equal(FakeWS.all.length, count);
  g.close();
});

test('op 7 and op 9 emit reconnecting', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  const codes = [];
  g.on('reconnecting', c => codes.push(c));
  g.connect();
  let ws = FakeWS.all[0];
  await hello(ws);
  ws.server(READY);
  ws.server({ op: 7, d: null });
  await flush();
  ws = FakeWS.all.at(-1);
  await hello(ws);
  ws.server({ op: 9, d: true });
  assert.equal(codes.length, 2);
  g.close();
});

test('send reports whether the frame went out', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  assert.equal(g.send(1, null), false);
  g.connect();
  await flush();
  assert.equal(g.send(1, null), true);
  g.close();
});

test('close 4004 emits dead and never reconnects', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  const codes = [];
  g.on('dead', c => codes.push(c));
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  ws.drop(4004);
  mock.timers.tick(120000);
  await flush();
  assert.deepEqual(codes, [4004]);
  assert.equal(FakeWS.all.length, 1);
});

test('missing heartbeat ACK reconnects', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  mock.timers.tick(41250); // first beat (jittered within one interval)
  assert.ok(ws.sent.find(p => p.op === 1));
  mock.timers.tick(41250); // no ACK came back
  assert.equal(ws.closedWith, 4000);
  mock.timers.tick(1200);
  await flush();
  assert.equal(FakeWS.all.length, 2);
  g.close();
});

test('socket that never sends HELLO is replaced', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  g.connect();
  const ws = FakeWS.all[0];
  await flush(); // open, but no HELLO
  mock.timers.tick(30000);
  assert.equal(ws.closedWith, 4000);
  mock.timers.tick(1200);
  await flush();
  assert.equal(FakeWS.all.length, 2);
  g.close();
});

test('close() is permanent', async () => {
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  g.close();
  assert.equal(ws.closedWith, 1000);
  ws.drop(1006);
  mock.timers.tick(120000);
  await flush();
  assert.equal(FakeWS.all.length, 1);
});

test('close() during identify queue never identifies', async () => {
  const q = createLoginQueue(() => 10000);
  const g1 = new Gateway({ token: 'A', WS: FakeWS, queue: q });
  const g2 = new Gateway({ token: 'B', WS: FakeWS, queue: q });
  g1.connect();
  g2.connect();
  assert.equal(FakeWS.all.length, 1);
  g2.close();
  mock.timers.tick(10000);
  await flush();
  assert.equal(FakeWS.all.length, 1);
  g1.close();
});

test('empty LOGIN_GAP_MS (blank line in .env) falls back to 5000', () => {
  const prev = process.env.LOGIN_GAP_MS;
  process.env.LOGIN_GAP_MS = '';
  const q = createLoginQueue();
  assert.equal(q(), 0);
  assert.equal(q(), 5000);
  process.env.LOGIN_GAP_MS = '8000';
  assert.equal(q(), 10000);
  if (prev === undefined) delete process.env.LOGIN_GAP_MS;
  else process.env.LOGIN_GAP_MS = prev;
});

test('a throwing dispatch listener does not kill the gateway', async () => {
  const err = mock.method(console, 'error', () => {});
  const g = new Gateway({ token: 'T', WS: FakeWS, queue: noGap() });
  let n = 0;
  g.on('dispatch', () => { if (++n === 1) throw new Error('boom'); });
  g.connect();
  const ws = FakeWS.all[0];
  await hello(ws);
  ws.server({ op: 0, t: 'X', s: 1, d: {} });
  ws.server({ op: 0, t: 'X', s: 2, d: {} });
  assert.equal(n, 2);
  assert.equal(err.mock.callCount(), 1);
  err.mock.restore();
  g.close();
});
