// Transport-free PCM math shared by capture and playback.
//
// Capture must deliver mono, little-endian signed PCM16 at 16 kHz regardless of
// the microphone's native rate/channel count. Playback must turn base64 PCM16
// (at an arbitrary sample rate) back into Float32 samples. Both jobs are pure
// number-crunching, so they live here and are unit tested directly.

/** Clamp a Float32 sample to [-1, 1] and encode as a signed 16-bit integer. */
export function floatToInt16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  // Asymmetric full-scale: negative range reaches -32768, positive +32767.
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** Average N equal-length channel buffers into one mono Float32Array. */
export function downmixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const frames = channels[0].length;
  const mono = new Float32Array(frames);
  for (const channel of channels) {
    for (let i = 0; i < frames; i += 1) mono[i] += channel[i];
  }
  const scale = 1 / channels.length;
  for (let i = 0; i < frames; i += 1) mono[i] *= scale;
  return mono;
}

/** Pack Float32 samples into a little-endian PCM16 ArrayBuffer. */
export function encodePcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, floatToInt16(samples[i]), true);
  }
  return buffer;
}

/** Decode base64 PCM16 into normalized Float32 samples in [-1, 1). */
export function decodePcm16Base64(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // Only whole 16-bit samples are usable; ignore a dangling trailing byte.
  const sampleCount = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/**
 * Streaming linear resampler that converts a mono Float32 stream from `inRate`
 * to `outRate` and emits fixed-size PCM16 chunks. State (fractional read
 * position and the trailing input sample) is preserved across `push` calls so
 * chunk boundaries do not create clicks. `flush` emits whatever residual
 * samples remain when the stream ends.
 */
export class Pcm16Resampler {
  private readonly ratio: number;
  private residualInput: Float32Array = new Float32Array(0);
  private position = 0;
  private output: number[] = [];

  constructor(
    private readonly inRate: number,
    private readonly outRate = 16000,
    private readonly chunkSamples = 1024,
  ) {
    if (inRate <= 0 || outRate <= 0) throw new Error('sample rates must be positive');
    this.ratio = inRate / outRate;
  }

  push(input: Float32Array): ArrayBuffer[] {
    if (input.length === 0) return [];
    const buffer = concat(this.residualInput, input);
    // Interpolate output samples while a full [floor, floor+1] pair is available.
    while (this.position + 1 < buffer.length) {
      const index = Math.floor(this.position);
      const frac = this.position - index;
      this.output.push(buffer[index] * (1 - frac) + buffer[index + 1] * frac);
      this.position += this.ratio;
    }
    // Keep the tail we still need for the next interpolation window.
    const consumed = Math.floor(this.position);
    this.residualInput = buffer.subarray(consumed);
    this.position -= consumed;
    return this.emitChunks(false);
  }

  private emitChunks(final: boolean): ArrayBuffer[] {
    const chunks: ArrayBuffer[] = [];
    while (this.output.length >= this.chunkSamples) {
      chunks.push(encodePcm16(Float32Array.from(this.output.splice(0, this.chunkSamples))));
    }
    if (final && this.output.length > 0) {
      chunks.push(encodePcm16(Float32Array.from(this.output)));
      this.output = [];
    }
    return chunks;
  }

  /** Emit the last partial sample(s) and any buffered residual as one chunk. */
  flush(): ArrayBuffer {
    // Emit a final output sample anchored on the last real input sample so the
    // tail is not silently dropped.
    if (this.residualInput.length > 0 && this.position < this.residualInput.length) {
      this.output.push(this.residualInput[this.residualInput.length - 1]);
    }
    this.residualInput = new Float32Array(0);
    this.position = 0;
    const remaining = this.output;
    this.output = [];
    return encodePcm16(Float32Array.from(remaining));
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  const merged = new Float32Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}
