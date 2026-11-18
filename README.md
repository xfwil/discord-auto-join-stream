# Discord Auto Join Stream

Keep a pool of Discord alt accounts parked in voice channels and have them **automatically watch every Go Live stream** there. Everything is managed from a Discord bot with slash commands.

> [!WARNING]
> This tool logs in with **user account tokens** (self-bot). That violates Discord's Terms of Service, and accounts can be banned. Use alt accounts only, at your own risk.

## Features

- **Zero dependencies.** It uses only Node.js built-ins: `WebSocket`, `fetch` and `node:test`. There is nothing to `npm install`.
- **Account stock.** Add tokens under short labels, then assign each account to one voice channel.
- **Watches everything.** Each account joins muted and deafened, and watches every live stream in its channel, several at once. When a stream ends it stays in the channel and waits for the next one.
- **Owner-only control bot.** Slash commands, label autocomplete, page and confirm buttons. Replies are ephemeral, so tokens never show up in a channel.
- **Self-healing.**
  - Resumes after network drops.
  - Rejoins after being disconnected or moved.
  - Retries rejected streams.
  - Comes back after a restart.
- **Notifications** go to a log channel, or to you by DM, when something needs attention.
- **Safe by default.**
  - Only one instance can run at a time (`operator.lock`).
  - `data.json` is written atomically with `0600` permissions.
  - Tokens are never logged or echoed.

## How it works

```
  you (owner)                         Discord
  ───────────                         ───────
  /setup alt1 #voice-room ──► control bot ──► data.json
                                   │
                                   ▼
                        viewer: alt1 (user session)
                          ├─ op 4   join voice, self_mute + self_deaf
                          ├─ track  VOICE_STATE_UPDATE in that channel
                          └─ op 20  STREAM_WATCH for every user with self_stream = true
```

Viewers only send gateway signals. They never open an audio or video connection, so each account costs a single WebSocket. Discord still lists them in the stream's viewer list.

## Requirements

- **Node.js 22 or newer.** Developed on Node 25.
- **A bot application dedicated to this tool.** At startup it replaces *all* of that application's global slash commands.
- **Alt accounts already in the target servers.** The tool never joins servers by invite, because that triggers captchas and bans.

## Setup

1. **Clone the repo.**
   ```bash
   git clone https://github.com/xfwil/discord-auto-join-stream.git
   cd discord-auto-join-stream
   ```
