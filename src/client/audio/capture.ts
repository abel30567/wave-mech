import type { CaptureSession } from '../../shared/contracts.js';
import { Pcm16Resampler } from './pcm.js';
// Vite bundles the worklet and hands back its asset URL. `?worker&url` produces
// a standalone module URL suitable for `audioWorklet.addModule` and is the
// pattern sanctioned by the project's working agreement.
import workletUrl from './capture-worklet.ts?worker&url';

const TARGET_SAMPLE_RATE = 16000;

/**
 * Open the microphone and stream mono little-endian PCM16 at 16 kHz to
 * `onChunk`. The device's native rate/channel layout is downmixed in the
 * worklet and resampled on the main thread. `stop()` flushes the residual
 * samples, then tears down every resource it acquired.
 */
export async function createCapture(
  onChunk: (pcm: ArrayBuffer) => void,
): Promise<CaptureSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const context = new AudioContext();
  try {
    await context.audioWorklet.addModule(workletUrl);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }

  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'wave-mech-capture');
  const resampler = new Pcm16Resampler(context.sampleRate, TARGET_SAMPLE_RATE);

  node.port.onmessage = (event: MessageEvent): void => {
    const frame = event.data as Float32Array;
    for (const chunk of resampler.push(frame)) onChunk(chunk);
  };

  // Route through a muted gain node so the worklet keeps pulling audio without
  // playing the microphone back to the user.
  const sink = context.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(context.destination);

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      sink.disconnect();
      const residual = resampler.flush();
      if (residual.byteLength > 0) onChunk(residual);
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
    },
  };
}
