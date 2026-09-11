#!/usr/bin/env node
// Synthetic Claude Code CLI. It speaks the same NDJSON stream-json protocol the
// real CLI uses so the harness can be exercised without any live model call.
//
// Behaviour is driven entirely by environment variables so a single fixture
// covers every test scenario:
//   SCENARIO   basic | error | hang | crash            (default: basic)
//   FRAGMENT   "1" -> emit stdout in tiny raw byte slices (splits lines AND
//              multi-byte UTF-8 characters across writes)
//   DELAY_MS   milliseconds to wait before emitting the final `result`
//   NO_INIT    "1" -> never emit the system/init line
//   SESSION_ID overrides the reported session id

const SCENARIO = process.env.SCENARIO ?? 'basic';
const FRAGMENT = process.env.FRAGMENT === '1';
const DELAY_MS = Number(process.env.DELAY_MS ?? '0');
const SESSION_ID = process.env.SESSION_ID ?? 'fixture-session';

// Serialize all raw writes through a queue so fragmented byte slices from
// different emit() calls never interleave.
let writeChain = Promise.resolve();

function writeRaw(text) {
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        const buf = Buffer.from(text, 'utf8');
        if (!FRAGMENT) {
          process.stdout.write(buf, resolve);
          return;
        }
        let offset = 0;
        const step = () => {
          if (offset >= buf.length) {
            resolve();
            return;
          }
          // 3-byte slices deliberately cut through multi-byte chars.
          const end = Math.min(offset + 3, buf.length);
          const slice = buf.subarray(offset, end);
          offset = end;
          process.stdout.write(slice, () => setImmediate(step));
        };
        step();
      }),
  );
  return writeChain;
}

function emit(obj) {
  return writeRaw(`${JSON.stringify(obj)}\n`);
}

const streamEvent = (event) => emit({ type: 'stream_event', event, parent_tool_use_id: null });

async function emitInit() {
  if (process.env.NO_INIT === '1') return;
  await emit({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    tools: ['Read', 'Bash'],
    model: 'fixture-model',
  });
}

async function runBasicTurn(userText) {
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });

  // Block 0: thinking — MUST NOT be streamed as speech.
  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });

  // Block 1: real assistant text — the only thing that should surface. Uses a
  // multi-byte payload to prove UTF-8-safe reassembly under FRAGMENT.
  await streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  await streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello café ' } });
  await streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '🌊 world' } });
  await streamEvent({ type: 'content_block_stop', index: 1 });

  // Block 2: tool_use — arguments (input_json_delta) MUST NOT be streamed, but
  // running/done status should surface.
  await streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' } });
  await streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"/etc/passwd"}' } });
  await streamEvent({ type: 'content_block_stop', index: 2 });

  // A nested sub-agent text delta (parent_tool_use_id set) — MUST NOT surface.
  await emit({
    type: 'stream_event',
    parent_tool_use_id: 'tool-1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NESTED-LEAK' } },
  });

  await streamEvent({ type: 'message_stop' });

  // Tool result arrives as a top-level user message -> tool done.
  await emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
  });

  // Completed assistant message duplicates the streamed text — MUST be ignored.
  await emit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello café 🌊 world' }] },
  });

  if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));

  // Whole-turn result — also carries the text, still MUST NOT be re-emitted.
  await emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Hello café 🌊 world',
    session_id: SESSION_ID,
    echo: userText,
  });
}

async function handleTurn(userText) {
  if (SCENARIO === 'crash') {
    await streamEvent({ type: 'message_start', message: { role: 'assistant' } });
    process.exit(1);
    return;
  }
  if (SCENARIO === 'error') {
    await emit({ type: 'result', subtype: 'error', is_error: true, error: 'synthetic turn failure' });
    return;
  }
  if (SCENARIO === 'hang') {
    // Deliberately never respond — exercises send() timeout / close-while-pending.
    return;
  }
  await runBasicTurn(userText);
}

// --- stdin turn loop (manual, one turn at a time) ---------------------------
let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString('utf8');
  let idx = stdinBuffer.indexOf('\n');
  while (idx !== -1) {
    const line = stdinBuffer.slice(0, idx).trim();
    stdinBuffer = stdinBuffer.slice(idx + 1);
    if (line) {
      let text = '';
      try {
        const msg = JSON.parse(line);
        const content = msg?.message?.content;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content.map((b) => b?.text ?? '').join('');
      } catch {
        // ignore malformed input
      }
      handleTurn(text);
    }
    idx = stdinBuffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  // Let any in-flight writes flush, then exit cleanly.
  writeChain.then(() => process.exit(0));
});

await emitInit();
