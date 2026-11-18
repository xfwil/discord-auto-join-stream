// Control bot: slash commands to manage the account stock and assignments. Owner-only, ephemeral replies.
const rest = require('./rest');
const { Gateway } = require('./gateway');
const { parseChannelArg } = require('./voice');
const { checkAccount, addAccount, findAccount, removeAccount } = require('./store');

const SUB = 1, STR = 3;
const LABEL = { type: STR, name: 'label', description: 'Label akun', required: true, autocomplete: true };
const COMMANDS = [
  {
    name: 'manage', description: 'Kelola stok akun', options: [
      { type: SUB, name: 'list', description: 'Daftar akun dan channel tugasnya' },
      {
        type: SUB, name: 'add', description: 'Tambah token ke stok', options: [
          { type: STR, name: 'token', description: 'Token akun', required: true },
          { type: STR, name: 'label', description: 'Nama pendek akun ini (1–32 karakter)', required: true, max_length: 32 },
        ],
      },
      { type: SUB, name: 'delete', description: 'Hapus akun dari stok', options: [LABEL] },
    ],
  },
  { name: 'setup', description: 'Tugaskan akun ke voice channel', options: [LABEL, { type: STR, name: 'channel', description: 'ID, link, atau #channel voice', required: true }] },
  { name: 'desetup', description: 'Lepas akun dari voice channel', options: [LABEL] },
  { name: 'status', description: 'Status semua akun yang bertugas' },
].map(c => ({ ...c, default_member_permissions: '0' })); // hidden from non-admins in servers (DMs unaffected)

const PAGE = 15;
const COLOR = 0x5865f2;
const msg = content => ({ content });
const button = (custom_id, label, style = 2, disabled = false) => ({ type: 2, custom_id, label, style, disabled });
const row = (...components) => ({ type: 1, components });

