// Account stock + assignments in data.json.
const fs = require('node:fs');

function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { accounts: [] };
    throw e;
  }
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data?.accounts)) throw new Error('field "accounts" tidak ada');
    data.accounts.forEach((a, i) => {
      const missing = ['label', 'token', 'userId', 'username'].filter(k => typeof a?.[k] !== 'string');
      if (missing.length) throw new Error(`akun ke-${i + 1} tidak punya ${missing.join('/')}`);
    });
    return data;
  } catch (e) {
    // never fall back to an empty stock here: the next save would wipe every token
    throw new Error(`data.json rusak: ${e.message}`);
  }
}

// write-then-rename so a crash mid-write never leaves a half-written data.json;
// mode 0600 because rename replaces the file, so a manual chmod would be lost on every save
function save(file, data) {
  fs.rmSync(file + '.tmp', { force: true }); // mode applies only on create: a leftover tmp would keep its old mode
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const findAccount = (data, label) => data.accounts.find(a => same(a.label, label));

// duplicate check without adding, so callers can reject before validating the token over the network
function checkAccount(data, { label, token }) {
  if (findAccount(data, label)) return `Label \`${label}\` sudah dipakai.`;
  const other = data.accounts.find(a => a.token === token);
  if (other) return `Token ini sudah terdaftar sebagai \`${other.label}\`.`;
  return null;
}

function addAccount(data, { label, token, userId, username }) {
  const err = checkAccount(data, { label, token });
  if (err) return err;
  data.accounts.push({ label, token, userId, username, guildId: null, channelId: null, dead: false });
  return null;
}

function removeAccount(data, label) {
  const i = data.accounts.findIndex(a => same(a.label, label));
  if (i < 0) return false;
  data.accounts.splice(i, 1);
  return true;
}

module.exports = { load, save, checkAccount, addAccount, findAccount, removeAccount };
