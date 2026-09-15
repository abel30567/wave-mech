import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
let initialized = false;
let turns = 0;
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
input.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type !== 'user') return;
  if (!initialized) {
    initialized = true;
    send({ type: 'system', subtype: 'init', session_id: 'fixture-session', tools: [] });
  }
  turns++;
  const text = value.message.content.map((block) => block.text ?? '').join('');
  const answer = `Turn ${turns}: I heard "${text}". This is a synthetic test response.`;
  if (text.includes('debug fixture')) {
    const callId = `toolu_debug_${turns}`;
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: callId, name: 'mcp__fermi__execute' } } });
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"token":"INPUT_SECRET_SENTINEL"}' } } });
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: callId, is_error: true, content: JSON.stringify({ statusCode: 401, error: { code: 'authentication_error', message: 'Authorization: Bearer RESULT_SECRET_SENTINEL' } }) }] } });
  }
  send({ type: 'stream_event', event: { type: 'message_start' } });
  send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const midpoint = Math.floor(answer.length / 2);
  for (const chunk of [answer.slice(0, midpoint), answer.slice(midpoint)]) {
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
  }
  send({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
  send({ type: 'result', subtype: 'success', is_error: false, result: answer });
});
