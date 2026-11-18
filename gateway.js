// One Discord Gateway connection (user or bot token): identify, heartbeat, resume, reconnect.
const EventEmitter = require('node:events');
const { PROPS } = require('./rest');

const QUERY = '/?v=9&encoding=json';
const GATEWAY = 'wss://gateway.discord.gg' + QUERY;
const BACKOFF = [1000, 2000, 5000, 10000, 30000, 60000];
const HELLO_TIMEOUT_MS = 30000;
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]); // bad token / bad config: retrying never helps
const FRESH = new Set([4007, 4009]); // session can't be resumed, identify again

// Accounts on one IP must not identify in a burst. A slot is reserved before the socket opens,
// so a socket never sits unidentified while waiting its turn.
function createLoginQueue(gap = () => Number(process.env.LOGIN_GAP_MS) || 5000) { // blank/invalid -> 5000
  let next = 0;
  return () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gap();
    return at - now;
  };
}
const sharedQueue = createLoginQueue();

class Gateway extends EventEmitter {
  constructor({ token, bot = false, intents = 0, WS = globalThis.WebSocket, queue = sharedQueue }) {
    super();
    Object.assign(this, { token, bot, intents, WS, queue: bot ? null : queue });
    this.ws = null;
    this.seq = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.closed = false;
    this.fails = 0;
    this.hb = null;
    this.timers = new Set();
  }

  later(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
    return t;
  }

  async connect() {
    if (this.closed) return;
    if (!this.sessionId && this.queue) {
      const wait = this.queue();
      if (wait > 0) await new Promise(r => this.later(r, wait));
      if (this.closed) return;
    }
    const ws = this.ws = new this.WS(this.sessionId && this.resumeUrl ? this.resumeUrl + QUERY : GATEWAY);
    // no HELLO in time -> replace the socket (HELLO swaps this timer for the heartbeat)
    this.hb = setTimeout(() => {
      this.drop(4000);
      this.retry(4000);
    }, HELLO_TIMEOUT_MS);
    ws.addEventListener('message', e => this.onMessage(ws, e.data));
    ws.addEventListener('close', e => this.onClose(ws, e.code));
    ws.addEventListener('error', () => {}); // a close event always follows
  }

  // returns whether the frame went out; callers must not assume a send while reconnecting arrived
  send(op, d) {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  close() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.drop(1000);
  }

  // detach the current socket and close it; its close event is then ignored
  drop(code) {
    const ws = this.ws;
    this.ws = null;
    clearTimeout(this.hb);
    try { ws?.close(code); } catch {}
  }

  dropSession() {
    this.sessionId = this.resumeUrl = this.seq = null;
  }

  retry(code) {
    if (this.closed) return;
    const ms = BACKOFF[Math.min(this.fails++, BACKOFF.length - 1)] * (0.8 + Math.random() * 0.4);
    this.safeEmit('reconnecting', code);
    this.later(() => this.connect(), ms);
  }

  onClose(ws, code) {
    if (ws !== this.ws) return; // closed by us
    this.ws = null;
    clearTimeout(this.hb);
    if (this.closed) return;
    if (FATAL.has(code)) {
      this.close();
      return this.safeEmit('dead', code);
    }
    if (FRESH.has(code)) this.dropSession();
    this.retry(code);
  }

  onMessage(ws, raw) {
    if (ws !== this.ws) return;
    let p;
    try { p = JSON.parse(raw); } catch { return; }
    if (p.s != null) this.seq = p.s;
    switch (p.op) {
      case 10: // HELLO
        this.acked = true;
        this.heartbeat(p.d.heartbeat_interval, p.d.heartbeat_interval * Math.random());
        if (this.sessionId) this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
        else this.send(2, this.identifyPayload());
        break;
      case 11: this.acked = true; break;
      case 1: this.beat(); break;
      case 7: // server asks us to reconnect
        this.drop(4000);
        this.safeEmit('reconnecting', 4000);
        this.connect();
        break;
      case 9: { // invalid session; d = resumable. Backoff grows so a looping op 9 can't spam identify
        if (!p.d) this.dropSession();
        this.drop(4000);
        this.safeEmit('reconnecting', 4000);
        const backoff = BACKOFF[Math.min(this.fails++, BACKOFF.length - 1)] * (0.8 + Math.random() * 0.4);
        this.later(() => this.connect(), Math.max(1000 + Math.random() * 4000, backoff));
        break;
      }
      case 0:
        if (p.t === 'READY') {
          this.sessionId = p.d.session_id;
          this.resumeUrl = p.d.resume_gateway_url;
        }
        if (p.t === 'READY' || p.t === 'RESUMED') this.fails = 0;
        this.safeEmit('dispatch', p.t, p.d);
        break;
    }
  }

  heartbeat(interval, first) {
    clearTimeout(this.hb);
    this.hb = setTimeout(() => {
      if (!this.acked) { // zombie connection
        this.drop(4000);
        return this.retry(4000);
      }
      this.beat();
      this.heartbeat(interval, interval);
    }, first);
  }

  beat() {
    this.acked = false;
    this.send(1, this.seq);
  }

  identifyPayload() {
    if (this.bot) return { token: this.token, intents: this.intents, properties: { os: 'linux', browser: 'auto-stream', device: 'auto-stream' } };
    return {
      // 30717 minus AUTH_TOKEN_REFRESH (1<<8: Discord could rotate a token we never store)
      // and PASSIVE_GUILD_UPDATE_V2 (1<<14: large guilds would send diffs instead of VOICE_STATE_UPDATE)
      token: this.token, capabilities: 30717 & ~(1 << 8) & ~(1 << 14), properties: PROPS,
      presence: { status: 'online', since: 0, activities: [], afk: false },
      compress: false, client_state: { guild_versions: {} },
    };
  }

  safeEmit(event, ...args) {
    try {
      this.emit(event, ...args);
    } catch (e) {
      console.error(`[gateway] ${event} handler error: ${e?.stack || e}`);
    }
  }
}

module.exports = { Gateway, createLoginQueue };
