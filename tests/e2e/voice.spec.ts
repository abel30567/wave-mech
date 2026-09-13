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
    const state = { mode: 'paused', closed: false, modes: [], playbackPaused: false, finishCalls: 0 };
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
      setPlaybackPaused(value) { state.playbackPaused = value; },
      discontinuity()    { options.onDiscontinuity(); },
      error(msg)         { options.onError(msg); },
      getState()         { return state; },
    };
    return {
      setMode(m) { state.mode = m; state.modes.push(m); },
      flushInput()   { return Promise.resolve(); },
      clearInput()   {},
      enqueueOutput(){},
      finishOutput() { state.finishCalls++; return Promise.resolve(state.playbackPaused ? 'paused' : 'played'); },
      cancelOutput() {},
      resume()       { state.playbackPaused = false; return Promise.resolve(); },
      close()        { state.closed = true; return Promise.resolve(); },
    };
  };
})();`;

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return;
  // Reclaim only this browser owner's retained fixture session after a failure.
  // A missing owner cookie is rejected; no privileged reset endpoint is used.
  await page.evaluate(async () => {
    if (!location.host) return;
    await new Promise<void>(resolve => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/session`);
      const timer = setTimeout(() => { socket.close(); resolve(); }, 2500);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', version: 2 }));
      socket.onmessage = event => {
        try { if (JSON.parse(event.data).type === 'snapshot') socket.send(JSON.stringify({ type: 'end' })); } catch { /* no data to clean up */ }
      };
      socket.onclose = socket.onerror = () => { clearTimeout(timer); resolve(); };
    });
  }).catch(() => {});
});

async function waitListening(page: Page) {
  await expect(page.locator('.station-status')).toHaveText('Listening', { timeout: 15000 });
}

