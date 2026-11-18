// Pure helpers for voice channel state.
const streamKey = (guildId, channelId, userId) => `guild:${guildId}:${channelId}:${userId}`;

// Accepts a channel link (incl. ptb/canary and message links), a <#mention> or a raw snowflake.
function parseChannelArg(str) {
  const s = String(str ?? '').trim();
  const m = s.match(/discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d{17,20})/) || s.match(/^<#(\d{17,20})>$/) || s.match(/^(\d{17,20})$/);
  return m ? m[1] : null;
}

// Voice states of one guild from a READY / READY_SUPPLEMENTAL payload; null when the guild isn't in it.
function guildVoiceStates(payload, guildId) {
  const g = payload?.guilds?.find(x => x.id === guildId);
  if (!g) return null;
  return new Map((g.voice_states ?? []).map(vs => [vs.user_id, vs]));
}

function applyVoiceState(map, vs) {
  if (vs.channel_id) map.set(vs.user_id, vs);
  else map.delete(vs.user_id);
}

function streamersIn(map, channelId, selfId) {
  return [...map.values()]
    .filter(vs => vs.channel_id === channelId && vs.self_stream === true && vs.user_id !== selfId)
    .map(vs => vs.user_id)
    .sort();
}

module.exports = { streamKey, parseChannelArg, guildVoiceStates, applyVoiceState, streamersIn };
