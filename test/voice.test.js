const test = require('node:test');
const assert = require('node:assert/strict');
const { streamKey, parseChannelArg, guildVoiceStates, applyVoiceState, streamersIn } = require('../voice');

const C = '222222222222222222';

test('parseChannelArg accepts link, message link, mention, raw id', () => {
  assert.equal(parseChannelArg(`https://discord.com/channels/111111111111111111/${C}`), C);
  assert.equal(parseChannelArg(`https://ptb.discord.com/channels/111111111111111111/${C}/333333333333333333`), C);
  assert.equal(parseChannelArg(`<#${C}>`), C);
  assert.equal(parseChannelArg(` ${C} `), C);
  assert.equal(parseChannelArg('voice-room'), null);
  assert.equal(parseChannelArg('12345'), null);
});

test('streamersIn returns streamers in channel except self', () => {
  const m = new Map();
  applyVoiceState(m, { user_id: 'u1', channel_id: 'C', self_stream: true });
  applyVoiceState(m, { user_id: 'u2', channel_id: 'C2', self_stream: true });
  applyVoiceState(m, { user_id: 'u3', channel_id: 'C', self_stream: false });
  applyVoiceState(m, { user_id: 'self', channel_id: 'C', self_stream: true });
  assert.deepEqual(streamersIn(m, 'C', 'self'), ['u1']);
});

test('applyVoiceState deletes on null channel', () => {
  const m = new Map();
  applyVoiceState(m, { user_id: 'u1', channel_id: 'C' });
  applyVoiceState(m, { user_id: 'u1', channel_id: null });
  assert.equal(m.size, 0);
});

test('guildVoiceStates reads READY guilds or returns null', () => {
  const ready = { guilds: [{ id: 'G', voice_states: [{ user_id: 'u1', channel_id: 'C', self_stream: true }] }] };
  assert.equal(guildVoiceStates(ready, 'G').get('u1').channel_id, 'C');
  assert.equal(guildVoiceStates(ready, 'X'), null);
  assert.equal(guildVoiceStates({}, 'G'), null);
  assert.equal(guildVoiceStates({ guilds: [{ id: 'G' }] }, 'G').size, 0);
});

test('streamKey format', () => {
  assert.equal(streamKey('G', 'C', 'U'), 'guild:G:C:U');
});
