import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrokerTokenProvider, createElevenLabsTokenProvider } from '../../src/server/speech-broker.js';

afterEach(() => vi.unstubAllGlobals());

describe('server-side ElevenLabs key', () => {
  it('mints both short-lived token types only at the fixed provider endpoint', async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ token: 'short-lived-fixture' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const getToken = createElevenLabsTokenProvider('server-only-test-key');
    await expect(getToken('realtime_scribe')).resolves.toBe('short-lived-fixture');
    await expect(getToken('tts_websocket')).resolves.toBe('short-lived-fixture');
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe',
      'https://api.elevenlabs.io/v1/single-use-token/tts_websocket',
    ]);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST', redirect: 'error', headers: { 'xi-api-key': 'server-only-test-key' },
    });
  });

  it('does not expose provider errors or the server key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-canary-server-key', { status: 401 })));
    const getToken = createElevenLabsTokenProvider('secret-canary-server-key');
    await expect(getToken('realtime_scribe')).rejects.toThrow('failed (401)');
    await expect(getToken('realtime_scribe')).rejects.not.toThrow('secret-canary');
  });

  it('rejects empty keys and invalid token responses', async () => {
    expect(() => createElevenLabsTokenProvider(' ')).toThrow(/required/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    await expect(createElevenLabsTokenProvider('fixture-key')('tts_websocket')).rejects.toThrow(/failed/);
  });
});

describe('operator-configured speech broker adapter', () => {
  it('requires an explicit token-type route rather than guessing a Fermi URL', () => {
    expect(() => createBrokerTokenProvider({ urlTemplate: 'https://broker.example/token' })).toThrow(/placeholder/);
  });

  it('requests a fresh server-side token and refuses redirects', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'short-lived-test-token' }) });
    vi.stubGlobal('fetch', fetch);
    const getToken = createBrokerTokenProvider({ urlTemplate: 'https://broker.example/tokens/{type}', authorization: 'Bearer server-only-test' });
    expect(await getToken('realtime_scribe')).toBe('short-lived-test-token');
    expect(await getToken('tts_websocket')).toBe('short-lived-test-token');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0].toString()).toBe('https://broker.example/tokens/realtime_scribe');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer server-only-test' } });
  });

  it('does not expose underlying credential-bearing errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-canary-in-upstream-url')));
    const getToken = createBrokerTokenProvider({ urlTemplate: 'https://broker.example/{type}' });
    await expect(getToken('realtime_scribe')).rejects.toThrow('Speech token broker unavailable');
    await expect(getToken('realtime_scribe')).rejects.not.toThrow('secret-canary');
  });

  it('rejects cleartext remote URLs before sending any authorization', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const getToken = createBrokerTokenProvider({ urlTemplate: 'http://broker.example/{type}', authorization: 'Bearer server-only-test' });
    await expect(getToken('tts_websocket')).rejects.toThrow(/HTTPS/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
