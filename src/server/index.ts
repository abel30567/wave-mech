import { createServer, type IncomingMessage } from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { ViteDevServer } from 'vite';
import { VoiceSession } from './session.js';
import { createHarness } from './harness/index.js';
import { harnessEnvironmentOverrides } from './harness-environment.js';
import { createSpeech } from './speech/index.js';
import { createBrokerTokenProvider, createElevenLabsTokenProvider } from './speech-broker.js';
import { parseClientMessage } from '../shared/protocol.js';
import type { HarnessOptions } from '../shared/contracts.js';

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be between 1024 and 65535.');
const fixtureMode = process.env.NODE_ENV === 'test' && process.env.WAVE_TEST_MODE === '1';
if (process.env.WAVE_TEST_MODE === '1' && !fixtureMode) throw new Error('Fixture mode is only available with NODE_ENV=test.');
const production = process.env.NODE_ENV === 'production' || fixtureMode;
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const origins = new Set([...hosts].map((host) => `http://${host}`));
const sessionToken = randomBytes(32).toString('hex');
const clientDirectory = path.resolve('dist/client');
let vite: ViteDevServer | undefined;
const fixtures = fixtureMode ? await (await import('./testing.js')).startFixtureSpeech() : undefined;
let speechKey = fixtureMode ? undefined : process.env.ELEVENLABS_API_KEY?.trim();
if (!fixtureMode && !speechKey && !process.env.WAVE_SPEECH_TOKEN_URL) {
  const keyPath = process.env.WAVE_ELEVENLABS_KEY_FILE ?? path.resolve('.wave-mech/elevenlabs.key');
  try {
    const metadata = await stat(keyPath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error('Speech credential file must be private (0600).');
    speechKey = (await readFile(keyPath, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot load the private server speech credential.');
  }
}
const getSpeechToken = fixtures ? async () => 'fixture-token' : process.env.WAVE_SPEECH_TOKEN_URL
  ? createBrokerTokenProvider({
    urlTemplate: process.env.WAVE_SPEECH_TOKEN_URL,
    authorization: process.env.WAVE_SPEECH_TOKEN_AUTH,
  }) : speechKey ? createElevenLabsTokenProvider(speechKey) : undefined;
const voiceId = process.env.WAVE_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb';

function validCookie(request: IncomingMessage): boolean {
  const supplied = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('wave_session='))?.slice('wave_session='.length);
  const actual = Buffer.from(supplied ?? '');
  const expected = Buffer.from(sessionToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Permissions-Policy', 'microphone=(self)');
  response.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${production ? '' : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; worker-src 'self' blob:; img-src 'self' data:; frame-ancestors 'self'; base-uri 'self'; object-src 'none'`);
  if (!hosts.has(request.headers.host ?? '') ||
      (request.headers.origin && !origins.has(request.headers.origin)) ||
      request.headers['sec-fetch-site'] === 'cross-site') {
    response.writeHead(403).end('Origin not permitted.');
    return;
  }
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/api/bootstrap' && request.method === 'GET') {
    response.setHeader('Set-Cookie', `wave_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      mode: fixtureMode ? 'fixture' : 'live', speechConfigured: Boolean(getSpeechToken),
      speechMessage: getSpeechToken ? 'Speech service configured; connection is checked on use.' : 'Server speech credentials are not configured. Typed conversation is available.',
    }));
    return;
  }
  if (pathname.startsWith('/api/')) { response.writeHead(404).end(); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
  if (vite) { vite.middlewares(request, response); return; }
  try {
    const decoded = decodeURIComponent(pathname);
    const file = path.resolve(clientDirectory, `.${decoded}`);
    if (path.relative(clientDirectory, file).startsWith('..')) { response.writeHead(403).end(); return; }
    let target = file;
    try { if (!(await stat(target)).isFile()) target = path.join(clientDirectory, 'index.html'); }
    catch { target = path.join(clientDirectory, 'index.html'); }
    const content = await readFile(target);
    const extension = path.extname(target);
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    response.setHeader('Content-Type', mime[extension] ?? 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404).end('Build the application before starting it.'); }
});

if (!production) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
}

const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
let active: VoiceSession | undefined;
server.on('upgrade', (request, socket, head) => {
  if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/session') {
    if (production) socket.destroy();
    return;
  }
  if (!hosts.has(request.headers.host ?? '') || !origins.has(request.headers.origin ?? '') || !validCookie(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (connection) => sockets.emit('connection', connection));
});

sockets.on('connection', (socket) => {
  if (active) { socket.close(4009, 'Another local session is open.'); return; }
  let workspace: string | undefined;
  const session = new VoiceSession({
    mode: fixtureMode ? 'fixture' : 'live',
    send: (message) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1024 * 1024) {
        socket.close(1011, 'Playback connection is too slow.');
        void session.close();
        return;
      }
      socket.send(JSON.stringify(message));
    },
    harness: (onEvent) => {
      const overrides = harnessEnvironmentOverrides();
      const options: HarnessOptions = fixtureMode ? {
        command: process.execPath, args: [path.resolve('tests/fixtures/harness.mjs')], onEvent,
      } : {
        command: process.env.WAVE_CLAUDE_BIN ?? 'claude', env: overrides, onEvent,
        args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--include-partial-messages', '--verbose', '--tools', '', '--permission-mode', 'dontAsk',
          '--setting-sources', '', '--allowedTools', 'mcp__claude_ai_Fermi__memory_recall', 'mcp__fermi__memory_recall',
          '--append-system-prompt', 'You are a concise voice conversation partner. Use plain, speakable sentences. Only configured read-only tools are permitted. Do not claim access or completed actions without a tool result. No code changes or consequential actions are available in this voice session.'],
      };
      let adapter: ReturnType<typeof createHarness> | undefined;
      let closed = false;
      return {
        async start() {
          workspace = await mkdtemp(path.join(tmpdir(), 'wave-mech-'));
          if (closed) {
            await rm(workspace, { recursive: true, force: true });
            throw new Error('Session already closed.');
          }
          adapter = createHarness({ ...options, cwd: workspace });
          await adapter.start();
        },
        send: (text) => adapter && !closed ? adapter.send(text) : Promise.reject(new Error('Harness is not started.')),
        async close() {
          closed = true;
          await adapter?.close();
          if (workspace) await rm(workspace, { recursive: true, force: true });
        },
      };
    },
    speech: getSpeechToken ? (callbacks) => createSpeech({ ...callbacks, getToken: getSpeechToken, voiceId, endpoints: fixtures?.endpoints }) : undefined,
  });
  active = session;
  socket.on('message', (raw, binary) => {
    if (binary) { session.audio(Buffer.from(raw as Buffer)); return; }
    try { void session.handle(parseClientMessage(JSON.parse(raw.toString()))); }
    catch { socket.close(1008, 'Invalid session command.'); }
  });
  socket.on('error', () => { void session.close(); });
  socket.on('close', () => {
    void session.close().finally(() => { if (active === session) active = undefined; });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.info(`wave-mech: http://127.0.0.1:${port} (${fixtureMode ? 'synthetic test mode' : 'live harness mode'})`);
  if (!getSpeechToken) console.info('Speech is unavailable until server-side credentials are configured.');
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await active?.close();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  fixtures?.close();
  await vite?.close();
  server.close();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
