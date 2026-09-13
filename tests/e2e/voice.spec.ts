import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Browser-side injection: controlled audio factory + WebSocket tracking.
//
// Sets window.__waveTestAudioFactory (consumed by App.tsx in fixture mode) so
// speech events are triggered deterministically from the test, and tracks
// every WebSocket created so reconnect tests can force-close the transport.
// ---------------------------------------------------------------------------
const CONTROLLED_AUDIO_SCRIPT = `(() => {
  const _sockets = [];
  const _Orig = window.WebSocket;
  window.WebSocket = class extends _Orig {
    constructor(...a) { super(...a); _sockets.push(this); }
  };
  window.__waveSockets = _sockets;

  window.__waveTestAudioFactory = async (options) => {
    const state = { mode: 'paused', closed: false, modes: [] };
    window.__waveTestControl = {
      speechStart()  { options.onSpeechStart(); },
      speechEnd()    { options.onSpeechEnd(); },
      misfire()      { options.onMisfire(); },
      emitPcm(n)    {
        const buf = new ArrayBuffer(n);
        const v = new DataView(buf);
        for (let i = 0; i < n / 2; i++)
          v.setInt16(i * 2, Math.round(Math.sin(i * 0.1) * 3000), true);
        options.onPcm(buf);
      },
      setState(s)        { options.onState(s); },
      discontinuity()    { options.onDiscontinuity(); },
      error(msg)         { options.onError(msg); },
      getState()         { return state; },
    };
    return {
      setMode(m) { state.mode = m; state.modes.push(m); },
      flushInput()   { return Promise.resolve(); },
      clearInput()   {},
      enqueueOutput(){},
      finishOutput() { return Promise.resolve('played'); },
      cancelOutput() {},
      resume()       { return Promise.resolve(); },
      close()        { state.closed = true; return Promise.resolve(); },
    };
  };
})();`;

async function waitListening(page: Page) {
  await expect(page.locator('.station-status')).toHaveText('Listening', { timeout: 15000 });
}

async function speechTurn(page: Page, turn: number) {
  await page.evaluate(() => (window as any).__waveTestControl.speechStart());
  for (let i = 0; i < 5; i++)
    await page.evaluate(() => (window as any).__waveTestControl.emitPcm(3200));
  await page.evaluate(() => (window as any).__waveTestControl.speechEnd());
  await expect(page.getByRole('log')).toContainText(`Turn ${turn}:`, { timeout: 15000 });
}

// ===========================================================================
// P2 hands-free conversation — controlled audio, fixture harness
// ===========================================================================

