#!/usr/bin/env node
// Synthetic Claude Code CLI. It speaks the same NDJSON stream-json protocol the
// real CLI uses so the harness can be exercised without any live model call.
//
// Behaviour is driven entirely by environment variables so a single fixture
// covers every test scenario:
//   SCENARIO   basic | error | hang | crash | concurrent_tools | service_failure
//              | pending_approval | secret_sentinel | model_init
//   FRAGMENT   "1" -> emit stdout in tiny raw byte slices
//   DELAY_MS   milliseconds to wait before emitting the final `result`
//   NO_INIT    "1" -> never emit the system/init line
//   SESSION_ID overrides the reported session id
//   MCP        "1" -> report mcp_servers connection metadata on init
//   TOOL_ERROR "failed" | "denied" -> emit an errored tool_result
//   INTERRUPT_NOACK "1" -> ignore control_request
//   INTERRUPT_REJECT "1" -> reply with control_response error
//   INTERRUPT_NO_RESULT "1" -> acknowledge but never emit terminal result
//   INTERRUPT_LATE_RESULT "1" -> emit late old-generation output
//   LATE_MS    delay before late old-generation output (default 40)
//   MODEL      model identifier to report on init (default 'fixture-model')
//   REPEATED_TOOL "1" -> emit the same tool name twice concurrently

const SCENARIO = process.env.SCENARIO ?? 'basic';
const FRAGMENT = process.env.FRAGMENT === '1';
const DELAY_MS = Number(process.env.DELAY_MS ?? '0');
const SESSION_ID = process.env.SESSION_ID ?? 'fixture-session';
const REPORT_MCP = process.env.MCP === '1';
const TOOL_ERROR = process.env.TOOL_ERROR ?? '';
const INTERRUPT_NOACK = process.env.INTERRUPT_NOACK === '1';
const INTERRUPT_REJECT = process.env.INTERRUPT_REJECT === '1';
const INTERRUPT_NO_RESULT = process.env.INTERRUPT_NO_RESULT === '1';
const INTERRUPT_LATE_RESULT = process.env.INTERRUPT_LATE_RESULT === '1';
const LATE_MS = Number(process.env.LATE_MS ?? '40');
const MODEL = process.env.MODEL ?? 'fixture-model';
const REPEATED_TOOL = process.env.REPEATED_TOOL === '1';

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
    model: MODEL,
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

  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret reasoning' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });

  await streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  await streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello café ' } });
  await streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '🌊 world' } });
  await streamEvent({ type: 'content_block_stop', index: 1 });

  await streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' } });
  await streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"/etc/passwd"}' } });
  await streamEvent({ type: 'content_block_stop', index: 2 });

  await emit({
    type: 'stream_event',
    parent_tool_use_id: 'tool-1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NESTED-LEAK' } },
  });

  await streamEvent({ type: 'message_stop' });

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

  await emit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello café 🌊 world' }] },
  });

  if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));

  await emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Hello café 🌊 world',
    session_id: SESSION_ID,
    echo: userText,
  });
}

async function runConcurrentTools() {
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });

  // Two concurrent tool_use blocks with the same name but different IDs.
  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'ct-1', name: 'Read' } });
  await streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'ct-2', name: 'Read' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });
  await streamEvent({ type: 'content_block_stop', index: 1 });
  await streamEvent({ type: 'message_stop' });

  // Both results arrive.
  await emit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'ct-1', content: 'file-a' },
        { type: 'tool_result', tool_use_id: 'ct-2', content: 'file-b' },
      ],
    },
  });

  await emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID });
}

async function runServiceFailure() {
  // A tool result that looks like success (is_error:false) but contains
  // error-shaped JSON with ok:false — integration error detection.
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });
  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'sf-1', name: 'mcp__fermi__execute' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });
  await streamEvent({ type: 'message_stop' });

  await emit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'sf-1',
          is_error: false,
          content: JSON.stringify({ ok: false, error: 'service unavailable', status: 503 }),
        },
      ],
    },
  });

  await emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID });
}

