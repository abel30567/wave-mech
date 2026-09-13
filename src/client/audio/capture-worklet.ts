// AudioWorklet processor: runs on the audio render thread, downmixes each input
// render quantum to mono, and posts the Float32 frame to the main thread where
// it is resampled to 16 kHz and encoded to PCM16. Resampling is intentionally
// left to the main thread so the DSP stays unit-testable in Node.
//
// AudioWorklet globals are not part of lib.dom, so they are declared locally.
// This keeps the file strict-TypeScript compatible without extra dependencies.
declare const registerProcessor: (name: string, ctor: unknown) => void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0]?.length ?? 0;
    if (frames === 0) return true;

    const channels = input.length;
    const mono = new Float32Array(frames);
    for (let c = 0; c < channels; c += 1) {
      const channel = input[c];
      for (let i = 0; i < frames; i += 1) mono[i] += channel[i];
    }
    if (channels > 1) {
      const scale = 1 / channels;
      for (let i = 0; i < frames; i += 1) mono[i] *= scale;
    }

    // Transfer the buffer to avoid a copy across the thread boundary.
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor('wave-mech-capture', CaptureProcessor);

export {};