test.describe('hands-free conversation', () => {
  test('three automatic turns with no duplicate accepted turns', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Talk it through.' })).toBeVisible();
    await expect(page.getByText('Test mode: synthetic provider responses, not live inference.')).toBeVisible();

    await page.getByRole('button', { name: 'Start session' }).click();
    await waitListening(page);

    for (let i = 1; i <= 3; i++) await speechTurn(page, i);

    const logText = await page.evaluate(() =>
      document.querySelector('[role="log"]')?.textContent ?? '',
    );
    for (let n = 1; n <= 3; n++) {
      const count = (logText.match(new RegExp(`Turn ${n}:`, 'g')) ?? []).length;
      expect(count, `Turn ${n} should appear exactly once`).toBe(1);
    }

    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/three-turns.png', fullPage: true });

    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();

    const closed = await page.evaluate(
      () => (window as any).__waveTestControl.getState().closed,
    );
    expect(closed).toBe(true);
    expect(errors).toEqual([]);
  });

  test('reconnect preserves session context across a short socket drop', async ({ page }) => {
    const hellos: Array<{ sessionId?: string }> = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', ({ payload }) => {
        if (typeof payload !== 'string') return;
        try {
          const msg = JSON.parse(payload);
          if (msg.type === 'hello') hellos.push({ sessionId: msg.sessionId });
        } catch { /* binary frame */ }
      });
    });

    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session' }).click();
    await waitListening(page);

    await speechTurn(page, 1);

    // Force-close the live WebSocket to simulate a transient network fault.
    await page.evaluate(() => {
      const sockets = (window as any).__waveSockets as WebSocket[];
      const live = sockets.find((s) => s.readyState === WebSocket.OPEN);
      live?.close();
    });

    await expect(page.locator('.station-status')).toHaveText(
      'Reconnecting — keeping your conversation',
      { timeout: 5000 },
    );

    // The client reconnects automatically within ~750 ms.
    await waitListening(page);

    // Turn 1 must still be visible (session preserved, not duplicated).
    await expect(page.getByRole('log')).toContainText('Turn 1:');

    // Complete a second turn after reconnect.
    await speechTurn(page, 2);

    const logText = await page.evaluate(() =>
      document.querySelector('[role="log"]')?.textContent ?? '',
    );
    expect((logText.match(/Turn 1:/g) ?? []).length).toBe(1);
    expect((logText.match(/Turn 2:/g) ?? []).length).toBe(1);

    // The reconnect hello must carry the preserved sessionId.
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    expect(hellos[0].sessionId).toBeUndefined();
    expect(hellos[hellos.length - 1].sessionId).toBeTruthy();

    await page.getByRole('button', { name: 'End session' }).click();
  });

  test('pause and resume audio completion', async ({ page }) => {
    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session' }).click();
    await waitListening(page);

    // Simulate AudioContext suspension.
    await page.evaluate(() =>
      (window as any).__waveTestControl.setState('suspended'),
    );
    await expect(page.locator('.station-status')).toHaveText('Audio paused', { timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Resume audio' })).toBeVisible();

    // Resume.
    await page.getByRole('button', { name: 'Resume audio' }).click();
    await waitListening(page);

    // A turn should still work after resume.
    await speechTurn(page, 1);
    await expect(page.getByRole('log')).toContainText('Turn 1:');

    await page.getByRole('button', { name: 'End session' }).click();
  });

  test('mute, text fallback, and end session', async ({ page }) => {
    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session' }).click();
    await waitListening(page);

    // Mute.
    await page.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(page.locator('.station-status')).toHaveText('Microphone muted');

    // Type and send a message while muted.
    await page.getByLabel('Type a message').fill('Hello from keyboard.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('Turn 1:');
    await expect(page.getByRole('log')).toContainText('Hello from keyboard.');

    // Unmute.
    await page.getByRole('button', { name: 'Unmute microphone' }).click();
    await expect(page.locator('.station-status')).toHaveText('Listening');

    // A speech turn should work after unmute.
    await speechTurn(page, 2);

    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();
  });
});

// ===========================================================================
// Production VAD / audio smoke — no injected factory
// ===========================================================================

test.describe('production VAD smoke', () => {
  test('WASM and audio startup without CSP or MIME errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.addInitScript(() => {
      const stats = {
        tracks: [] as MediaStreamTrack[],
        contexts: [] as AudioContext[],
      };
      const Native = window.AudioContext;
      window.AudioContext = class extends Native {
        constructor(opts?: AudioContextOptions) {
          super(opts);
          stats.contexts.push(this);
        }
      };
      const gum = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (c) => {
        const s = await gum(c);
        stats.tracks.push(...s.getTracks());
        return s;
      };
      (window as any).__vadStats = stats;
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Start session' }).click();

    // The real VAD loads WASM and opens the mic. Allow time for that, but
    // do not claim that the synthetic Chromium sine-wave establishes any
    // acoustic accuracy — this smoke test verifies WASM/CSP/MIME only.
    const status = page.locator('.station-status');
    try {
      await expect(status).toHaveText('Listening', { timeout: 20000 });
    } catch {
      // If the VAD failed to load, the client degrades to typed-only.
      // Verify that the degradation is clean (no crash, text still works).
      await expect(page.getByLabel('Type a message')).toBeEnabled({ timeout: 5000 });
    }

    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();

    // Verify audio resources are cleaned up.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as any).__vadStats.tracks.every(
              (t: MediaStreamTrack) => t.readyState === 'ended',
            ),
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (window as any).__vadStats.contexts.every(
              (c: AudioContext) => c.state === 'closed',
            ),
          ),
        { timeout: 10000 },
      )
      .toBe(true);

    // CSP violations or WASM loading errors would have been caught above.
    // Filter known non-error console noise before asserting.
    const real = errors.filter(
      (e) =>
        !e.includes('DevTools') &&
        !e.includes('favicon') &&
        !e.includes('Autofocus'),
    );
    expect(real).toEqual([]);
  });
});

