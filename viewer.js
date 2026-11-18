// One assigned account: sits in its voice channel (mute + deaf) and watches every Go Live there.
const EventEmitter = require('node:events');
const { Gateway } = require('./gateway');
const { streamKey, applyVoiceState, streamersIn } = require('./voice');

const REJOIN_DELAY_MS = 3000;
const JOIN_TIMEOUT_MS = 15000;
const JOIN_RETRY_MS = 300000;
const KICK_LIMIT = 3;
const KICK_WINDOW_MS = 300000;
const STREAM_RETRY_MS = 30000;
const STREAM_REJECT_NOTIFY = 3;
const WATCH_JITTER_MS = 3000; // accounts on one IP don't all send op 20 in the same millisecond

const toMap = list => new Map((list ?? []).map(vs => [vs.user_id, vs]));

class Viewer extends EventEmitter {
  constructor(account, { createGateway = opts => new Gateway(opts), watchJitterMs = WATCH_JITTER_MS } = {}) {
    super();
    this.label = account.label;
    this.username = account.username;
    this.watchJitterMs = watchJitterMs;
    this.token = account.token;
    this.guildId = account.guildId;
    this.channelId = account.channelId;
    this.createGateway = createGateway;
    this.state = 'connecting';
    this.stopped = false;
    this.selfId = null;
    this.voice = new Map(); // guildId -> Map(userId -> voice state), all guilds so a move needs no reconnect
    this.confirmed = false; // our own voice state is in the target channel
    this.online = false; // gateway session up (READY/RESUMED seen, no reconnect since)
    this.watching = new Set();
    this.cooldown = new Map(); // streamer -> earliest time to re-watch after STREAM_DELETE
    this.rejects = new Map(); // streamer -> rejections in a row
    this.pending = new Map(); // streamer -> jittered op 20 timer (one at a time)
    this.kicks = [];
    this.joinFailNotified = false;
    this.joinTimer = null;
    this.timers = new Set();
  }

  start() {
    this.gw = this.createGateway({ token: this.token });
    this.gw.on('dispatch', (t, d) => { if (!this.stopped) this.onDispatch(t, d); });
    this.gw.on('reconnecting', () => {
      if (this.stopped) return;
      this.online = false;
      this.state = 'connecting';
      this.cancel(this.joinTimer); // a join can't be confirmed while offline; RESUMED/READY re-joins
    });
    this.gw.on('dead', () => {
      if (this.stopped) return;
      this.halt();
      this.state = 'dead';
      this.emit('dead');
    });
    this.gw.connect();
  }

  move(guildId, channelId) {
    this.guildId = guildId;
    this.channelId = channelId;
    this.kicks = [];
    this.watching.clear();
    this.cooldown.clear();
    this.rejects.clear();
    this.joinFailNotified = false;
    if (this.selfId) this.join(); // before READY, READY itself joins the new channel
  }

  stop() {
    if (this.stopped) return;
    this.gw?.send(4, { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false });
    this.halt();
    this.state = 'stopped';
  }

  status() {
    return { state: this.state, watching: [...this.watching].sort() };
  }

  // ---------- internals ----------
  halt() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.gw?.close();
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  cancel(t) {
    clearTimeout(t);
    this.timers.delete(t);
  }

  notify(text) {
    this.emit('notify', text);
  }

  release(reason) {
    this.stop();
    this.emit('release', reason);
  }

  get map() {
    let m = this.voice.get(this.guildId);
    if (!m) this.voice.set(this.guildId, (m = new Map()));
    return m;
  }

  onDispatch(t, d) {
    switch (t) {
      case 'READY':
        this.online = true;
        this.selfId = d.user.id;
        this.voice = new Map((d.guilds ?? []).map(g => [g.id, toMap(g.voice_states)]));
        this.watching.clear();
        this.cooldown.clear();
        this.join();
        break;
      case 'READY_SUPPLEMENTAL':
        for (const g of d.guilds ?? []) {
          const m = this.voice.get(g.id) ?? new Map();
          for (const vs of g.voice_states ?? []) m.set(vs.user_id, vs);
          this.voice.set(g.id, m);
        }
        this.reconcile();
        break;
      case 'RESUMED':
        this.online = true;
        // an op 4 sent while the socket was down (rejoin, move) was dropped: send it again
        if (!this.confirmed) this.join();
        else {
          this.state = 'standby';
          this.reconcile();
        }
        break;
      case 'VOICE_STATE_UPDATE': {
        if (!d.guild_id) break;
        let m = this.voice.get(d.guild_id);
        if (!m) this.voice.set(d.guild_id, (m = new Map()));
        applyVoiceState(m, d);
        if (d.guild_id !== this.guildId) break;
        if (d.user_id === this.selfId) this.onSelf(d);
        this.reconcile();
        break;
      }
      case 'STREAM_CREATE': {
        const u = this.streamerOf(d.stream_key);
        if (u) this.rejects.delete(u);
        break;
      }
      case 'STREAM_DELETE':
        this.onStreamDelete(d);
        break;
      case 'GUILD_DELETE':
        if (d.id === this.guildId && !d.unavailable) this.release('akun keluar atau di-kick dari server');
        break;
      case 'CHANNEL_DELETE':
        if (d.id === this.channelId) this.release('channel dihapus');
        break;
      case 'CHANNEL_UPDATE': // keep the stored display names fresh
        if (d.id === this.channelId && d.name) this.emit('names', { channelName: d.name });
        break;
      case 'GUILD_UPDATE':
        if (d.id === this.guildId && d.name) this.emit('names', { guildName: d.name });
        break;
    }
  }