2. **Create the control bot.** In the [Developer Portal](https://discord.com/developers/applications), go to **New Application**, then **Bot**, then **Reset Token**. No privileged intents are needed.
3. **Invite the bot** to your control server. Under **OAuth2 → URL Generator**, pick the scopes `bot` and `applications.commands`, and the permissions `View Channels` and `Send Messages`.
4. **Configure.**
   ```bash
   cp .env.example .env
   ```

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✅ | Token of the control bot |
| `OWNER_IDS` | ✅ | Comma-separated Discord user IDs allowed to use the bot |
| `LOG_CHANNEL_ID` | — | Channel for notifications. If empty, notifications go by DM to the first owner |
| `LOGIN_GAP_MS` | — | Delay between account logins, so many accounts on one IP don't log in together. Default `5000` |

To copy your user ID, turn on Developer Mode (**Settings → Advanced**), then right-click your profile and choose **Copy User ID**.

## Running

```bash
node index.js
```

To run it in production with [pm2](https://pm2.keymetrics.io/):

```bash
pm2 start index.js --name auto-stream
pm2 save
chmod 600 .env        # data.json is created with 0600 automatically
```

Ctrl+C makes every account leave voice before the process exits. So do `pm2 stop` and `pm2 restart` on Linux. On Windows, pm2 kills the process outright, so the accounts stay in voice until Discord times out their sessions.

## Usage

| Command | What it does |
|---|---|
| `/manage list` | All accounts with their status and assigned channel |
| `/manage add token label` | Check a token, then add it to the stock |
| `/manage delete label` | Remove an account, after a confirm button |
| `/setup label channel` | Assign an account to a voice channel. Accepts an ID, a link or `#channel` |
| `/desetup label` | Take an account off duty and return it to the stock |
| `/status` | Each channel's accounts and the streams being watched, with a refresh button |

A typical flow:

1. `/manage add token:<token> label:alt1`
2. `/setup label:alt1 channel:https://discord.com/channels/<server>/<channel>`
3. Go live in that channel. `alt1` starts watching within a few seconds.
4. `/status`

```
My Server › #voice-room — 3 akun · 🟢 3 standby · 👁 nonton: @you

💤 nganggur: 5 · 💀 mati: 0
```

In servers, commands are visible to admins only. They always work in a DM with the bot. Bot replies are in Indonesian.

## What happens when…

| Situation | Behaviour |
|---|---|
| The streamer stops or leaves | Stops watching and stays in the channel. Watches again when they go live |
| You were already live before the account joined | Starts watching as soon as its join is confirmed |
| A moderator disconnects or moves the account | Rejoins after 3 s. If that happens 3× within 5 min, the account is released and you are notified |
| The channel is full, or the account can't connect | Retries every 5 min. You are notified once |
| Discord refuses to show a stream to the account | Retries every 30 s. You are notified after 3 refusals in a row |
| The channel is deleted, or the account is kicked from the server | The account is released and you are notified |
| The token dies (password changed, account locked) | Marked dead and never retried. You are notified |
| The network drops, or Discord restarts the connection | Resumes, rejoins voice if needed and re-watches active streams |
| The process restarts | Every assigned account logs back in, one at a time, to its channel |
| Rate limits | Waits and retries. A long Cloudflare ban fails fast instead of hanging |

## Project layout

| File | Purpose |
|---|---|
| `index.js` | Entry point: config, single-instance lock, wiring, graceful shutdown |
| `control.js` | Control bot: slash commands, buttons, autocomplete, notifications |
| `viewer.js` | One assigned account: joins voice, watches streams, recovers from everything above |
| `gateway.js` | Gateway client: identify, heartbeat, resume, backoff, shared login queue |
| `rest.js` | REST client with rate-limit and timeout handling |
| `voice.js` | Pure voice-state helpers |
| `store.js` | `data.json` persistence, with atomic `0600` writes |
| `spike.js` | Single-token diagnostic: join, watch, and log what Discord reports |
| `test/` | `node:test` suites; fakes only, no network |

## Testing

```bash
node --test
```

The tests never touch the network or your `.env`.

`spike.js` checks a single token by hand:

```bash
TOKEN='<token>' node spike.js https://discord.com/channels/<server>/<channel>
# PowerShell
$env:TOKEN='<token>'; node spike.js https://discord.com/channels/<server>/<channel>
```

> [!IMPORTANT]
> **One account, one session in voice.** Never run `spike.js`, a second operator, or the Discord app joining voice with an account the operator is using. Discord moves the voice session to the newest client, and the operator's watch gets refused (`unauthorized`).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ditolak nonton … (unauthorized)` | Another client holds that account's voice session: a second operator, `spike.js`, or the app. Stop it, and the operator recovers by itself |
| Commands don't show up | Press `Ctrl+R` in Discord. In servers, only admins see them; DMs always work |
| `Operator lain sudah jalan…` on start | Another instance is running from this folder. Stop it. A lock left by a crashed process is taken over automatically |
| An account stays at `⚠️ gagal join` | It lacks the Connect permission, or the channel is full. It retries every 5 minutes |
| `data.json rusak: …` on start | The file is invalid. Fix it by hand. It is never wiped automatically |
| Command replies say `Gagal: 429 …` | Discord or Cloudflare is rate limiting this IP. Wait, or raise `LOGIN_GAP_MS` |

## Limitations

- One account can be in only one voice channel at a time, which is a Discord rule.
- Accounts must already be members of the server.
- The gateway protocol for user accounts is undocumented, so Discord can change it at any time.
