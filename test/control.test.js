const test = require('node:test');
const assert = require('node:assert/strict');
const { isOwner, runCommand, runComponent, runAutocomplete, Control, COMMANDS, place } = require('../control');

const acc = (label, extra = {}) => ({ label, token: 'tok-' + label, userId: 'id-' + label, username: 'user-' + label, guildId: null, channelId: null, dead: false, ...extra });

function makeCtx(accounts = [], { channels = {}, statuses = {}, resolveError } = {}) {
  const calls = { save: 0, assign: [], unassign: [], validate: [], resolve: [] };
  const ctx = {
    data: { accounts },
    save: () => calls.save++,
    validateToken: async t => {
      calls.validate.push(t);
      if (t === 'BAD') throw Object.assign(new Error('401: Unauthorized'), { status: 401 });
      return { id: '42', username: 'alice' };
    },
    resolveChannel: async (t, id) => {
      calls.resolve.push([t, id]);
      if (resolveError) throw Object.assign(new Error('err'), { status: resolveError });
      return channels[id] ?? { id, guild_id: 'G', type: 2, name: 'voice-room' };
    },
    guildName: async () => 'Server A',
    assign: a => calls.assign.push(a.label),
    unassign: a => calls.unassign.push(a.label),
    statusOf: label => statuses[label] ?? null,
  };
  return { ctx, calls };
}

const cmd = (name, args = {}, sub) => {
  const options = Object.entries(args).map(([n, value]) => ({ type: 3, name: n, value }));
  return { type: 2, data: { name, options: sub ? [{ type: 1, name: sub, options }] : options }, user: { id: 'owner' } };
};
const comp = custom_id => ({ type: 3, data: { custom_id }, user: { id: 'owner' } });
const auto = (name, value, sub) => {
  const options = [{ type: 3, name: 'label', value, focused: true }];
  return { type: 4, data: { name, options: sub ? [{ type: 1, name: sub, options }] : options }, user: { id: 'owner' } };
};
const ids = p => JSON.stringify(p.components ?? []).match(/"custom_id":"[^"]+"/g) ?? [];
const CH = '222222222222222222';
const LINK = `https://discord.com/channels/111111111111111111/${CH}`;

test('commands are defined for manage, setup, desetup, status', () => {
  assert.deepEqual(COMMANDS.map(c => c.name), ['manage', 'setup', 'desetup', 'status']);
});

test('commands are hidden from non-admin members of servers the bot is in', () => {
  assert.ok(COMMANDS.every(c => c.default_member_permissions === '0'));
});

test('place escapes markdown in server and channel names', () => {
  assert.equal(place({ guildName: 'A*B_C', channelName: 'x~y`z', channelId: '1' }), 'A\\*B\\_C › #x\\~y\\`z');
  assert.equal(place({ channelId: '1' }), '<#1>');
});

test('isOwner reads guild member and DM user', () => {
  assert.equal(isOwner({ member: { user: { id: '1' } } }, ['1']), true);
  assert.equal(isOwner({ user: { id: '1' } }, ['1']), true);
  assert.equal(isOwner({ user: { id: '2' } }, ['1']), false);
  assert.equal(isOwner({}, ['1']), false);
});

test('add rejects bad label length without calling validateToken', async () => {
  const { ctx, calls } = makeCtx();
  for (const label of ['   ', 'x'.repeat(33)]) {
    const p = await runCommand(cmd('manage', { token: 'NEW', label }, 'add'), ctx);
    assert.match(p.content, /Label harus 1–32 karakter/);
  }
  assert.equal(calls.validate.length, 0);
});

test('add rejects duplicate label before validating token', async () => {
  const { ctx, calls } = makeCtx([acc('a1')]);
  const p = await runCommand(cmd('manage', { token: 'NEW', label: 'A1' }, 'add'), ctx);
  assert.match(p.content, /sudah dipakai/);
  assert.equal(calls.validate.length, 0);
});

test('add rejects duplicate token before validating it', async () => {
  const { ctx, calls } = makeCtx([acc('a1', { token: 'SAME' })]);
  const p = await runCommand(cmd('manage', { token: 'SAME', label: 'a2' }, 'add'), ctx);
  assert.match(p.content, /sudah terdaftar sebagai `a1`/);
  assert.equal(calls.validate.length, 0);
});