async function runPendingApproval() {
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });
  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'pa-1', name: 'mcp__fermi__secret_resolve' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });
  await streamEvent({ type: 'message_stop' });

  await emit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'pa-1',
          is_error: false,
          content: JSON.stringify({ ok: false, error: 'approval needed', status: 'pending_approval' }),
        },
      ],
    },
  });

  await emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: SESSION_ID });
}

async function runSecretSentinel() {
  // A tool result containing secret-like tokens that must not leak to diagnostics.
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });

  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Safe response' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });

  await streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'sec-1', name: 'mcp__fermi__secret_resolve' } });
  await streamEvent({ type: 'content_block_stop', index: 1 });
  await streamEvent({ type: 'message_stop' });

  await emit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'sec-1',
          content: 'sk-ant-XXXX-secret-token-value',
        },
      ],
    },
  });

  await emit({ type: 'result', subtype: 'success', is_error: false, result: 'Safe response', session_id: SESSION_ID });
}

async function runToolThenResult() {
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });

  // Pre-tool narration
  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look that up.' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });

  // Tool call
  await streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'ttr-1', name: 'WebSearch' } });
  await streamEvent({ type: 'content_block_stop', index: 1 });
  await streamEvent({ type: 'message_stop' });

  await emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ttr-1', content: 'search results here' }] },
  });

  // Second message with final result text (different from preamble)
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });
  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The answer is 42.' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });
  await streamEvent({ type: 'message_stop' });

  await emit({ type: 'result', subtype: 'success', is_error: false, result: 'The answer is 42.', session_id: SESSION_ID });
}

async function runTextOnly() {
  await streamEvent({ type: 'message_start', message: { role: 'assistant' } });
  await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Simple direct answer.' } });
  await streamEvent({ type: 'content_block_stop', index: 0 });
  await streamEvent({ type: 'message_stop' });

  await emit({ type: 'result', subtype: 'success', is_error: false, result: 'Simple direct answer.', session_id: SESSION_ID });
}

async function handleTurn(userText) {
  if (SCENARIO === 'tool_then_result') {
    await runToolThenResult();
    return;
  }
  if (SCENARIO === 'text_only') {
    await runTextOnly();
    return;
  }
  if (SCENARIO === 'tool_crash') {
    await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'crash-tool', name: 'mcp__fermi__execute' } });
    process.exit(1);
    return;
  }
  if (SCENARIO === 'duplicate_tools') {
    const start = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'duplicate-tool', name: 'mcp__fermi__execute' } };
    await streamEvent(start); await streamEvent(start);
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'duplicate-tool', content: 'ok' }] } };
    await emit(result); await emit(result);
    await emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
    return;
  }
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
    return;
  }
  if (SCENARIO === 'interrupt') {
    await streamEvent({ type: 'message_start', message: { role: 'assistant' } });
    await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial answer' } });
    return;
  }
  if (SCENARIO === 'concurrent_tools') {
    await runConcurrentTools();
    return;
  }
  if (SCENARIO === 'service_failure') {
    await runServiceFailure();
    return;
  }
  if (SCENARIO === 'pending_approval') {
    await runPendingApproval();
    return;
  }
  if (SCENARIO === 'secret_sentinel') {
    await runSecretSentinel();
    return;
  }
  await runBasicTurn(userText);
}

async function onControlRequest(requestId) {
  if (SCENARIO !== 'interrupt') return;
  if (INTERRUPT_NOACK) return;

  if (INTERRUPT_REJECT) {
    await emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'interrupt refused' } });
    await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE-AFTER-INTERRUPT' } });
    await streamEvent({ type: 'content_block_stop', index: 0 });
    await streamEvent({ type: 'message_stop' });
    await emit({ type: 'result', subtype: 'success', is_error: false, result: 'Old generation answer', session_id: SESSION_ID });
    return;
  }

  await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'LATE-AFTER-INTERRUPT' } });
  await emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId } });

  if (INTERRUPT_NO_RESULT) {
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
        msg = undefined;
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
  writeChain.then(() => process.exit(0));
});

await emitInit();
