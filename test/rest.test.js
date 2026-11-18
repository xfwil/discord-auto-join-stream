const test = require('node:test');
const assert = require('node:assert/strict');
const { request, SUPER } = require('../rest');

const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  };
  return calls;
}

test('retries on 429 then returns json', async () => {
  const calls = stubFetch([{ status: 429, body: { retry_after: 0.01 } }, { status: 200, body: { id: '1' } }]);
  assert.deepEqual(await request('T', 'GET', '/users/@me'), { id: '1' });
  assert.equal(calls.length, 2);
});

test('long 429 (Cloudflare ban) fails fast instead of hanging', async () => {
  const calls = stubFetch([{ status: 429, body: { retry_after: 3600 } }]);
  await assert.rejects(request('T', 'GET', '/users/@me'), e => e.status === 429);
  assert.equal(calls.length, 1);
});

test('throws DiscordError with status on 401', async () => {
  stubFetch([{ status: 401, body: { message: '401: Unauthorized', code: 0 } }]);
  await assert.rejects(request('T', 'GET', '/users/@me'), e => e.status === 401 && e.code === 0);
});

test('every request carries a timeout signal', async () => {
  const calls = stubFetch([{ status: 200, body: {} }]);
  await request('T', 'GET', '/x');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('204 returns null', async () => {
  stubFetch([{ status: 204 }]);
  assert.equal(await request('B', 'POST', '/interactions/1/x/callback', { type: 5 }, { bot: true }), null);
});

test('user headers carry super properties, bot headers use Bot prefix', async () => {
  const calls = stubFetch([{ status: 200, body: {} }, { status: 200, body: {} }]);
  await request('T', 'GET', '/x');
  await request('B', 'GET', '/x', undefined, { bot: true });
  assert.equal(calls[0].url, 'https://discord.com/api/v9/x');
  assert.equal(calls[0].init.headers.Authorization, 'T');
  assert.equal(calls[0].init.headers['X-Super-Properties'], SUPER);
  assert.equal(calls[1].init.headers.Authorization, 'Bot B');
  assert.equal(calls[1].init.headers['X-Super-Properties'], undefined);
});
