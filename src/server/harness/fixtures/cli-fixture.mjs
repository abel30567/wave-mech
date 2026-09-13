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
// P2 additions, all opt-in so P1 scenarios are byte-for-byte unchanged:
//   MCP           "1" -> report mcp_servers connection metadata on init
//   TOOL_ERROR    "failed" | "denied" -> emit an errored tool_result
//   INTERRUPT_NOACK "1" -> ignore control_request (exercise receipt timeout)
//   INTERRUPT_REJECT "1" -> reply to control_request with a control_response
//                    error (the process refuses to cancel), then keep emitting
//                    old-generation output and a late result
//   INTERRUPT_NO_RESULT "1" -> acknowledge the control_request but never emit a
//                    terminal result (exercise the settle timeout)
//   INTERRUPT_LATE_RESULT "1" -> with INTERRUPT_NO_RESULT, additionally emit a
//                    late old-generation delta + result after LATE_MS, proving
//                    the harness never attributes it to a replacement turn
//   LATE_MS        delay before late old-generation output (default 40)
const REPORT_MCP = process.env.MCP === '1';
const TOOL_ERROR = process.env.TOOL_ERROR ?? '';
const INTERRUPT_NOACK = process.env.INTERRUPT_NOACK === '1';
const INTERRUPT_REJECT = process.env.INTERRUPT_REJECT === '1';
const INTERRUPT_NO_RESULT = process.env.INTERRUPT_NO_RESULT === '1';
const INTERRUPT_LATE_RESULT = process.env.INTERRUPT_LATE_RESULT === '1';
const LATE_MS = Number(process.env.LATE_MS ?? '40');

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
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    tools: ['Read', 'Bash'],
    model: 'fixture-model',
  };
  if (REPORT_MCP) {
    init.mcp_servers = [
      { name: 'fermi', status: 'connected' },
      { name: 'offline', status: 'failed' },
    ];
  }
  await emit(init);
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

  // Tool result arrives as a top-level user message -> tool done, unless the
  // scenario forces an errored (failed/denied) result.
  const toolResult = { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' };
  if (TOOL_ERROR === 'failed') {
    toolResult.is_error = true;
    toolResult.content = 'The Read tool failed while opening the file.';
  } else if (TOOL_ERROR === 'denied') {
    toolResult.is_error = true;
    toolResult.content = 'Permission to run Bash was denied by the policy hook.';
  }
  await emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [toolResult] },
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
  if (SCENARIO === 'interrupt') {
    // Stream a little real text, then hang waiting for a control_request. The
    // turn only settles once the interrupt arrives (see onControlRequest).
    await streamEvent({ type: 'message_start', message: { role: 'assistant' } });
    await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial answer' } });
    return;
  }
  await runBasicTurn(userText);
}

async function onControlRequest(requestId) {
  if (SCENARIO !== 'interrupt') return;
  if (INTERRUPT_NOACK) return; // never acknowledge -> exercise receipt timeout

  if (INTERRUPT_REJECT) {
    // The process refuses to cancel. Its generation keeps running: emit a late
    // delta and a whole-turn result that must never surface or be attributed to
    // a replacement turn.
    await emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'interrupt refused' } });
    await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE-AFTER-INTERRUPT' } });
    await streamEvent({ type: 'content_block_stop', index: 0 });
    await streamEvent({ type: 'message_stop' });
    await emit({ type: 'result', subtype: 'success', is_error: false, result: 'Old generation answer', session_id: SESSION_ID });
    return;
  }

  // A late delta arrives from the aborted generation; the harness must fence it.
  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE-AFTER-INTERRUPT' } });
  await emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId } });

  if (INTERRUPT_NO_RESULT) {
    // Acknowledged, but the turn never terminally settles on its own.
    if (INTERRUPT_LATE_RESULT) {
      await new Promise((r) => setTimeout(r, LATE_MS));
      await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE-OLD-GENERATION' } });
      await streamEvent({ type: 'content_block_stop', index: 0 });
      await streamEvent({ type: 'message_stop' });
      await emit({ type: 'result', subtype: 'success', is_error: false, result: 'Old late answer', session_id: SESSION_ID });
    }
    return;
  }

  await streamEvent({ type: 'content_block_stop', index: 0 });
  await streamEvent({ type: 'message_stop' });
  await emit({ type: 'result', subtype: 'success', is_error: false, result: 'Partial answer', session_id: SESSION_ID });
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
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        msg = undefined; // ignore malformed input
      }
      if (msg?.type === 'control_request') {
        onControlRequest(msg.request_id);
      } else if (msg) {
        const content = msg?.message?.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content.map((b) => b?.text ?? '').join('');
        handleTurn(text);
      }
    }
    idx = stdinBuffer.indexOf('\n');
  }
});

process.stdin.on('end', () => {
  // Let any in-flight writes flush, then exit cleanly.
  writeChain.then(() => process.exit(0));
});

await emitInit();