async function speechTurn(page: Page, turn: number) {
  await page.evaluate(() => (window as any).__waveTestControl.speechStart());
  for (let i = 0; i < 5; i++)
    await page.evaluate(() => (window as any).__waveTestControl.emitPcm(3200));
  await page.evaluate(() => (window as any).__waveTestControl.speechEnd());
  await expect(page.getByRole('log')).toContainText(`Turn ${turn}:`, { timeout: 15000 });
  await waitListening(page);
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

  test('finishes an utterance that ends while its socket is offline', async ({ page }) => {
    let acknowledgements = 0;
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      try { if (JSON.parse(payload.toString()).type === 'audio_ack') acknowledgements++; } catch { /* binary */ }
    }));
    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session' }).click();
    await waitListening(page);
    await page.evaluate(() => {
      (window as any).__waveTestControl.speechStart();
      (window as any).__waveTestControl.emitPcm(3200);
    });
    await expect.poll(() => acknowledgements).toBeGreaterThan(0);
    await page.evaluate(() => {
      (window as any).__waveSockets.find((socket: WebSocket) => socket.readyState === WebSocket.OPEN)?.close();
    });
    await expect(page.locator('.station-status')).toContainText('Reconnecting');
    await page.evaluate(() => {
      (window as any).__waveTestControl.emitPcm(3200);
      (window as any).__waveTestControl.speechEnd();
    });
    await expect(page.getByRole('log')).toContainText('Turn 1:', { timeout: 15000 });
    await waitListening(page);
    await speechTurn(page, 2);
    await waitListening(page);
    const text = await page.getByRole('log').innerText();
    expect((text.match(/Turn 1:/g) ?? []).length).toBe(1);
    expect((text.match(/Turn 2:/g) ?? []).length).toBe(1);
    await page.getByRole('button', { name: 'End session' }).click();
  });

  test('resuming a paused response completes its acknowledgement and permits the next turn', async ({ page }) => {
    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session' }).click();
    await waitListening(page);
    await page.evaluate(() => {
      const control = (window as any).__waveTestControl;
      control.speechStart(); control.emitPcm(3200);
      control.setPlaybackPaused(true); control.speechEnd();
    });
    await expect(page.getByRole('log')).toContainText('Turn 1:');
    await expect(page.getByRole('button', { name: 'Resume audio' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume audio' }).click();
    await waitListening(page);
    expect(await page.evaluate(() => (window as any).__waveTestControl.getState().finishCalls)).toBeGreaterThanOrEqual(2);
    await speechTurn(page, 2);
    await waitListening(page);
    await page.getByRole('button', { name: 'End session' }).click();
  });

  for (const delayMs of [2000, 5000]) {
    test(`retains the recording through a ${delayMs}ms acknowledgement stall`, async ({ page }) => {
      let withholding = true;
      let prematureFinish = false;
      const acknowledgements: Array<() => void> = [];
      await page.routeWebSocket('**/session', route => {
        const upstream = route.connectToServer();
        route.onMessage(message => {
          try { if (typeof message === 'string' && JSON.parse(message).type === 'finish' && withholding) prematureFinish = true; } catch { /* audio */ }
          upstream.send(message);
        });
        upstream.onMessage(message => {
          let ack = false;
          try { ack = JSON.parse(message.toString()).type === 'audio_ack'; } catch { /* non-JSON */ }
          if (ack && withholding) acknowledgements.push(() => route.send(message));
          else route.send(message);
        });
      });
      await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
      await page.goto('/');
      await page.getByRole('button', { name: 'Start session' }).click();
      await waitListening(page);
      await page.evaluate(() => {
        (window as any).__waveTestControl.speechStart();
        (window as any).__waveTestControl.emitPcm(3200);
      });
      await expect.poll(() => acknowledgements.length).toBeGreaterThan(0);
      const started = Date.now();
      while (Date.now() - started < delayMs - 250) {
        await page.evaluate(() => (window as any).__waveTestControl.emitPcm(3200));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await page.evaluate(() => (window as any).__waveTestControl.speechEnd());
      await new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs - (Date.now() - started))));
      expect(prematureFinish).toBe(false);
      withholding = false;
      for (const release of acknowledgements.splice(0)) release();
      await expect(page.getByRole('log')).toContainText('Turn 1:', { timeout: 15000 });
      await waitListening(page);
      await speechTurn(page, 2);
      await waitListening(page);
      expect((await page.getByRole('log').innerText()).match(/Turn 1:/g)).toHaveLength(1);
      await page.getByRole('button', { name: 'End session' }).click();
    });
  }

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

test.describe('copy conversation diagnostics', () => {
  test('copies real tool failures after End and clears history for a new session', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { (window as any).__copiedReport = text; },
      } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await waitListening(page);
    await page.getByLabel('Type a message', { exact: true }).fill('Run the debug fixture.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('log')).toContainText('Turn 1:');
    await waitListening(page);
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    const copy = page.getByRole('button', { name: 'Copy transcript', exact: true });
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(page.getByText('Copied conversation and diagnostics. Review before sharing.')).toBeVisible();
    const report = await page.evaluate(() => (window as any).__copiedReport as string);
    for (const term of ['Run the debug fixture.', 'CONVERSATION', 'DIAGNOSTICS', 'mcp__fermi__execute', 'toolu_debug_1', 'authentication', 'synthetic test']) expect(report).toContain(term);
    expect(report).toContain('"status":"failed"');
    expect(report).not.toContain('SECRET_SENTINEL');
    const box = await copy.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
    await page.screenshot({ path: 'artifacts/copy-transcript-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await waitListening(page);
    await copy.click();
    const next = await page.evaluate(() => (window as any).__copiedReport as string);
    expect(next).not.toContain('Run the debug fixture.');
    expect(next).not.toContain('toolu_debug_1');
    await page.getByRole('button', { name: 'End session', exact: true }).click();
  });

  test('provides a selectable report when clipboard permission is denied', async ({ page }) => {
    await page.addInitScript({ content: CONTROLLED_AUDIO_SCRIPT });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
      } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await waitListening(page);
    await speechTurn(page, 1);
    await page.getByRole('button', { name: 'End session', exact: true }).click();
    await page.getByRole('button', { name: 'Copy transcript', exact: true }).click();
    await expect(page.getByText('Clipboard unavailable. Select and copy the report below.')).toBeVisible();
    const report = page.getByLabel('Conversation and diagnostics — review before sharing', { exact: true });
    await expect(report).toHaveValue(/Turn 1:/);
    await report.focus();
    expect(await report.evaluate((element: HTMLTextAreaElement) => element.selectionStart === 0 && element.selectionEnd === element.value.length)).toBe(true);
    await page.screenshot({ path: 'artifacts/copy-transcript-fallback.png', fullPage: true });
    await page.getByRole('button', { name: 'Hide report', exact: true }).click();
    await expect(report).toHaveCount(0);
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
    await expect(status).toHaveText('Listening', { timeout: 20000 });
    await expect.poll(() => page.evaluate(() => ({
      tracks: (window as any).__vadStats.tracks.length,
      contexts: (window as any).__vadStats.contexts.length,
    })), { timeout: 10000 }).toEqual({ tracks: 1, contexts: 1 });

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