test('add reports invalid token', async () => {
  const { ctx } = makeCtx();
  const p = await runCommand(cmd('manage', { token: 'BAD', label: 'a1' }, 'add'), ctx);
  assert.match(p.content, /Token tidak valid/);
  assert.equal(ctx.data.accounts.length, 0);
});

test('add saves account and never echoes the token', async () => {
  const { ctx, calls } = makeCtx();
  const p = await runCommand(cmd('manage', { token: '"SECRET123"', label: 'a2' }, 'add'), ctx);
  assert.match(p.content, /@alice/);
  assert.equal(JSON.stringify(p).includes('SECRET123'), false);
  assert.equal(calls.validate[0], 'SECRET123');
  assert.equal(calls.save, 1);
  assert.deepEqual(ctx.data.accounts[0], { label: 'a2', token: 'SECRET123', userId: '42', username: 'alice', guildId: null, channelId: null, dead: false });
});

test('setup rejects unknown account', async () => {
  const { ctx } = makeCtx();
  const p = await runCommand(cmd('setup', { label: 'nope', channel: LINK }), ctx);
  assert.match(p.content, /tidak ada/);
});

test('setup rejects unrecognized channel input', async () => {
  const { ctx, calls } = makeCtx([acc('a1')]);
  const p = await runCommand(cmd('setup', { label: 'a1', channel: 'voice-room' }), ctx);
  assert.match(p.content, /Channel tidak dikenali/);
  assert.equal(calls.resolve.length, 0);
});

test('setup rejects non-voice channel and keeps account idle', async () => {
  const { ctx, calls } = makeCtx([acc('a1')], { channels: { [CH]: { id: CH, guild_id: 'G', type: 0 } } });
  const p = await runCommand(cmd('setup', { label: 'a1', channel: LINK }), ctx);
  assert.match(p.content, /bukan voice channel/);
  assert.equal(ctx.data.accounts[0].channelId, null);
  assert.equal(calls.assign.length, 0);
  assert.equal(calls.save, 0);
});

test('setup rejects channel the account cannot see', async () => {
  for (const status of [403, 404]) {
    const { ctx, calls } = makeCtx([acc('a1')], { resolveError: status });
    const p = await runCommand(cmd('setup', { label: 'a1', channel: CH }), ctx);
    assert.match(p.content, /bukan member/);
    assert.equal(ctx.data.accounts[0].channelId, null);
    assert.equal(calls.assign.length, 0);
  }
});

test('setup marks account dead on 401', async () => {
  const { ctx, calls } = makeCtx([acc('a1')], { resolveError: 401 });
  const p = await runCommand(cmd('setup', { label: 'a1', channel: CH }), ctx);
  assert.match(p.content, /mati/);
  assert.equal(ctx.data.accounts[0].dead, true);
  assert.equal(calls.save, 1);
  assert.equal(calls.assign.length, 0);
});

test('setup rejects dead account', async () => {
  const { ctx, calls } = makeCtx([acc('a1', { dead: true })]);
  const p = await runCommand(cmd('setup', { label: 'a1', channel: CH }), ctx);
  assert.match(p.content, /mati/);
  assert.equal(calls.resolve.length, 0);
});

