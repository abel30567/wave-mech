import { expect, test, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Browser-side mock: RTCPeerConnection, getUserMedia control, autoplay control.
// Sets window.__gptLiveMock for test orchestration of data-channel events,
// ICE state, and cleanup verification.
// ---------------------------------------------------------------------------
const GPT_LIVE_MOCK = `(() => {
  const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const _streams = [];
  let _gumMode = 'normal';
  let _gumPending = null;

  navigator.mediaDevices.getUserMedia = async function(constraints) {
    if (_gumMode === 'delayed') {
      return new Promise((resolve, reject) => {
        _gumPending = { resolve, reject, constraints };
      });
    }
    const stream = await _origGUM(constraints);
    _streams.push(stream);
    return stream;
  };

  const _pcs = [];

  class _MockDC {
    constructor(label, opts) {
      this.label = label;
      this.readyState = 'open';
      this.ordered = opts?.ordered ?? true;
      this.onmessage = null;
      this.onopen = null;
      this.onclose = null;
    }
    send() {}
    close() { this.readyState = 'closed'; }
  }

  class _MockPC {
    constructor() {
      this.iceConnectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.ontrack = null;
      this.oniceconnectionstatechange = null;
      this._channels = [];
      this._closed = false;
      _pcs.push(this);
    }
    addTrack() {}
    addTransceiver() { return {}; }
    createOffer() {
      return Promise.resolve({ type: 'offer', sdp: 'v=0\\r\\nmock-offer\\r\\n' });
    }
    setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
    setRemoteDescription(d) { this.remoteDescription = d; return Promise.resolve(); }
    createDataChannel(label, opts) {
      const dc = new _MockDC(label, opts);
      this._channels.push(dc);
      return dc;
    }
    close() {
      this._closed = true;
      this.iceConnectionState = 'closed';
    }
  }

  window.RTCPeerConnection = _MockPC;

  let _autoplayBlocked = false;
  const _origPlay = HTMLAudioElement.prototype.play;
  HTMLAudioElement.prototype.play = function() {
    if (_autoplayBlocked) {
      return Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    }
    return Promise.resolve();
  };

  window.__gptLiveMock = {
    get pcs() { return _pcs; },
    get streams() { return _streams; },

    latestPC() { return _pcs[_pcs.length - 1] || null; },

    emitSessionStarted() {
      const pc = this.latestPC();
      if (!pc) return false;
      const dc = pc._channels.find(function(c) { return c.label === 'oai-events'; });
      if (!dc || !dc.onmessage) return false;
      dc.onmessage({ data: JSON.stringify({ type: 'session.started' }) });
      return true;
    },

    setIceState(state) {
      const pc = this.latestPC();
      if (!pc) return;
      pc.iceConnectionState = state;
      if (pc.oniceconnectionstatechange) {
        pc.oniceconnectionstatechange(new Event('iceconnectionstatechange'));
      }
    },

    fireOnTrack() {
      const pc = this.latestPC();
      if (!pc || !pc.ontrack) return;
      pc.ontrack({ streams: [new MediaStream()], track: null });
    },

    setAutoplayBlocked(v) { _autoplayBlocked = v; },
    setGumMode(m) { _gumMode = m; },

    resolveGum() {
      if (!_gumPending) return;
      var p = _gumPending;
      _gumPending = null;
      _origGUM(p.constraints).then(function(s) { _streams.push(s); p.resolve(s); }, p.reject);
    },

    isPCClosed() { var pc = this.latestPC(); return pc ? pc._closed : false; },

    allTracksStopped() {
      return _streams.length > 0 && _streams.every(function(s) {
        return s.getTracks().every(function(t) { return t.readyState === 'ended'; });
      });
    },

    pcCount() { return _pcs.length; },

    hasDC() {
      var pc = this.latestPC();
      return pc ? pc._channels.length > 0 : false;
    },
  };
})();`;

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

interface RouteState {
  sessionCalls: number;
  endCalls: number;
}

async function setupGptLiveRoutes(
  page: Page,
  opts: {
    closureConfirmed?: boolean | null;
    delaySession?: () => Promise<void>;
    diagTranscript?: Array<{ role: string; text: string; source: string; timestampMs: number }>;
  } = {},
): Promise<RouteState> {
  const state: RouteState = { sessionCalls: 0, endCalls: 0 };

  await page.route('**/api/bootstrap', async route => {
    const resp = await route.fetch();
    const body = await resp.json();
    body.gptLiveTrial = {
      enabled: true,
      hasApiKey: true,
      budgetRemainingUsd: 5.0,
      maxSessionSeconds: 300,
    };
    await route.fulfill({ response: resp, body: JSON.stringify(body) });
  });

  await page.route('**/api/gpt-live/session', async route => {
    state.sessionCalls++;
    if (opts.delaySession) await opts.delaySession();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: `test-session-${state.sessionCalls}`,
        sdp: 'v=0\r\nmock-answer\r\n',
      }),
    });
  });

  await page.route('**/api/gpt-live/end', async route => {
    state.endCalls++;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ended: true }),
    });
  });

  await page.route('**/api/gpt-live/diagnostics', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'test-session-1',
        voiceModel: 'gpt-live-1',
        backendModel: 'claude-opus-4-6[1m]',
        cumulativeVoiceSeconds: 12.5,
        estimatedCostUsd: 0.0104,
        closureConfirmed: opts.closureConfirmed !== undefined ? opts.closureConfirmed : true,
        closureReason: 'user_ended',
        delegationsProcessed: 1,
        delegationsSkipped: 0,
        transcript: opts.diagTranscript ?? [
          { role: 'user', text: 'Hello test', source: 'voice-model', timestampMs: 1000 },
          { role: 'assistant', text: 'Test response', source: 'voice-model', timestampMs: 2000 },
        ],
      }),
    });
  });

  return state;
}

