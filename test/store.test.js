const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, save, addAccount, findAccount, removeAccount } = require('../store');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')), 'data.json');
const acc = (label, token = 'tok-' + label) => ({ label, token, userId: 'id-' + label, username: 'user-' + label });

test('load returns empty stock when file is missing', () => {
  assert.deepEqual(load(tmp()), { accounts: [] });
});

test('save then load round-trips and leaves no .tmp file', () => {
  const file = tmp();
  const data = { accounts: [] };
  addAccount(data, acc('a1'));
  save(file, data);
  assert.deepEqual(load(file), data);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.deepEqual(data.accounts[0], { label: 'a1', token: 'tok-a1', userId: 'id-a1', username: 'user-a1', guildId: null, channelId: null, dead: false });
});

test('save creates the file owner-only (0600) so tokens stay private on the VPS', () => {
  const file = tmp();
  const spy = test.mock.method(fs, 'writeFileSync');
  save(file, { accounts: [] });
  assert.equal(spy.mock.calls[0].arguments[2]?.mode, 0o600);
  spy.mock.restore();
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('load throws on invalid JSON and keeps file', () => {
  const file = tmp();
  fs.writeFileSync(file, 'not json');
  assert.throws(() => load(file), /data.json rusak/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
});

test('load rejects an account entry without label or token', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ accounts: [acc('ok'), { label: 'x' }] }));
  assert.throws(() => load(file), /data.json rusak: akun ke-2/);
});

test('load rejects an account entry without userId or username', () => {
  const file = tmp();
  const { userId, ...noId } = acc('a');
  fs.writeFileSync(file, JSON.stringify({ accounts: [noId] }));
  assert.throws(() => load(file), /data.json rusak: akun ke-1/);
  assert.ok(userId);
});

test('save replaces a leftover .tmp so the 0600 mode still applies', { skip: process.platform === 'win32' && 'POSIX file modes' }, () => {
  const file = tmp();
  fs.writeFileSync(file + '.tmp', 'old', { mode: 0o644 });
  save(file, { accounts: [] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('save removes a leftover .tmp before writing', () => {
  const file = tmp();
  fs.writeFileSync(file + '.tmp', 'old');
  const rm = test.mock.method(fs, 'rmSync');
  save(file, { accounts: [] });
  assert.equal(rm.mock.calls[0]?.arguments[0], file + '.tmp');
  rm.mock.restore();
});

test('addAccount rejects duplicate label case-insensitively', () => {
  const data = { accounts: [] };
  assert.equal(addAccount(data, acc('Alt1')), null);
  assert.equal(addAccount(data, acc('alt1', 'other')), 'Label `alt1` sudah dipakai.');
  assert.equal(data.accounts.length, 1);
});

test('addAccount rejects duplicate token naming the existing label', () => {
  const data = { accounts: [] };
  addAccount(data, acc('a1', 'SAME'));
  assert.equal(addAccount(data, acc('a2', 'SAME')), 'Token ini sudah terdaftar sebagai `a1`.');
});

test('findAccount is case-insensitive, removeAccount removes', () => {
  const data = { accounts: [] };
  addAccount(data, acc('Alt1'));
  assert.equal(findAccount(data, 'ALT1').label, 'Alt1');
  assert.equal(removeAccount(data, 'alt1'), true);
  assert.equal(removeAccount(data, 'alt1'), false);
  assert.equal(findAccount(data, 'alt1'), undefined);
});
