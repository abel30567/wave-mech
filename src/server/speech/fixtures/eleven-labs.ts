import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

// A local stand-in for the ElevenLabs realtime STT and TTS WebSocket endpoints.
// It speaks the same frame shapes the production adapter uses so the adapter can
// be exercised end-to-end without any network access or credentials. Behavior
// is configurable per test to cover partial/final transcripts, empty commits,
// incremental synthesis, and malformed/error frames.

export interface FixtureOptions {
  /** Emit a partial_transcript for every audio chunk received. */
  sttPartials?: boolean;
  /** Send a leading non-JSON frame to exercise malformed-frame handling. */
  sttMalformedFirst?: boolean;
  /** Reply to commit with an error frame instead of a final transcript. */
  sttErrorOnCommit?: string;
  /** Never answer a commit, so the client-side timeout fires. */
  sttNoFinal?: boolean;
  /** Send a leading non-JSON frame on the TTS socket. */
  ttsMalformedFirst?: boolean;
  /** Emit an error frame after the first text fragment. */
  ttsError?: string;
  /** Drop the final audio frame so finish waits (timeout coverage). */
  ttsNeverFinal?: boolean;
}

export interface Fixture {
  sttEndpoint: string;
  ttsEndpoint: string;
  close(): Promise<void>;
  /** Tokens observed on incoming connections, to assert they are forwarded. */
  readonly seenTokens: string[];
}

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const seenTokens: string[] = [];
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  server.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'ws://127.0.0.1');
    const token = url.searchParams.get('token') ?? url.searchParams.get('single_use_token');
    if (token) seenTokens.push(token);

    if (url.pathname.startsWith('/stt')) handleStt(ws, options);
    else handleTts(ws, options);
  });

  return {
    sttEndpoint: `ws://127.0.0.1:${port}/stt?model_id=scribe_v2_realtime&commit_strategy=manual`,
    ttsEndpoint: `ws://127.0.0.1:${port}/tts/{voiceId}/stream-input?model_id=eleven_flash_v2_5`,
    seenTokens,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        for (const client of server.clients) client.terminate();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function handleStt(ws: WebSocket, options: FixtureOptions): void {
  if (options.sttMalformedFirst) ws.send('<<not-json>>');
  const words: string[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as {
      type?: string;
      audio_base_64?: string;
      commit?: boolean;
    };
    if (msg.type !== 'input_audio_chunk') return;
    if (msg.commit) {
      if (options.sttNoFinal) return;
      if (options.sttErrorOnCommit) {
        send(ws, { type: 'error', message: options.sttErrorOnCommit });
        return;
      }
      send(ws, { type: 'final_transcript', text: words.join(' '), is_final: true });
      words.length = 0;
      return;
    }
    if (typeof msg.audio_base_64 === 'string' && msg.audio_base_64.length > 0) {
      const word = Buffer.from(msg.audio_base_64, 'base64').toString('utf8');
      words.push(word);
      if (options.sttPartials) send(ws, { type: 'partial_transcript', text: words.join(' ') });
    }
  });
}

function handleTts(ws: WebSocket, options: FixtureOptions): void {
  if (options.ttsMalformedFirst) ws.send('<<not-json>>');
  const fragments: string[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as { text?: string; flush?: boolean };
    const text = msg.text ?? '';
    if (msg.flush) {
      // Stream one audio frame per buffered fragment, preserving order/spacing.
      for (const fragment of fragments) {
        send(ws, { audio: Buffer.from(fragment, 'utf8').toString('base64'), isFinal: false });
      }
      if (!options.ttsNeverFinal) send(ws, { audio: null, isFinal: true });
      fragments.length = 0;
      return;
    }
    if (text.trim().length === 0) return; // initializer space
    if (options.ttsError) {
      send(ws, { type: 'error', message: options.ttsError });
      return;
    }
    fragments.push(text);
  });
}
