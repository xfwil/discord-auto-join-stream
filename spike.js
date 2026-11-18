// Tes token asli: join voice (mute + deaf), nonton setiap Go Live di channel itu,
// dan log apakah Discord menghitung akun ini sebagai penonton.
// Usage (PowerShell): $env:TOKEN='<token>'; node spike.js <link/ID voice channel>
const { request } = require('./rest');
const { Gateway } = require('./gateway');
const { streamKey, parseChannelArg, guildVoiceStates, applyVoiceState, streamersIn } = require('./voice');

const TOKEN = process.env.TOKEN?.trim().replace(/^"|"$/g, '');
const channelId = parseChannelArg(process.argv[2]);
if (!TOKEN || !channelId) {
  console.error("Usage: $env:TOKEN='<token>'; node spike.js <link/ID voice channel>");
  process.exit(1);
}

const t0 = Date.now();
function log(msg) {
  const s = Math.floor((Date.now() - t0) / 1000);
  console.log(`[${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}] ${msg}`);
}

(async () => {
  const ch = await request(TOKEN, 'GET', `/channels/${channelId}`);
  if (ch.type !== 2) throw new Error(`#${ch.name} bukan voice channel (type ${ch.type})`);
  const guildId = ch.guild_id;
  log(`channel: #${ch.name} (server ${guildId})`);

  const names = new Map();
  const who = id => names.get(id) ?? id;
  let selfId, map = new Map(), inVoice = false, joinTimer;
  const watching = new Set();
  const gw = new Gateway({ token: TOKEN, queue: () => 0 });

  function join() {
    inVoice = false;
    gw.send(4, { guild_id: guildId, channel_id: channelId, self_mute: true, self_deaf: true, self_video: false });
    clearTimeout(joinTimer);
    joinTimer = setTimeout(() => { if (!inVoice) log('join voice: ✗ belum terkonfirmasi setelah 15 detik'); }, 15000);
  }

  function reconcile() {
    if (!inVoice) return;
    const live = streamersIn(map, channelId, selfId);
    for (const u of live) {
      if (watching.has(u)) continue;
      watching.add(u);
      gw.send(20, { stream_key: streamKey(guildId, channelId, u) });
      log(`nonton ${who(u)} → op 20 terkirim`);
    }
    for (const u of watching) {
      if (!live.includes(u)) {
        watching.delete(u);
        log(`${who(u)} berhenti live / keluar`);
      }
    }
  }

  const ours = key => key?.startsWith(`guild:${guildId}:${channelId}:`);

  gw.on('dispatch', (t, d) => {
    switch (t) {
      case 'READY': {
        selfId = d.user.id;
        log(`login @${d.user.username} (${selfId})`);
        const vs = guildVoiceStates(d, guildId);
        log(`voice states dari READY: ${vs ? vs.size : 'guild tidak ada di READY'}`);
        if (vs) map = vs;
        watching.clear();
        join();
        break;
      }
      case 'READY_SUPPLEMENTAL': {
        const vs = guildVoiceStates(d, guildId);
        log(`voice states dari READY_SUPPLEMENTAL: ${vs ? vs.size : 'guild tidak ada'}`);
        if (vs) for (const [k, v] of vs) map.set(k, v);
        reconcile();
        break;
      }
      case 'RESUMED':
        log('koneksi tersambung lagi (resume)');
        reconcile();
        break;
      case 'PASSIVE_UPDATE_V1':
        if (d.guild_id === guildId && d.voice_states) {
          log(`PASSIVE_UPDATE_V1: ${d.voice_states.length} voice states`);
          map = new Map(d.voice_states.map(v => [v.user_id, v]));
          reconcile();
        }
        break;
      case 'VOICE_STATE_UPDATE':
        if (d.guild_id !== guildId) break;
        if (d.member?.user?.username) names.set(d.user_id, '@' + d.member.user.username);
        applyVoiceState(map, d);
        if (d.user_id === selfId) {
          const now = d.channel_id === channelId;
          if (now && !inVoice) log('join voice: ✓ terkonfirmasi');
          if (!now && inVoice) log(`⚠ keluar/dipindah dari voice (channel sekarang: ${d.channel_id ?? 'tidak ada'})`);
          inVoice = now;
        }
        reconcile();
        break;
      case 'STREAM_CREATE':
      case 'STREAM_UPDATE':
        if (!ours(d.stream_key)) break;
        log(`${t} ${who(d.stream_key.split(':').pop())} viewer_ids=[${d.viewer_ids ?? ''}] → ${d.viewer_ids?.includes(selfId) ? '✓ kita terhitung penonton' : '✗ kita tidak ada di viewer_ids'}`);
        break;
      case 'STREAM_SERVER_UPDATE':
        if (ours(d.stream_key)) log('STREAM_SERVER_UPDATE diterima (server video tidak disambung)');
        break;
      case 'STREAM_DELETE':
        if (!ours(d.stream_key)) break;
        log(`STREAM_DELETE ${who(d.stream_key.split(':').pop())} reason=${d.reason} unavailable=${d.unavailable}`);
        watching.delete(d.stream_key.split(':').pop());
        break;
    }
  });
  gw.on('reconnecting', code => log(`koneksi putus (${code}), menyambung ulang...`));
  gw.on('dead', code => { log(`✗ token ditolak Discord (close ${code})`); process.exit(1); });
  gw.connect();

  setInterval(() => log(`di voice: ${inVoice ? 'ya' : 'tidak'} · nonton: ${watching.size}`), 60000);
  process.on('SIGINT', () => {
    gw.send(4, { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false });
    setTimeout(() => process.exit(0), 300);
  });
})().catch(e => {
  console.error('Gagal:', e.message);
  process.exit(1);
});