  join() {
    this.confirmed = false;
    this.cancel(this.joinTimer);
    if (!this.online) return; // offline: RESUMED/READY joins, and no false "gagal join" timer meanwhile
    this.state = 'joining';
    this.gw.send(4, { guild_id: this.guildId, channel_id: this.channelId, self_mute: true, self_deaf: true, self_video: false });
    this.joinTimer = this.later(() => this.onJoinTimeout(), JOIN_TIMEOUT_MS);
  }

  onJoinTimeout() {
    this.state = 'join_failed';
    // a failed move would otherwise leave the account sitting in its old channel
    for (const [guildId, m] of this.voice) {
      const self = m.get(this.selfId);
      if (self?.channel_id && self.channel_id !== this.channelId) {
        this.gw.send(4, { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: false });
      }
    }
    if (!this.joinFailNotified) {
      this.joinFailNotified = true;
      this.notify(`⚠️ ${this.who} gagal join <#${this.channelId}> (channel penuh atau tidak ada izin connect?). Dicoba lagi tiap 5 menit.`);
    }
    this.joinTimer = this.later(() => this.join(), JOIN_RETRY_MS);
  }

  get who() {
    return `\`${this.label}\` (@${this.username})`;
  }

  onSelf(d) {
    if (d.channel_id === this.channelId) {
      if (this.confirmed) return;
      this.confirmed = true;
      this.cancel(this.joinTimer);
      this.state = 'standby';
      if (this.joinFailNotified) {
        this.joinFailNotified = false;
        this.notify(`✅ ${this.who} berhasil join <#${this.channelId}>.`);
      }
      return;
    }
    if (!this.confirmed) return; // not in the target yet (joining / mid-move)

    // disconnected or moved away by someone else
    this.confirmed = false;
    this.watching.clear();
    const now = Date.now();
    this.kicks = this.kicks.filter(t => now - t < KICK_WINDOW_MS);
    this.kicks.push(now);
    if (this.kicks.length >= KICK_LIMIT) return this.release(`di-disconnect/dipindah ${KICK_LIMIT}× dalam 5 menit`);
    this.state = 'joining';
    this.later(() => this.join(), REJOIN_DELAY_MS);
  }

  reconcile() {
    if (!this.confirmed) return;
    const live = streamersIn(this.map, this.channelId, this.selfId);
    const now = Date.now();
    for (const u of live) {
      if (this.watching.has(u) || (this.cooldown.get(u) ?? 0) > now) continue;
      this.watching.add(u);
      // still wanted when the (jittered) send fires? a stop, move or kick in between clears `watching`
      // a send dropped by a down socket un-marks the streamer, so the next reconcile (RESUMED) retries it
      const send = () => {
        if (!this.confirmed || !this.watching.has(u)) return;
        if (!this.gw.send(20, { stream_key: streamKey(this.guildId, this.channelId, u) })) this.watching.delete(u);
      };
      if (!this.watchJitterMs) send();
      else {
        this.cancel(this.pending.get(u)); // stop + restart inside the window must not send twice
        this.pending.set(u, this.later(() => { this.pending.delete(u); send(); }, Math.random() * this.watchJitterMs));
      }
    }
    for (const u of this.watching) if (!live.includes(u)) this.watching.delete(u);
  }

  streamerOf(key) {
    const prefix = `guild:${this.guildId}:${this.channelId}:`;
    return key?.startsWith(prefix) ? key.slice(prefix.length) : null;
  }

  onStreamDelete(d) {
    const u = this.streamerOf(d.stream_key);
    if (!u) return;
    this.watching.delete(u);
    this.cooldown.set(u, Date.now() + STREAM_RETRY_MS);
    if (d.reason !== 'stream_ended') {
      const n = (this.rejects.get(u) ?? 0) + 1;
      this.rejects.set(u, n);
      if (n === STREAM_REJECT_NOTIFY) this.notify(`⚠️ ${this.who} ditolak nonton <@${u}> di <#${this.channelId}> (${d.reason ?? 'tanpa alasan'}). Tetap dicoba lagi.`);
    }
    // clear the cooldown in the timer: a timer may fire a hair before Date.now() reaches the deadline
    this.later(() => {
      this.cooldown.delete(u);
      this.reconcile();
    }, STREAM_RETRY_MS);
  }
}

module.exports = {
  Viewer, REJOIN_DELAY_MS, JOIN_TIMEOUT_MS, JOIN_RETRY_MS, KICK_LIMIT, KICK_WINDOW_MS, STREAM_RETRY_MS, STREAM_REJECT_NOTIFY, WATCH_JITTER_MS,
};
