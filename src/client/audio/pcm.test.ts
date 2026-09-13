import { describe, expect, it } from 'vitest';
import {
  Pcm16Resampler,
  decodePcm16Base64,
  downmixToMono,
  encodePcm16,
  floatToInt16,
} from './pcm.js';

function base64Of(buffer: ArrayBuffer): string {
  return Buffer.from(buffer).toString('base64');
}

describe('PCM16 encoding', () => {
  it('maps the float range to full-scale signed 16-bit', () => {
    expect(floatToInt16(0)).toBe(0);
    expect(floatToInt16(1)).toBe(32767);
    expect(floatToInt16(-1)).toBe(-32768);
    // Values beyond the range are clamped rather than wrapped.
    expect(floatToInt16(2)).toBe(32767);
    expect(floatToInt16(-2)).toBe(-32768);
  });

  it('writes little-endian bytes', () => {
    const buffer = encodePcm16(Float32Array.from([1]));
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([0xff, 0x7f]));
  });

  it('round-trips through base64 within quantization error', () => {
    const original = Float32Array.from([0, 0.25, -0.25, 0.5, -0.5, 0.999, -0.999]);
    const decoded = decodePcm16Base64(base64Of(encodePcm16(original)));
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i += 1) {
      // One LSB of quantization plus the asymmetric +full-scale rounding.
      expect(Math.abs(decoded[i] - original[i])).toBeLessThan(1 / 16384);
    }
  });

  it('ignores a dangling odd byte when decoding', () => {
    // Three bytes = one whole sample plus a stray byte.
    const base64 = Buffer.from([0x00, 0x40, 0x11]).toString('base64');
    expect(decodePcm16Base64(base64).length).toBe(1);
  });
});

describe('downmix to mono', () => {
  it('averages equal-length channels', () => {
    const left = Float32Array.from([1, 0, -1]);
    const right = Float32Array.from([0, 0, 1]);
    expect(Array.from(downmixToMono([left, right]))).toEqual([0.5, 0, 0]);
  });

  it('returns the sole channel unchanged for mono input', () => {
    const mono = Float32Array.from([0.1, 0.2]);
    expect(downmixToMono([mono])).toBe(mono);
  });
});

describe('Pcm16Resampler', () => {
  it('downsamples to 16 kHz and emits bounded PCM16 chunks', () => {
    const resampler = new Pcm16Resampler(48000, 16000, 128);
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i += 1) input[i] = Math.sin(i / 20);

    const chunks = resampler.push(input);
    const tail = resampler.flush();

    for (const chunk of chunks) {
      expect(chunk.byteLength).toBe(128 * 2); // full chunks are exactly chunkSamples
    }
    const totalSamples =
      chunks.reduce((n, c) => n + c.byteLength, 0) / 2 + tail.byteLength / 2;
    // 3:1 downsample of 4800 input samples yields ~1600 output samples.
    expect(totalSamples).toBeGreaterThan(1500);
    expect(totalSamples).toBeLessThan(1700);
  });

  it('produces the same sample count whether fed whole or in two pushes', () => {
    const signal = new Float32Array(4800).map((_, i) => Math.sin(i / 13));

    const whole = new Pcm16Resampler(48000, 16000, 4096);
    const wholeSamples =
      [...whole.push(signal), whole.flush()].reduce((n, c) => n + c.byteLength, 0) / 2;

    const split = new Pcm16Resampler(48000, 16000, 4096);
    const splitSamples =
      [
        ...split.push(signal.subarray(0, 2400)),
        ...split.push(signal.subarray(2400)),
        split.flush(),
      ].reduce((n, c) => n + c.byteLength, 0) / 2;

    // Chunk boundaries must not add or drop more than a single sample.
    expect(Math.abs(wholeSamples - splitSamples)).toBeLessThanOrEqual(1);
  });

  it('flush on an empty stream yields a zero-length buffer', () => {
    const resampler = new Pcm16Resampler(48000, 16000);
    expect(resampler.flush().byteLength).toBe(0);
  });

  it('rejects non-positive sample rates', () => {
    expect(() => new Pcm16Resampler(0)).toThrow();
  });
});
