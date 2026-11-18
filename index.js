// Discord Auto Join Stream — operator. Run: node index.js  (VPS: pm2 start index.js --name auto-stream)
const fs = require('node:fs');
const path = require('node:path');
const { request } = require('./rest');
const { Viewer } = require('./viewer');
const { Control, place } = require('./control');
const { load, save } = require('./store');

const stamp = (label, text) => console.log(`${new Date().toLocaleTimeString('en-GB')} [${label}] ${text}`);

// Wires viewers to the stored accounts. No env, no network, no process hooks: safe to require from tests.
function createOperator({ data, persist, notify, log = stamp, createViewer = acc => new Viewer(acc) }) {
  const viewers = new Map(); // label -> Viewer

  function tell(label, text) {
    log(label, text);
    notify(text);
  }

  function startViewer(acc) {
    const v = createViewer(acc);
    viewers.set(acc.label, v);
    const forget = () => { if (viewers.get(acc.label) === v) viewers.delete(acc.label); };
    v.on('notify', text => tell(acc.label, text));
    v.on('names', names => {
      Object.assign(acc, names);
      persist();
    });
    v.on('release', reason => {
      const from = place(acc);
      forget();
      acc.guildId = acc.channelId = acc.guildName = acc.channelName = null;
      persist();
      tell(acc.label, `🔻 \`${acc.label}\` (@${acc.username}) dilepas dari ${from}: ${reason}`);
    });
    v.on('dead', () => {
      forget();
      acc.dead = true;
      persist();
      tell(acc.label, `💀 Token \`${acc.label}\` (@${acc.username}) mati: password diganti, akun dikunci, atau di-disable. Hapus dengan \`/manage delete\`.`);
    });
    v.start();
    log(acc.label, `bertugas di channel ${acc.channelId}`);
  }

  const ctx = {
    data,
    save: persist,
    validateToken: token => request(token, 'GET', '/users/@me'),
    resolveChannel: (token, channelId) => request(token, 'GET', `/channels/${channelId}`),
    guildName: (token, guildId) => request(token, 'GET', `/guilds/${guildId}`).then(g => g?.name ?? null),
    assign(acc) {
      const v = viewers.get(acc.label);
      if (!v) return startViewer(acc);
      v.move(acc.guildId, acc.channelId);
      log(acc.label, `pindah ke channel ${acc.channelId}`);
    },
    unassign(acc) {
      viewers.get(acc.label)?.stop();
      viewers.delete(acc.label);
      log(acc.label, 'dilepas dari tugas');
    },
    statusOf: label => viewers.get(label)?.status() ?? null,
  };

  return {
    ctx,
    startAssigned() {
      const list = data.accounts.filter(a => a.channelId && !a.dead);
      list.forEach(startViewer); // the gateway login queue spaces them out
      return list.length;
    },
    stopAll() {
      for (const v of viewers.values()) v.stop(); // each sends a voice leave first
      viewers.clear();
    },
  };
}

const alive = pid => {
  try {
    process.kill(pid, 0); // signal 0 = existence check, also on Windows
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

// One operator per folder: a second process with the same tokens hijacks the voice sessions
// and both would overwrite data.json. A lock held by a dead pid (crash, SIGKILL) is taken over.
function acquireLock(file, pid = process.pid) {
  try {
    const holder = Number(fs.readFileSync(file, 'utf8'));
    if (holder && holder !== pid && alive(holder)) return false;
  } catch {} // no lock file yet
  fs.writeFileSync(file, String(pid));
  return true;
}

function main() {
  try { process.loadEnvFile(path.join(__dirname, '.env')); } catch {} // no .env -> plain environment variables

  const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
  const OWNER_IDS = (process.env.OWNER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!BOT_TOKEN || !OWNER_IDS.length) {
    console.error('Config kurang: isi BOT_TOKEN dan OWNER_IDS di .env (contoh ada di .env.example).');
    process.exit(1);
  }

  const LOCK = path.join(__dirname, 'operator.lock');
  if (!acquireLock(LOCK)) {
    console.error(`Operator lain sudah jalan di folder ini (pid ${fs.readFileSync(LOCK, 'utf8')}). Matikan dulu, jangan jalankan dua proses dengan token yang sama.`);
    process.exit(1);
  }
  process.on('exit', () => {
    try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch {}
  });

  const DATA = path.join(__dirname, 'data.json');
  let data;
  try {
    data = load(DATA);
  } catch (e) {
    console.error(`${e.message}\nPerbaiki ${DATA} (atau pindahkan kalau mau mulai dari stok kosong), lalu jalankan lagi.`);
    process.exit(1);
  }

  let control;
  const op = createOperator({ data, persist: () => save(DATA, data), notify: text => control.notify(text) });
  control = new Control({ token: BOT_TOKEN, ownerIds: OWNER_IDS, logChannelId: process.env.LOG_CHANNEL_ID?.trim() || null, ctx: op.ctx });

  process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.stack || e));
  process.on('uncaughtException', e => {
    console.error('[uncaughtException]', e?.stack || e);
    process.exit(1); // pm2 restarts; assignments come back from data.json
  });
  // Ctrl+C / pm2 stop|restart: leave voice first so no ghost stays in the channel (pm2 waits 1.6 s before SIGKILL)
  const shutdown = signal => {
    stamp('boot', `${signal}: semua akun keluar dari voice...`);
    op.stopAll();
    setTimeout(() => process.exit(0), 500);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const n = op.startAssigned();
  stamp('boot', `${data.accounts.length} akun di stok, ${n} bertugas`);
  control.start();
}

if (require.main === module) main();

module.exports = { createOperator, acquireLock };