// ===========================================================================
// Session security boundaries
// ===========================================================================

test.describe('session security', () => {
  test('different browser owner cannot claim active session', async ({
    browser,
  }) => {
    const ctx1 = await browser.newContext({
      baseURL: 'http://127.0.0.1:4318',
    });
    const ctx2 = await browser.newContext({
      baseURL: 'http://127.0.0.1:4318',
    });

    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await page1.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page2.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });

    // Owner 1 starts a session.
    await page1.goto('/');
    await page1.getByRole('button', { name: 'Start session' }).click();
    await waitListening(page1);

    // Owner 2 tries to start a session on the same server.
    await page2.goto('/');
    await page2.getByRole('button', { name: 'Start session' }).click();

    // The server must reject the second owner with a fatal session_busy error.
    await expect(page2.getByRole('status')).toContainText(
      'Another browser owns the active conversation',
      { timeout: 10000 },
    );

    // Owner 1's session should be unaffected.
    await expect(page1.locator('.station-status')).toHaveText('Listening');

    await page1.getByRole('button', { name: 'End session' }).click();
    await ctx1.close();
    await ctx2.close();
  });

  test('wrong session ID is rejected as expired', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Start session' })).toBeEnabled();

    // Attempt a WebSocket handshake with a nonexistent session ID.
    const result = await page.evaluate(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/session`);
          ws.onopen = () => {
            ws.send(
              JSON.stringify({
                type: 'hello',
                version: 2,
                sessionId: 'nonexistent-session-aaaa',
              }),
            );
          };
          ws.onmessage = (e) => {
            try {
              resolve(JSON.parse(e.data));
            } catch {
              resolve({ type: 'parse_error' });
            }
            ws.close();
          };
          ws.onclose = (e) => {
            if (e.code !== 1000)
              resolve({ type: 'closed', code: e.code, reason: e.reason });
          };
          ws.onerror = () => {};
          setTimeout(() => resolve({ type: 'timeout' }), 5000);
        }),
    );

    expect(result.type).toBe('error');
    expect(result.code).toBe('session_expired');
  });

  test('unauthorized origin receives 403 on bootstrap and upgrade', async ({
    request,
    page,
  }) => {
    // HTTP API: cross-origin bootstrap must be rejected.
    const bootstrap = await request.get('/api/bootstrap', {
      headers: { Origin: 'https://untrusted.example' },
    });
    expect(bootstrap.status()).toBe(403);

    // WebSocket upgrade from a fresh context with no cookies should fail.
    // We use a blank page so no bootstrap cookie is set.
    const ctx = page.context();
    const blank = await ctx.newPage();
    await blank.goto('about:blank');

    const wsResult = await blank.evaluate(
      (port) =>
        new Promise<string>((resolve) => {
          try {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
            ws.onopen = () => {
              ws.send(JSON.stringify({ type: 'hello', version: 2 }));
              ws.onmessage = (e) => {
                resolve(`message:${e.data}`);
                ws.close();
              };
            };
            ws.onclose = (e) => resolve(`closed:${e.code}`);
            ws.onerror = () => {};
            setTimeout(() => resolve('timeout'), 5000);
          } catch (err) {
            resolve(`error:${err}`);
          }
        }),
      4318,
    );

    // The connection should either fail outright (closed by server before
    // any message) or receive a fatal protocol error. The server rejects
    // unauthenticated upgrades with 403.
    expect(wsResult).toMatch(/^closed:/);

    await blank.close();
  });
});
