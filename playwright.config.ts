import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sampleRate = 16000;
const samples = sampleRate * 2;
const wave = Buffer.alloc(44 + samples * 2);
wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVE', 8);
wave.write('fmt ', 12); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22); wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(samples * 2, 40);
for (let index = 0; index < samples; index++) {
  wave.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 3000), 44 + index * 2);
}
const fixtureDirectory = path.resolve('.wave-mech');
mkdirSync(fixtureDirectory, { recursive: true });
const audioFile = path.join(fixtureDirectory, 'synthetic-microphone.wav');
writeFileSync(audioFile, wave);

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4318',
    browserName: 'chromium',
    viewport: { width: 1380, height: 980 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${audioFile}`, '--autoplay-policy=no-user-gesture-required'],
    },
  },
  webServer: {
    command: 'node dist/server/index.js',
    url: 'http://127.0.0.1:4318',
    env: { NODE_ENV: 'test', WAVE_TEST_MODE: '1', PORT: '4318' },
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    // WebKit is not tested: @ricky0123/vad-web WASM and AudioWorklet
    // support varies across WebKit builds, and Playwright's WebKit on
    // Linux does not reliably provide the fake-device media flags.
  ],
});
