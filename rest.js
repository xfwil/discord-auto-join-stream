// Discord REST for user and bot tokens. Node 18+ (built-in fetch).
const API = 'https://discord.com/api/v9';

// Client identity copied from Discord-Auto-Quests/quests.js
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9200 Chrome/134.0.6998.205 Electron/35.3.0 Safari/537.36';
// ponytail: hardcoded build number, bump it if Discord starts rejecting requests
const PROPS = {
  os: 'Windows', browser: 'Discord Client', release_channel: 'stable', client_version: '1.0.9200',
  os_version: '10.0.26200', os_arch: 'x64', system_locale: 'en-US', client_build_number: 470000,
};
const SUPER = Buffer.from(JSON.stringify(PROPS)).toString('base64');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class DiscordError extends Error {
  constructor(status, data, text) {
    super(data?.message ? `${status} ${data.message}` : `${status} ${String(text).slice(0, 80).replace(/\s+/g, ' ')}`);
    this.status = status;
    this.code = data?.code;
  }
}

async function request(token, method, path, body, { bot = false } = {}) {
  const headers = bot
    ? { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (auto-stream, 1.0)' }
    : { Authorization: token, 'User-Agent': UA, 'X-Super-Properties': SUPER };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  for (let limited = 0, failed = 0; ;) {
    let res, text;
    try {
      res = await fetch(API + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000), // a stalled connection becomes a retryable error, not a hang
      });
      text = await res.text();
    } catch (e) {
      if (++failed > 3) throw e;
      await sleep(1000 * 2 ** (failed - 1));
      continue;
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {} // Cloudflare answers with HTML, not JSON

    const retryAfter = Number(data?.retry_after ?? res.headers.get('retry-after')) || 5;
    // a long wait (Cloudflare ban) fails fast instead of hanging a command past its 15-min interaction token
    if (res.status === 429 && retryAfter <= 60 && ++limited <= 5) {
      await sleep(retryAfter * 1000);
      continue;
    }
    if (res.status >= 500 && ++failed <= 3) {
      await sleep(1000 * 2 ** (failed - 1));
      continue;
    }
    if (!res.ok) throw new DiscordError(res.status, data, text);
    return data;
  }
}

module.exports = { API, UA, PROPS, SUPER, DiscordError, request };