test('setup assigns, saves, and mentions previous channel on move', async () => {
  const { ctx, calls } = makeCtx([acc('a1')], { channels: { [CH]: { id: CH, guild_id: '111111111111111111', type: 2 } } });
  const p1 = await runCommand(cmd('setup', { label: 'a1', channel: LINK }), ctx);
  assert.deepEqual(calls.resolve[0], ['tok-a1', CH]);
  assert.equal(ctx.data.accounts[0].guildId, '111111111111111111');
  assert.equal(ctx.data.accounts[0].channelId, CH);
  assert.deepEqual(calls.assign, ['a1']);
  assert.equal(calls.save, 1);
  assert.match(p1.content, new RegExp(`<#${CH}>`));
  assert.match(p1.content, /sedang join/); // not "joined" before Discord confirms it

  const same = await runCommand(cmd('setup', { label: 'a1', channel: `<#${CH}>` }), ctx);
  assert.match(same.content, /sudah bertugas/);
  assert.equal(calls.assign.length, 1);

  const p2 = await runCommand(cmd('setup', { label: 'a1', channel: '333333333333333333' }), ctx);
  assert.match(p2.content, /Server A › #voice-room/);
  assert.match(p2.content, new RegExp(`pindah dari <#${CH}>`));
  assert.equal(calls.assign.length, 2);
});

test('setup does not assign an account deleted or killed while resolving the channel', async () => {
  for (const change of [(ctx) => { ctx.data.accounts.length = 0; }, (ctx) => { ctx.data.accounts[0].dead = true; }]) {
    const { ctx, calls } = makeCtx([acc('a1')]);
    ctx.resolveChannel = async (t, id) => { change(ctx); return { id, guild_id: 'G', type: 2 }; };
    const p = await runCommand(cmd('setup', { label: 'a1', channel: CH }), ctx);
    assert.equal(calls.assign.length, 0);
    assert.equal(calls.save, 0);
    assert.match(p.content, /berubah/);
  }
});

test('setup stores server and channel names; list and status show them', async () => {
  const { ctx } = makeCtx([acc('a1')], { statuses: { a1: { state: 'standby', watching: [] } } });
  const p = await runCommand(cmd('setup', { label: 'a1', channel: CH }), ctx);
  assert.equal(ctx.data.accounts[0].guildName, 'Server A');
  assert.equal(ctx.data.accounts[0].channelName, 'voice-room');
  assert.match(p.content, /Server A › #voice-room/);
  const list = await runCommand(cmd('manage', {}, 'list'), ctx);
  assert.match(list.embeds[0].description, /Server A › #voice-room/);
  const status = await runCommand(cmd('status'), ctx);
  assert.match(status.embeds[0].description, /Server A › #voice-room — 1 akun/);
});

test('setup still assigns when the server name cannot be fetched', async () => {
  const { ctx, calls } = makeCtx([acc('a1')]);
  ctx.guildName = async () => { throw new Error('403'); };
  const p = await runCommand(cmd('setup', { label: 'a1', channel: CH }), ctx);
  assert.deepEqual(calls.assign, ['a1']);
  assert.equal(ctx.data.accounts[0].guildName, null);
  assert.match(p.content, new RegExp(`#voice-room|<#${CH}>`));
});

test('desetup clears assignment and calls unassign', async () => {
  const { ctx, calls } = makeCtx([acc('a1', { guildId: 'G', channelId: 'C', guildName: 'S', channelName: 'v' }), acc('a2')]);
  const idle = await runCommand(cmd('desetup', { label: 'a2' }), ctx);
  assert.match(idle.content, /tidak sedang bertugas/);
  const p = await runCommand(cmd('desetup', { label: 'a1' }), ctx);
  assert.match(p.content, /S › #v/);
  assert.deepEqual(calls.unassign, ['a1']);
  assert.equal(ctx.data.accounts[0].channelId, null);
  assert.equal(ctx.data.accounts[0].guildId, null);
  assert.equal(ctx.data.accounts[0].channelName, null);
  assert.equal(ctx.data.accounts[0].guildName, null);
  assert.equal(calls.save, 1);
});

test('delete asks confirmation; del:yes unassigns and removes', async () => {
  const { ctx, calls } = makeCtx([acc('a1', { guildId: 'G', channelId: 'C' })]);
  const ask = await runCommand(cmd('manage', { label: 'a1' }, 'delete'), ctx);
  assert.deepEqual(ids(ask), ['"custom_id":"del:yes:a1:id-a1"', '"custom_id":"del:no"']);
  assert.equal(ctx.data.accounts.length, 1);

  const no = await runComponent(comp('del:no'), ctx);
  assert.match(no.content, /Batal/);
  assert.deepEqual(no.components, []);

  const yes = await runComponent(comp('del:yes:a1:id-a1'), ctx);
  assert.match(yes.content, /dihapus/);
  assert.deepEqual(yes.components, []);
  assert.deepEqual(calls.unassign, ['a1']);
  assert.equal(ctx.data.accounts.length, 0);
  assert.equal(calls.save, 1);
});

test('stale delete button does not delete a re-added account with the same label', async () => {
  const { ctx, calls } = makeCtx([acc('a:1', { userId: 'other' })]); // label re-used by another account
  const p = await runComponent(comp('del:yes:a:1:id-a1'), ctx);
  assert.match(p.content, /sudah tidak ada/);
  assert.equal(ctx.data.accounts.length, 1);
  assert.equal(calls.save, 0);
  const ok = await runComponent(comp('del:yes:a:1:other'), ctx); // label containing ':' still parses
  assert.match(ok.content, /dihapus/);
  assert.equal(ctx.data.accounts.length, 0);
});

test('list shows empty stock hint', async () => {
  const { ctx } = makeCtx();
  const p = await runCommand(cmd('manage', {}, 'list'), ctx);
  assert.match(p.content, /Stok masih kosong/);
});

test('list paginates 15 per page', async () => {
  const accounts = Array.from({ length: 20 }, (_, i) => acc('a' + i));
  accounts[0].channelId = 'C';
  accounts[1].dead = true;
  const { ctx } = makeCtx(accounts, { statuses: { a0: { state: 'standby', watching: ['u1'] } } });
  const p1 = await runCommand(cmd('manage', {}, 'list'), ctx);
  const lines1 = p1.embeds[0].description.split('\n');
  assert.equal(lines1.length, 15);
  assert.match(lines1[0], /`a0` · @user-a0 · 👁 nonton 1 · <#C>/);
  assert.match(lines1[1], /💀 mati/);
  assert.match(lines1[2], /💤 nganggur/);
  const buttons1 = p1.components[0].components;
  assert.equal(buttons1[0].disabled, true);
  assert.equal(buttons1[1].custom_id, 'list:1');
  assert.equal(buttons1[1].disabled, false);

  const p2 = await runComponent(comp('list:1'), ctx);
  assert.equal(p2.embeds[0].description.split('\n').length, 5);
  assert.equal(p2.components[0].components[1].disabled, true);
});

test('status groups by channel and dedupes watched streamers', async () => {
  const { ctx } = makeCtx(
    [acc('a1', { guildId: 'G', channelId: 'C' }), acc('a2', { guildId: 'G', channelId: 'C' }), acc('a3'), acc('a4', { dead: true, channelId: 'C' })],
    { statuses: { a1: { state: 'standby', watching: ['u1'] }, a2: { state: 'standby', watching: ['u1', 'u2'] } } },
  );
  const p = await runCommand(cmd('status'), ctx);
  const d = p.embeds[0].description;
  assert.equal(d.match(/<#C>/g).length, 1);
  assert.equal(d.match(/<@u1>/g).length, 1);
  assert.equal(d.match(/<@u2>/g).length, 1);
  assert.match(d, /2 akun/);
  assert.match(d, /nganggur: 1/);
  assert.match(d, /mati: 1/);
  assert.deepEqual(ids(p), ['"custom_id":"status"']);
  const again = await runComponent(comp('status'), ctx);
  assert.equal(again.embeds[0].description, d);
});

test('autocomplete for desetup lists only assigned accounts', () => {
  const { ctx } = makeCtx([acc('a1', { channelId: 'C' }), acc('a2'), acc('b3', { dead: true })]);
  assert.deepEqual(runAutocomplete(auto('desetup', ''), ctx).map(c => c.value), ['a1']);
  assert.deepEqual(runAutocomplete(auto('setup', ''), ctx).map(c => c.value), ['a1', 'a2']);
  assert.deepEqual(runAutocomplete(auto('manage', 'B', 'delete'), ctx).map(c => c.value), ['b3']);
  assert.ok(runAutocomplete(auto('setup', ''), ctx).every(c => c.name.length <= 100));
});

// ---------- wiring ----------
function control(extra = {}) {
  const calls = [];
  const c = new Control({
    token: 'B', ownerIds: ['owner'], ctx: makeCtx([acc('a1')]).ctx,
    request: async (...a) => { calls.push(a); return a[2] === '/users/@me/channels' ? { id: 'DM' } : null; },
    ...extra,
  });
  c.appId = 'APP';
  return { c, calls };
}

test('READY replaces every command of the application with ours (bulk overwrite)', async () => {
  const log = test.mock.method(console, 'log', () => {});
  const { c, calls } = control();
  await c.onReady({ application: { id: 'APP' }, user: { username: 'bot' } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1, 4), ['PUT', '/applications/APP/commands', COMMANDS]);
  log.mock.restore();
});

test('failed command registration is retried on the next READY', async () => {
  const log = test.mock.method(console, 'log', () => {});
  const err = test.mock.method(console, 'error', () => {});
  let puts = 0;
  const { c } = control({ request: async (t, m) => { if (m === 'PUT' && ++puts === 1) throw new Error('down'); return null; } });
  const ready = { application: { id: 'APP' }, user: { username: 'bot' } };
  await c.onReady(ready);
  await c.onReady(ready);
  await c.onReady(ready);
  assert.equal(puts, 2);
  log.mock.restore();
  err.mock.restore();
});

test('failed registration also retries on a timer (a resumed bot may see no READY for days)', async () => {
  test.mock.timers.enable({ apis: ['setTimeout'] });
  const log = test.mock.method(console, 'log', () => {});
  const err = test.mock.method(console, 'error', () => {});
  let puts = 0;
  const { c } = control({ request: async (t, m) => { if (m === 'PUT' && ++puts === 1) throw new Error('down'); return null; } });
  await c.onReady({ application: { id: 'APP' }, user: { username: 'bot' } });
  assert.equal(puts, 1);
  test.mock.timers.tick(60000);
  await new Promise(r => setImmediate(r));
  assert.equal(puts, 2);
  test.mock.timers.tick(600000);
  await new Promise(r => setImmediate(r));
  assert.equal(puts, 2); // stops once registered
  test.mock.timers.reset();
  log.mock.restore();
  err.mock.restore();
});

test('setup to the channel it already has names it', async () => {
  const { ctx } = makeCtx([acc('a1', { guildId: 'G', channelId: CH, guildName: 'S', channelName: 'v' })]);
  const p = await runCommand(cmd('setup', { label: 'a1', channel: CH }), ctx);
  assert.match(p.content, /sudah bertugas di S › #v/);
});

test('non-owner is denied for commands, buttons and autocomplete', async () => {
  const { c, calls } = control();
  await c.onInteraction({ id: '1', token: 'it', type: 2, data: { name: 'status' }, user: { id: 'x' } });
  await c.onInteraction({ id: '2', token: 'it', type: 3, data: { custom_id: 'del:yes:a1' }, member: { user: { id: 'x' } } });
  await c.onInteraction({ id: '3', token: 'it', type: 4, data: { name: 'setup', options: [] }, user: { id: 'x' } });
  assert.deepEqual(calls.map(a => [a[1], a[2], a[3].type]), [
    ['POST', '/interactions/1/it/callback', 4],
    ['POST', '/interactions/2/it/callback', 4],
    ['POST', '/interactions/3/it/callback', 8],
  ]);
  assert.equal(calls[0][3].data.flags, 64);
  assert.match(calls[0][3].data.content, /tidak punya akses/);
  assert.deepEqual(calls[2][3].data.choices, []);
  assert.ok(calls.every(a => a[4]?.bot === true));
});

test('owner command is deferred ephemeral then edited', async () => {
  const { c, calls } = control();
  await c.onInteraction({ id: '1', token: 'it', application_id: 'APP2', type: 2, data: { name: 'status' }, user: { id: 'owner' } });
  assert.deepEqual([calls[0][2], calls[0][3]], ['/interactions/1/it/callback', { type: 5, data: { flags: 64 } }]);
  assert.equal(calls[1][1], 'PATCH');
  assert.equal(calls[1][2], '/webhooks/APP2/it/messages/@original');
  assert.ok(calls[1][3].embeds || calls[1][3].content);
});

test('command error is reported in the reply', async () => {
  const err = test.mock.method(console, 'error', () => {});
  const { c, calls } = control({ ctx: { ...makeCtx([acc('a1')]).ctx, resolveChannel: async () => { throw new Error('boom'); } } });
  await c.onInteraction({ id: '1', token: 'it', ...cmd('setup', { label: 'a1', channel: CH }) });
  assert.match(calls[1][3].content, /Gagal: boom/);
  err.mock.restore();
});

test('notify posts to log channel without pings, falls back to owner DM, never throws', async () => {
  const a = control({ logChannelId: 'L' });
  await a.c.notify('hai');
  assert.deepEqual([a.calls[0][2], a.calls[0][3]], ['/channels/L/messages', { content: '🔔 hai', allowed_mentions: { parse: [] } }]);

  const b = control();
  await b.c.notify('hai');
  assert.deepEqual(b.calls.map(x => x[2]), ['/users/@me/channels', '/channels/DM/messages']);
  assert.deepEqual(b.calls[0][3], { recipient_id: 'owner' });

  const err = test.mock.method(console, 'error', () => {});
  const broken = control({ request: async () => { throw new Error('down'); } });
  await broken.c.notify('hai');
  assert.equal(err.mock.callCount(), 1);
  err.mock.restore();
});
