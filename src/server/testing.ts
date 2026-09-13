import { WebSocketServer } from 'ws';
import { once } from 'node:events';

export async function startFixtureSpeech() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 65536 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture TCP address.');
  server.on('connection', (socket, request) => {
    const recognition = request.url?.startsWith('/stt');
    let audioBytes = 0;
    socket.on('message', (raw) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(raw.toString()); } catch { socket.close(1008); return; }
      if (recognition) {
        if (frame.message_type !== 'input_audio_chunk' || typeof frame.audio_base_64 !== 'string') {
          socket.send(JSON.stringify({ message_type: 'input_error', error: 'Invalid fixture STT frame.' }));
          return;
        }
        audioBytes += Buffer.from(frame.audio_base_64, 'base64').length;
        if (frame.commit) {
          socket.send(JSON.stringify({ message_type: 'committed_transcript', text: audioBytes ? 'This is a microphone test.' : '' }));
          audioBytes = 0;
        } else {
          socket.send(JSON.stringify({ message_type: 'partial_transcript', text: 'This is a microphone' }));
        }
      } else if (typeof frame.text === 'string') {
        if (frame.text === '') {
          socket.send(JSON.stringify({ isFinal: true }));
        } else if (frame.text.trim()) {
          const audio = Buffer.alloc(2400 * 2);
          for (let i = 0; i < 2400; i++) {
            audio.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 330 / 24000) * 2000), i * 2);
          }
          socket.send(JSON.stringify({ audio: audio.toString('base64'), isFinal: false }));
        }
      }
    });
  });
  return {
    endpoints: { stt: `ws://127.0.0.1:${address.port}/stt`, tts: `ws://127.0.0.1:${address.port}/tts/{voiceId}` },
    close: () => { for (const socket of server.clients) socket.terminate(); server.close(); },
  };
}
