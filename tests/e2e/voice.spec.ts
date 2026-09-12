import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('manual microphone turn, streamed playback, typed follow-up and cleanup', async ({ page, request }) => {
  const errors: string[] = [];
  let capturedBytes = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => { if (Buffer.isBuffer(payload)) capturedBytes += payload.length; });
  });
  await page.addInitScript(() => {
    const stats = { buffers: 0, nonzeroSamples: 0, tracks: [] as MediaStreamTrack[], contexts: [] as AudioContext[] };
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) { super(options); stats.contexts.push(this); }
    };
    Object.assign(window, { waveTestAudio: stats });
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof originalStart>) {
      if (this.buffer) {
        stats.buffers++;
        stats.nonzeroSamples += this.buffer.getChannelData(0).filter((value) => value !== 0).length;
      }
      return originalStart.apply(this, args);
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      stats.tracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Talk it through.' })).toBeVisible();
  await expect(page.getByText('Test mode: synthetic responses and audio, not live inference.')).toBeVisible();
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('button', { name: 'Record a thought' })).toBeEnabled();
  await page.getByRole('button', { name: 'Record a thought' }).click();
  await expect(page.getByRole('button', { name: 'Finish turn' })).toBeEnabled();
  await expect.poll(() => capturedBytes).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Finish turn' }).click();
  await expect(page.getByRole('log')).toContainText('This is a microphone test.');
  await expect(page.getByRole('log')).toContainText('Turn 1:');
  await expect(page.getByRole('button', { name: 'Record a thought' })).toBeEnabled();
  const audio = await page.evaluate(() => {
    const stats = (window as unknown as { waveTestAudio: { buffers: number; nonzeroSamples: number } }).waveTestAudio;
    return { buffers: stats.buffers, nonzeroSamples: stats.nonzeroSamples };
  });
  expect(audio.buffers).toBeGreaterThan(0);
  expect(audio.nonzeroSamples).toBeGreaterThan(0);

  await page.getByLabel('Type a message').fill('Keep the same conversation.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Turn 2:');
  await expect(page.getByRole('button', { name: 'Record a thought' })).toBeEnabled();
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/p1-voice-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'artifacts/p1-voice-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { waveTestAudio: { tracks: MediaStreamTrack[] } }).waveTestAudio.tracks.every((track) => track.readyState === 'ended'),
  )).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { waveTestAudio: { contexts: AudioContext[] } }).waveTestAudio.contexts.every((context) => context.state === 'closed'),
  )).toBe(true);
  expect((await request.get('/api/bootstrap', { headers: { Origin: 'https://untrusted.example' } })).status()).toBe(403);
  expect(errors).toEqual([]);
});

test('microphone denial preserves typed conversation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('button', { name: 'Record a thought' })).toBeEnabled();
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.getByRole('button', { name: 'Record a thought' }).click();
  await expect(page.getByRole('status')).toContainText('Microphone access is unavailable');
  await page.getByLabel('Type a message').fill('Text still works.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Text still works.');
  await expect(page.getByRole('log')).toContainText('Turn 1:');
  await page.getByRole('button', { name: 'End session' }).click();
});