async function waitForDC(page: Page) {
  await expect.poll(
    () => page.evaluate(() => (window as any).__gptLiveMock.hasDC()),
    { timeout: 5000 },
  ).toBe(true);
}

// ===========================================================================
// GPT-Live trial panel
// ===========================================================================

test.describe('GPT-Live trial panel', () => {

  test('successful start, session.started, mute, and End lifecycle', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.addInitScript({ content: GPT_LIVE_MOCK });
    const routes = await setupGptLiveRoutes(page);
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Voice: gpt-live-1')).toBeVisible();
    await expect(panel.getByText('Backend: Claude Code')).toBeVisible();

    // Start
    const startBtn = panel.getByRole('button', { name: 'Start GPT-Live trial' });
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    // Wait for DC to be created (session fetch complete)
    await waitForDC(page);
    expect(routes.sessionCalls).toBe(1);

    // Emit session.started
    await page.evaluate(() => (window as any).__gptLiveMock.emitSessionStarted());

    // Verify active phase
    const muteBtn = panel.getByRole('button', { name: 'Mute' });
    await expect(muteBtn).toBeVisible();
    const endBtn = panel.getByRole('button', { name: 'End trial session' });
    await expect(endBtn).toBeVisible();

    // Mute
    await muteBtn.click();
    await expect(panel.getByRole('button', { name: 'Unmute' })).toBeVisible();
    // Verify End is still shown (mute is not session termination)
    await expect(endBtn).toBeVisible();

    // Unmute
    await panel.getByRole('button', { name: 'Unmute' }).click();
    await expect(muteBtn).toBeVisible();

    // End
    await endBtn.click();
    await expect(panel.getByRole('button', { name: 'Reset' })).toBeVisible({ timeout: 5000 });
    expect(routes.endCalls).toBe(1);

    // Verify cleanup: PC closed and tracks stopped
    const pcClosed = await page.evaluate(() => (window as any).__gptLiveMock.isPCClosed());
    expect(pcClosed).toBe(true);
    const stopped = await page.evaluate(() => (window as any).__gptLiveMock.allTracksStopped());
    expect(stopped).toBe(true);

    // Copy diagnostics available
    await expect(panel.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('End before getUserMedia resolves fences stale session creation', async ({ page }) => {
    await page.addInitScript({ content: GPT_LIVE_MOCK });
    const routes = await setupGptLiveRoutes(page);
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');

    // Delay getUserMedia
    await page.evaluate(() => (window as any).__gptLiveMock.setGumMode('delayed'));

    // Start — enters connecting
    await panel.getByRole('button', { name: 'Start GPT-Live trial' }).click();
    // End button should be available during connecting
    const endBtn = panel.getByRole('button', { name: 'End trial session' });
    await expect(endBtn).toBeVisible({ timeout: 3000 });

    // Click End before getUserMedia resolves
    await endBtn.click();

    // Should return to idle (no session was created)
    await expect(panel.getByRole('button', { name: 'Start GPT-Live trial' })).toBeVisible({ timeout: 5000 });

    // Now resolve getUserMedia — the stream should be stopped by the fence
    await page.evaluate(() => (window as any).__gptLiveMock.resolveGum());
    // Small wait for the async fence handling
    await page.waitForTimeout(200);

    const stopped = await page.evaluate(() => (window as any).__gptLiveMock.allTracksStopped());
    expect(stopped).toBe(true);

    // No session POST should have been made
    expect(routes.sessionCalls).toBe(0);
  });

  test('End during server session creation cleans up created session', async ({ page }) => {
    let resolveSession: (() => void) | undefined;
    const sessionGate = () => new Promise<void>(r => { resolveSession = r; });

    await page.addInitScript({ content: GPT_LIVE_MOCK });
    const routes = await setupGptLiveRoutes(page, { delaySession: sessionGate });
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');
    await panel.getByRole('button', { name: 'Start GPT-Live trial' }).click();

    // Wait for the fetch to be in-flight (session route handler is blocking)
    await expect.poll(() => routes.sessionCalls, { timeout: 5000 }).toBe(1);

    // Click End while fetch is pending
    await panel.getByRole('button', { name: 'End trial session' }).click();

    // Release the session response
    resolveSession!();

    // Wait for cleanup — the fence should detect stale gen and call /end
    await expect.poll(() => routes.endCalls, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

    // Panel should be in ended or idle state (not stuck in connecting)
    await expect(panel.getByRole('button', { name: /Start GPT-Live|Reset/ })).toBeVisible({ timeout: 5000 });
  });

  test('provider closure unknown shows honest finalization status', async ({ page }) => {
    await page.addInitScript({ content: GPT_LIVE_MOCK });
    await setupGptLiveRoutes(page, { closureConfirmed: null });
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');
    await panel.getByRole('button', { name: 'Start GPT-Live trial' }).click();
    await waitForDC(page);
    await page.evaluate(() => (window as any).__gptLiveMock.emitSessionStarted());
    await expect(panel.getByRole('button', { name: 'End trial session' })).toBeVisible();

    // End session
    await panel.getByRole('button', { name: 'End trial session' }).click();

    // Should show pending/unknown finalization, not just re-enabled Start
    await expect(panel.getByText('Session finalization is pending. Usage status unknown.')).toBeVisible({ timeout: 5000 });
    await expect(panel.getByRole('button', { name: 'Reset' })).toBeVisible();
  });

  test('ICE connection loss triggers bounded cleanup', async ({ page }) => {
    await page.addInitScript({ content: GPT_LIVE_MOCK });
    const routes = await setupGptLiveRoutes(page);
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');
    await panel.getByRole('button', { name: 'Start GPT-Live trial' }).click();
    await waitForDC(page);
    await page.evaluate(() => (window as any).__gptLiveMock.emitSessionStarted());
    await expect(panel.getByRole('button', { name: 'Mute' })).toBeVisible();

    // Simulate ICE disconnection
    await page.evaluate(() => (window as any).__gptLiveMock.setIceState('disconnected'));

    // Should trigger end and cleanup
    await expect(panel.getByRole('button', { name: 'Reset' })).toBeVisible({ timeout: 5000 });
    expect(routes.endCalls).toBeGreaterThanOrEqual(1);

    const pcClosed = await page.evaluate(() => (window as any).__gptLiveMock.isPCClosed());
    expect(pcClosed).toBe(true);
  });

  test('audio autoplay rejection shows Resume, Resume clears block', async ({ page }) => {
    await page.addInitScript({ content: GPT_LIVE_MOCK });
    await setupGptLiveRoutes(page);
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');

    // Block autoplay before starting
    await page.evaluate(() => (window as any).__gptLiveMock.setAutoplayBlocked(true));

    await panel.getByRole('button', { name: 'Start GPT-Live trial' }).click();
    await waitForDC(page);
    await page.evaluate(() => (window as any).__gptLiveMock.emitSessionStarted());
    await expect(panel.getByRole('button', { name: 'Mute' })).toBeVisible();

    // Fire ontrack to trigger autoplay attempt
    await page.evaluate(() => (window as any).__gptLiveMock.fireOnTrack());

    // Resume audio button should appear
    await expect(panel.getByRole('button', { name: 'Resume audio' })).toBeVisible({ timeout: 3000 });

    // Unblock autoplay and click Resume
    await page.evaluate(() => (window as any).__gptLiveMock.setAutoplayBlocked(false));
    await panel.getByRole('button', { name: 'Resume audio' }).click();

    // Resume button should disappear
    await expect(panel.getByRole('button', { name: 'Resume audio' })).toBeHidden({ timeout: 3000 });

    // Session should still be active
    await expect(panel.getByRole('button', { name: 'Mute' })).toBeVisible();

    await panel.getByRole('button', { name: 'End trial session' }).click();
  });

  test('diagnostics report privacy: excludes SDP/ICE/keys, preserves transcript after End', async ({ page }) => {
    const secretTranscript = [
      { role: 'user', text: 'Hello from voice', source: 'voice-model', timestampMs: 1000 },
      { role: 'assistant', text: 'Here is the response', source: 'voice-model', timestampMs: 2000 },
      { role: 'system', text: 'v=0\r\no=- 123 IN IP4 127.0.0.1\r\na=ice-ufrag:secret', source: 'voice-model', timestampMs: 3000 },
      { role: 'system', text: 'sk-proj-AAAAAAAAAAAABBBB secret key', source: 'voice-model', timestampMs: 4000 },
      { role: 'assistant', text: 'Backend completed task', source: 'backend', timestampMs: 5000 },
    ];

    await page.addInitScript({ content: GPT_LIVE_MOCK });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async (text: string) => { (window as any).__copiedReport = text; },
      } });
    });
    await setupGptLiveRoutes(page, { diagTranscript: secretTranscript });
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');
    await panel.getByRole('button', { name: 'Start GPT-Live trial' }).click();
    await waitForDC(page);
    await page.evaluate(() => (window as any).__gptLiveMock.emitSessionStarted());
    await expect(panel.getByRole('button', { name: 'End trial session' })).toBeVisible();

    await panel.getByRole('button', { name: 'End trial session' }).click();
    await expect(panel.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible({ timeout: 5000 });

    // Copy diagnostics
    await panel.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(panel.getByText('Copied diagnostics. Review before sharing.')).toBeVisible({ timeout: 3000 });

    const report = await page.evaluate(() => (window as any).__copiedReport as string);

    // Report must contain diagnostic fields and safe transcript
    expect(report).toContain('Voice model: gpt-live-1');
    expect(report).toContain('Backend model: claude-opus-4-6[1m]');
    expect(report).toContain('Closure confirmed: true');
    expect(report).toContain('Review before sharing');
    expect(report).toContain('Hello from voice');
    expect(report).toContain('Backend completed task');
    expect(report).toContain('TRANSCRIPT');

    // Report must NOT contain raw SDP, ICE, or keys
    expect(report).not.toContain('ice-ufrag');
    expect(report).not.toContain('sk-proj-');
    expect(report).not.toContain('AAAAAAAAAAAABBBB');
  });

  test('clipboard fallback when clipboard is denied', async ({ page }) => {
    await page.addInitScript({ content: GPT_LIVE_MOCK });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); },
      } });
    });
    await setupGptLiveRoutes(page);
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');
    await panel.getByRole('button', { name: 'Start GPT-Live trial' }).click();
    await waitForDC(page);
    await page.evaluate(() => (window as any).__gptLiveMock.emitSessionStarted());
    await expect(panel.getByRole('button', { name: 'End trial session' })).toBeVisible();

    await panel.getByRole('button', { name: 'End trial session' }).click();
    await expect(panel.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible({ timeout: 5000 });

    // Click Copy — should show fallback textarea
    await panel.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(panel.getByText('Clipboard unavailable. Select and copy the report below.')).toBeVisible({ timeout: 3000 });

    const report = panel.getByLabel('GPT-Live diagnostics — review before sharing');
    await expect(report).toBeVisible();
    await expect(report).toHaveValue(/Voice model: gpt-live-1/);
    await expect(report).toHaveValue(/Review before sharing/);

    // Focus selects all
    await report.focus();
    const selected = await report.evaluate((el: HTMLTextAreaElement) =>
      el.selectionStart === 0 && el.selectionEnd === el.value.length,
    );
    expect(selected).toBe(true);

    // Hide report
    await panel.getByRole('button', { name: 'Hide report' }).click();
    await expect(report).toBeHidden();
  });

  test('double Start click does not create multiple sessions', async ({ page }) => {
    await page.addInitScript({ content: GPT_LIVE_MOCK });
    const routes = await setupGptLiveRoutes(page);
    await page.goto('/');

    const panel = page.locator('[data-testid="gpt-live-panel"]');
    await expect(panel.getByRole('button', { name: 'Start GPT-Live trial' })).toBeEnabled();

    // Double-click synchronously via DOM to beat React re-render
    await page.evaluate(() => {
      const btn = document.querySelector('.gpt-live-start') as HTMLElement;
      if (btn) { btn.click(); btn.click(); }
    });

    // Wait for session to complete
    await waitForDC(page);

    // Only one session POST should have been made
    expect(routes.sessionCalls).toBe(1);
    expect(await page.evaluate(() => (window as any).__gptLiveMock.pcCount())).toBe(1);

    await page.evaluate(() => (window as any).__gptLiveMock.emitSessionStarted());
    await panel.getByRole('button', { name: 'End trial session' }).click();
    await expect(panel.getByRole('button', { name: 'Reset' })).toBeVisible({ timeout: 5000 });
  });
});