// "Server › #channel" when known (readable even if the owner isn't in that server), else a channel mention
const escape = s => s.replace(/[\\*_~`|>]/g, '\\$&'); // names are user text, not markdown

function place(a) {
  if (a.channelName) return a.guildName ? `${escape(a.guildName)} › #${escape(a.channelName)}` : `#${escape(a.channelName)}`;
  return `<#${a.channelId}>`;
}

function isOwner(i, ownerIds) {
  const id = i.member?.user?.id ?? i.user?.id;
  return !!id && ownerIds.includes(id);
}

// flatten slash command options: { cmd, sub, args, focused }
function parse(i) {
  let options = i.data?.options ?? [];
  let sub = null;
  if (options[0]?.type === SUB) {
    sub = options[0].name;
    options = options[0].options ?? [];
  }
  const args = Object.fromEntries(options.map(o => [o.name, o.value]));
  return { cmd: i.data?.name, sub, args, focused: options.find(o => o.focused) };
}

function stateText(a, ctx) {
  if (a.dead) return '💀 mati';
  if (!a.channelId) return '💤 nganggur';
  const s = ctx.statusOf(a.label);
  if (!s) return '🔄 menyambung';
  if (s.state === 'standby') return s.watching.length ? `👁 nonton ${s.watching.length}` : '🟢 standby';
  return { connecting: '🔄 menyambung', joining: '⏳ join…', join_failed: '⚠️ gagal join', dead: '💀 mati', stopped: '💤 nganggur' }[s.state] ?? s.state;
}

function listPayload(ctx, page = 0) {
  const all = ctx.data.accounts;
  if (!all.length) return msg('Stok masih kosong. Tambah dengan `/manage add`.');
  const pages = Math.ceil(all.length / PAGE);
  page = Math.min(Math.max(0, page), pages - 1);
  const lines = all.slice(page * PAGE, (page + 1) * PAGE)
    .map(a => `\`${a.label}\` · @${a.username} · ${stateText(a, ctx)}${a.channelId ? ` · ${place(a)}` : ''}`);
  return {
    embeds: [{ title: `Akun (${all.length})`, description: lines.join('\n'), color: COLOR, footer: { text: `Hal ${page + 1}/${pages}` } }],
    components: pages > 1 ? [row(button(`list:${page - 1}`, '◀', 2, page === 0), button(`list:${page + 1}`, '▶', 2, page === pages - 1))] : [],
  };
}

function statusPayload(ctx) {
  const all = ctx.data.accounts;
  const byChannel = new Map();
  for (const a of all) {
    if (!a.channelId || a.dead) continue;
    if (!byChannel.has(a.channelId)) byChannel.set(a.channelId, []);
    byChannel.get(a.channelId).push(a);
  }
  const lines = [];
  for (const accounts of byChannel.values()) {
    let standby = 0, connecting = 0;
    const failed = [], watched = new Set();
    for (const a of accounts) {
      const s = ctx.statusOf(a.label);
      if (s?.state === 'standby') standby++;
      else if (s?.state === 'join_failed') failed.push(`\`${a.label}\``);
      else connecting++;
      for (const u of s?.watching ?? []) watched.add(u);
    }
    const parts = [`${place(accounts.find(a => a.channelName) ?? accounts[0])} — ${accounts.length} akun`];
    if (standby) parts.push(`🟢 ${standby} standby`);
    if (connecting) parts.push(`🔄 ${connecting} menyambung`);
    if (failed.length) parts.push(`⚠️ gagal join: ${failed.join(', ')}`);
    if (watched.size) parts.push(`👁 nonton: ${[...watched].map(u => `<@${u}>`).join(', ')}`);
    lines.push(parts.join(' · '));
  }
  const idle = all.filter(a => !a.channelId && !a.dead).length;
  const dead = all.filter(a => a.dead).length;
  const body = (lines.length ? lines.join('\n') : 'Belum ada akun bertugas.') + `\n\n💤 nganggur: ${idle} · 💀 mati: ${dead}`;
  return {
    embeds: [{ title: 'Status', description: body.slice(0, 4000), color: COLOR }],
    components: [row(button('status', '🔄 Refresh'))],
  };
}

async function addCommand(args, ctx) {
  const label = String(args.label ?? '').trim();
  if (label.length < 1 || label.length > 32) return msg('❌ Label harus 1–32 karakter.');
  const token = String(args.token ?? '').trim().replace(/^"|"$/g, '');
  const dup = checkAccount(ctx.data, { label, token });
  if (dup) return msg('❌ ' + dup);
  let me;
  try {
    me = await ctx.validateToken(token);
  } catch (e) {
    if (e.status === 401) return msg('❌ Token tidak valid (401).');
    throw e;
  }
  const err = addAccount(ctx.data, { label, token, userId: me.id, username: me.username });
  if (err) return msg('❌ ' + err);
  ctx.save();
  return msg(`✓ \`${label}\` terdaftar sebagai @${me.username}. Tugaskan dengan \`/setup\`.`);
}

async function setupCommand(args, ctx) {
  const a = findAccount(ctx.data, String(args.label ?? ''));
  if (!a) return msg(`❌ Akun \`${args.label}\` tidak ada.`);
  if (a.dead) return msg(`❌ Token \`${a.label}\` mati. Hapus lalu tambah ulang dengan token baru.`);
  const id = parseChannelArg(args.channel);
  if (!id) return msg('❌ Channel tidak dikenali. Isi ID channel, link voice channel, atau #channel.');
  if (id === a.channelId) return msg(`ℹ️ \`${a.label}\` sudah bertugas di ${place(a)}.`);
  let ch;
  try {
    ch = await ctx.resolveChannel(a.token, id);
  } catch (e) {
    if (e.status === 401) {
      a.dead = true;
      ctx.save();
      return msg(`❌ Token \`${a.label}\` mati (401). Hapus lalu tambah ulang dengan token baru.`);
    }
    if (e.status === 403 || e.status === 404) return msg(`❌ \`${a.label}\` tidak bisa melihat channel itu (bukan member server, atau channel tidak ada).`);
    throw e;
  }
  if (ch.type !== 2) return msg('❌ Itu bukan voice channel.');
  const guildName = await ctx.guildName(a.token, ch.guild_id).catch(() => null); // display only
  // the account may have been deleted (del:yes) or died while we awaited the lookups
  if (!ctx.data.accounts.includes(a) || a.dead) return msg(`❌ Akun \`${a.label}\` berubah (dihapus atau mati) saat diproses. Coba lagi.`);
  const prev = a.channelId ? place(a) : null;
  Object.assign(a, { guildId: ch.guild_id, channelId: ch.id, guildName, channelName: ch.name ?? null });
  ctx.save();
  ctx.assign(a);
  return msg(`✓ \`${a.label}\` ditugaskan ke ${place(a)}${prev ? ` (pindah dari ${prev})` : ''}, sedang join… Cek \`/status\`.`);
}

function desetupCommand(args, ctx) {
  const a = findAccount(ctx.data, String(args.label ?? ''));
  if (!a) return msg(`❌ Akun \`${args.label}\` tidak ada.`);
  if (!a.channelId) return msg(`ℹ️ \`${a.label}\` tidak sedang bertugas.`);
  const prev = place(a);
  ctx.unassign(a);
  a.guildId = a.channelId = a.guildName = a.channelName = null;
  ctx.save();
  return msg(`✓ \`${a.label}\` keluar dari ${prev}, kembali ke stok.`);
}

function deleteCommand(args, ctx) {
  const a = findAccount(ctx.data, String(args.label ?? ''));
  if (!a) return msg(`❌ Akun \`${args.label}\` tidak ada.`);
  return {
    content: `Hapus \`${a.label}\` (@${a.username}) dari stok?${a.channelId ? ` Akun ini sedang bertugas di ${place(a)} dan akan keluar dari voice.` : ''}`,
    // userId in the id: a stale button must not delete a different account that re-used the label
    components: [row(button(`del:yes:${a.label}:${a.userId}`, 'Ya, hapus', 4), button('del:no', 'Batal'))],
  };
}

async function runCommand(i, ctx) {
  const { cmd, sub, args } = parse(i);
  if (cmd === 'manage' && sub === 'list') return listPayload(ctx);
  if (cmd === 'manage' && sub === 'add') return addCommand(args, ctx);
  if (cmd === 'manage' && sub === 'delete') return deleteCommand(args, ctx);
  if (cmd === 'setup') return setupCommand(args, ctx);
  if (cmd === 'desetup') return desetupCommand(args, ctx);
  if (cmd === 'status') return statusPayload(ctx);
  return msg('❌ Perintah tidak dikenal.');
}

async function runComponent(i, ctx) {
  const id = i.data?.custom_id ?? '';
  if (id === 'status') return statusPayload(ctx);
  if (id.startsWith('list:')) return listPayload(ctx, Number(id.slice(5)) || 0);
  if (id === 'del:no') return { content: 'Batal.', components: [] };
  if (id.startsWith('del:yes:')) {
    const tail = id.slice(8);
    const cut = tail.lastIndexOf(':'); // labels may contain ':', user ids never do
    const a = findAccount(ctx.data, tail.slice(0, cut));
    if (!a || a.userId !== tail.slice(cut + 1)) return { content: 'ℹ️ Akun sudah tidak ada.', components: [] };
    if (a.channelId) ctx.unassign(a);
    removeAccount(ctx.data, a.label);
    ctx.save();
    return { content: `🗑️ \`${a.label}\` dihapus.`, components: [] };
  }
  return { content: '❌ Tombol tidak dikenal.', components: [] };
}

function runAutocomplete(i, ctx) {
  const { cmd, focused } = parse(i);
  const q = String(focused?.value ?? '').toLowerCase();
  const pool = ctx.data.accounts.filter(a =>
    cmd === 'setup' ? !a.dead : cmd === 'desetup' ? !!a.channelId : true);
  return pool
    .filter(a => a.label.toLowerCase().includes(q) || a.username.toLowerCase().includes(q))
    .slice(0, 25)
    .map(a => ({ name: `${a.label} · @${a.username} · ${stateText(a, ctx)}`.slice(0, 100), value: a.label }));
}

class Control {
  constructor({ token, ownerIds, logChannelId, ctx, request = rest.request, createGateway = opts => new Gateway(opts) }) {
    Object.assign(this, { token, ownerIds, logChannelId, ctx, request, createGateway });
    this.appId = null;
    this.registered = false;
    this.dmId = null;
  }

  start() {
    this.gw = this.createGateway({ token: this.token, bot: true, intents: 0 });
    this.gw.on('dispatch', (t, d) => {
      if (t === 'READY') this.onReady(d);
      if (t === 'INTERACTION_CREATE') this.onInteraction(d);
    });
    this.gw.on('reconnecting', code => console.error(`[control] koneksi bot putus (${code}), menyambung ulang...`));
    this.gw.on('dead', code => console.error(`[control] BOT_TOKEN ditolak Discord (close ${code}). Cek .env lalu restart.`));
    this.gw.connect();
  }

  api(method, path, body) {
    return this.request(this.token, method, path, body, { bot: true });
  }

  callback(i, type, data) {
    return this.api('POST', `/interactions/${i.id}/${i.token}/callback`, { type, data });
  }

  async onReady(d) {
    this.appId = d.application.id;
    console.log(`[control] bot @${d.user.username} siap`);
    await this.register();
  }

  // bulk overwrite: this bot is dedicated to the tool, so any other global command is removed.
  // A failure retries every minute (a resumed session may not see another READY for days).
  async register() {
    if (this.registered || this.registering) return;
    this.registering = true;
    try {
      await this.api('PUT', `/applications/${this.appId}/commands`, COMMANDS);
      this.registered = true;
    } catch (e) {
      console.error(`[control] gagal daftar command, coba lagi 1 menit: ${e.message}`);
      setTimeout(() => this.register(), 60000).unref?.();
    } finally {
      this.registering = false;
    }
  }

  async onInteraction(i) {
    try {
      if (!isOwner(i, this.ownerIds)) {
        if (i.type === 4) return await this.callback(i, 8, { choices: [] });
        return await this.callback(i, 4, { content: '⛔ Kamu tidak punya akses ke bot ini.', flags: 64 });
      }
      if (i.type === 2) {
        await this.callback(i, 5, { flags: 64 });
        let payload;
        try {
          payload = await runCommand(i, this.ctx);
        } catch (e) {
          console.error(`[control] /${i.data?.name} error: ${e.message}`);
          payload = msg(`❌ Gagal: ${e.message}`);
        }
        await this.api('PATCH', `/webhooks/${i.application_id ?? this.appId}/${i.token}/messages/@original`, payload);
      } else if (i.type === 3) {
        let payload;
        try {
          payload = await runComponent(i, this.ctx);
        } catch (e) {
          console.error(`[control] tombol error: ${e.message}`);
          payload = { content: `❌ Gagal: ${e.message}`, components: [] };
        }
        await this.callback(i, 7, payload);
      } else if (i.type === 4) {
        await this.callback(i, 8, { choices: runAutocomplete(i, this.ctx) });
      }
    } catch (e) {
      console.error(`[control] interaction error: ${e.message}`);
    }
  }

  async notify(text) {
    try {
      let channel = this.logChannelId;
      if (!channel) {
        this.dmId ??= (await this.api('POST', '/users/@me/channels', { recipient_id: this.ownerIds[0] })).id;
        channel = this.dmId;
      }
      await this.api('POST', `/channels/${channel}/messages`, { content: '🔔 ' + text, allowed_mentions: { parse: [] } });
    } catch (e) {
      console.error(`[control] notify gagal: ${e.message}`);
    }
  }
}

module.exports = { COMMANDS, place, isOwner, runCommand, runComponent, runAutocomplete, Control };
