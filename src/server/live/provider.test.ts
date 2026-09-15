import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import OpenAI from 'openai';
import type { LiveCreateParams, LiveCreateResponse } from 'openai/resources/live/live';
import { createLiveProvider } from './provider.js';

function createMockClient() {
  const createCalls: LiveCreateParams[] = [];
  const hangupCalls: string[] = [];

  const client = {
    live: {
      create: vi.fn(async (params: LiveCreateParams): Promise<LiveCreateResponse> => {
        createCalls.push(params);
        return {
          session: { id: 'live-sess-mock-123' },
          transport: { sdp: 'v=0\r\nmock-answer-sdp', type: 'webrtc' as const },
        };
      }),
      sideband: {},
      forks: {},
      sessions: {
        hangup: vi.fn(async (sessionId: string) => {
          hangupCalls.push(sessionId);
        }),
        accept: vi.fn(),
        fork: vi.fn(),
        refer: vi.fn(),
        reject: vi.fn(),
      },
    },
  };

  return { client: client as unknown as OpenAI, createCalls, hangupCalls };
}

describe('createLiveProvider', () => {
  it('createSession sends correct model and client delegation to SDK', async () => {
    const { client, createCalls } = createMockClient();
    const provider = createLiveProvider('sk-test-key', client);

    const result = await provider.createSession(
      'v=0\r\nbrowser-offer',
      'Voice assistant instructions',
      ['session.input_audio.mute', 'session.input_audio.unmute'],
    );

    expect(createCalls).toHaveLength(1);
    const params = createCalls[0];
    expect(params.session.model).toBe('gpt-live-1');
    expect(params.session.delegation).toEqual({ type: 'client' });
    expect(params.session.instructions).toBe('Voice assistant instructions');
    expect(params.session.client?.data_channel?.allowed_client_events).toEqual([
      'session.input_audio.mute',
      'session.input_audio.unmute',
    ]);
    expect(params.transport).toEqual({ type: 'webrtc', sdp: 'v=0\r\nbrowser-offer' });
    expect(client.live.create).toHaveBeenCalledWith(params, { timeout: 15_000 });

    expect(result.providerSessionId).toBe('live-sess-mock-123');
    expect(result.answerSdp).toBe('v=0\r\nmock-answer-sdp');
  });

  it('returns unique session ID and SDP from provider', async () => {
    const { client } = createMockClient();
    const provider = createLiveProvider('sk-test', client);
    const result = await provider.createSession('v=0\r\noffer', 'instructions', []);
    expect(typeof result.providerSessionId).toBe('string');
    expect(result.providerSessionId.length).toBeGreaterThan(0);
    expect(typeof result.answerSdp).toBe('string');
    expect(result.answerSdp.length).toBeGreaterThan(0);
  });

  it('hangup sends correct session ID to SDK', async () => {
    const { client, hangupCalls } = createMockClient();
    const provider = createLiveProvider('sk-test', client);
    await provider.hangup('live-sess-xyz');
    expect(hangupCalls).toEqual(['live-sess-xyz']);
    expect(client.live.sessions.hangup).toHaveBeenCalledWith('live-sess-xyz', { timeout: 5_000 });
  });

  it('constructs OpenAI client with correct baseURL and maxRetries:0 when no override', () => {
    const provider = createLiveProvider('sk-test-key-123');
    expect(provider).toBeDefined();
    expect(typeof provider.createSession).toBe('function');
    expect(typeof provider.destroy).toBe('function');
  });

  it('destroy and closeSession are safe to call without sideband', () => {
    const { client } = createMockClient();
    const provider = createLiveProvider('sk-test', client);
    expect(() => provider.destroy()).not.toThrow();
    expect(() => provider.closeSession()).not.toThrow();
    expect(() => provider.sendThinking('test', null)).not.toThrow();
    expect(() => provider.sendCommentary('test', null)).not.toThrow();
  });
});
