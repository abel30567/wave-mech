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
  send({ type: 'stream_event', event: { type: 'message_start' } });
  send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  const midpoint = Math.floor(answer.length / 2);
  for (const chunk of [answer.slice(0, midpoint), answer.slice(midpoint)]) {
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
  }
  send({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
  send({ type: 'result', subtype: 'success', is_error: false, result: answer });
});
