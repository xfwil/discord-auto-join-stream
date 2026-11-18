const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperator, acquireLock } = require('../index');

const lockFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-')), 'operator.lock');
const DEAD_PID = 999999999;

test('acquireLock takes a free lock and writes our pid', () => {
  const file = lockFile();
  assert.equal(acquireLock(file, 4242), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '4242');
});

test('acquireLock refuses while another live process holds it', () => {
  const file = lockFile();
  fs.writeFileSync(file, String(process.pid)); // this test process is alive
  assert.equal(acquireLock(file, DEAD_PID), false);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
});

test('acquireLock takes over a stale lock left by a dead process', () => {
  const file = lockFile();
  fs.writeFileSync(file, String(DEAD_PID));
  assert.equal(acquireLock(file, process.pid), true);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
});

class FakeViewer extends EventEmitter {
  constructor(acc) { super(); this.acc = acc; this.started = 0; this.stopped = 0; this.moves = []; }
  start() { this.started++; }
  stop() { this.stopped++; }
  move(g, c) { this.moves.push([g, c]); }
  status() { return { state: 'standby', watching: ['u1'] }; }
}

const acc = (label, extra = {}) => ({ label, token: 't-' + label, userId: 'id-' + label, username: 'user-' + label, guildId: null, channelId: null, dead: false, ...extra });

function setup(accounts) {
  const data = { accounts };
  const notes = [], made = [];
  let saves = 0;
  const op = createOperator({
    data, persist: () => saves++, notify: t => notes.push(t), log: () => {},
    createViewer: a => { const v = new FakeViewer(a); made.push(v); return v; },
  });
  return { op, data, notes, made, saves: () => saves };
}

test('startAssigned starts only assigned, living accounts', () => {
  const { op, made } = setup([acc('a1', { guildId: 'G', channelId: 'C' }), acc('a2'), acc('a3', { channelId: 'C', dead: true })]);
  assert.equal(op.startAssigned(), 1);
  assert.deepEqual(made.map(v => [v.acc.label, v.started]), [['a1', 1]]);
  assert.deepEqual(op.ctx.statusOf('a1'), { state: 'standby', watching: ['u1'] });
  assert.equal(op.ctx.statusOf('a2'), null);
});

test('release clears the assignment, saves, and notifies with the old channel', () => {
  const { op, data, notes, made, saves } = setup([acc('a1', { guildId: 'G', channelId: 'C', guildName: 'S', channelName: 'v' })]);
  op.startAssigned();
  made[0].emit('release', 'channel dihapus');
  assert.equal(data.accounts[0].channelId, null);
  assert.equal(data.accounts[0].guildId, null);
  assert.equal(data.accounts[0].channelName, null);
  assert.equal(data.accounts[0].guildName, null);
  assert.equal(saves(), 1);
  assert.match(notes[0], /`a1`.*@user-a1.*S › #v.*channel dihapus/);
  assert.equal(op.ctx.statusOf('a1'), null);
});

test('dead marks the account dead, keeps its channel, saves, notifies', () => {
  const { op, data, notes, made, saves } = setup([acc('a1', { guildId: 'G', channelId: 'C' })]);
  op.startAssigned();
  made[0].emit('dead');
  assert.equal(data.accounts[0].dead, true);
  assert.equal(data.accounts[0].channelId, 'C');
  assert.equal(saves(), 1);
  assert.match(notes[0], /mati/);
  assert.equal(op.ctx.statusOf('a1'), null);
});

test('renamed channel or server is stored', () => {
  const { op, data, made, saves } = setup([acc('a1', { guildId: 'G', channelId: 'C', guildName: 'S', channelName: 'v' })]);
  op.startAssigned();
  made[0].emit('names', { channelName: 'new-room' });
  assert.equal(data.accounts[0].channelName, 'new-room');
  assert.equal(data.accounts[0].guildName, 'S');
  assert.equal(saves(), 1);
});

test('viewer notify is forwarded', () => {
  const { op, notes, made } = setup([acc('a1', { guildId: 'G', channelId: 'C' })]);
  op.startAssigned();
  made[0].emit('notify', 'hai');
  assert.deepEqual(notes, ['hai']);
});

test('assign moves an existing viewer instead of starting a second one', () => {
  const { op, data, made } = setup([acc('a1', { guildId: 'G', channelId: 'C' })]);
  op.startAssigned();
  Object.assign(data.accounts[0], { guildId: 'G2', channelId: 'C2' });
  op.ctx.assign(data.accounts[0]);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].moves, [['G2', 'C2']]);
});

test('assign starts a viewer for an idle account; unassign stops it', () => {
  const { op, data, made } = setup([acc('a1')]);
  Object.assign(data.accounts[0], { guildId: 'G', channelId: 'C' });
  op.ctx.assign(data.accounts[0]);
  assert.equal(made[0].started, 1);
  op.ctx.unassign(data.accounts[0]);
  assert.equal(made[0].stopped, 1);
  assert.equal(op.ctx.statusOf('a1'), null);
});

test('a late event from a replaced viewer does not evict the new one', () => {
  const { op, data, made } = setup([acc('a1', { guildId: 'G', channelId: 'C' })]);
  op.startAssigned();
  op.ctx.unassign(data.accounts[0]);
  op.ctx.assign(data.accounts[0]);
  made[0].emit('dead'); // old viewer
  assert.notEqual(op.ctx.statusOf('a1'), null);
});

test('stopAll stops every viewer (leave voice on shutdown)', () => {
  const { op, made } = setup([acc('a1', { guildId: 'G', channelId: 'C' }), acc('a2', { guildId: 'G', channelId: 'C' })]);
  op.startAssigned();
  op.stopAll();
  assert.deepEqual(made.map(v => v.stopped), [1, 1]);
  assert.equal(op.ctx.statusOf('a1'), null);
});
