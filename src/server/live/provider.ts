import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import type { LiveCreateResponse, LiveCreateParams } from 'openai/resources/live/live';
import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';
import { GPT_LIVE_VOICE_MODEL } from '../../shared/gpt-live-trial.js';

export interface ProviderCreateResult {
  providerSessionId: string;
  answerSdp: string;
}

export interface ProviderEventHandler {
  onInputTranscript(delta: string): void;
  onOutputTranscript(delta: string): void;
  onDelegationCreated(delegationId: string, offsetMs: number): void;
  onUsageUpdate(seconds: number): void;
  onSessionClosed(reason: string, usage: { seconds: number }): void;
  onError(code: string, message: string): void;
}

export interface LiveProvider {
  createSession(offerSdp: string, instructions: string, clientEventRestrictions: string[]): Promise<ProviderCreateResult>;
  attachSideband(sessionId: string, handler: ProviderEventHandler): Promise<SidebandHandle>;
  sendThinking(content: string, delegationId: string | null): void;
  sendCommentary(content: string, delegationId: string | null): void;
  closeSession(): void;
  hangup(sessionId: string): Promise<void>;
  destroy(): void;
}

export interface SidebandHandle {
  close(): void;
}

export function createLiveProvider(apiKey: string, overrideClient?: OpenAI): LiveProvider {
  const client = overrideClient ?? new OpenAI({
    apiKey,
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
  });

  let sideband: SidebandWS | null = null;

  return {
    async createSession(offerSdp, instructions, clientEventRestrictions) {
      const params: LiveCreateParams = {
        session: {
          model: GPT_LIVE_VOICE_MODEL,
          delegation: { type: 'client' },
          instructions: instructions || undefined,
          client: {
            data_channel: {
              allowed_client_events: clientEventRestrictions,
            },
          },
        },
        transport: { type: 'webrtc', sdp: offerSdp },
      };

      const result: LiveCreateResponse = await client.live.create(params, { timeout: 15_000 });

      return {
        providerSessionId: result.session.id,
        answerSdp: result.transport.sdp,
      };
    },

    async attachSideband(sessionId, handler) {
      const ws = new SidebandWS(client, {
        session_id: sessionId,
        graceful_close: true,
      });

      sideband = ws;

      ws.on('session.input_transcript.delta', (event) => {
        handler.onInputTranscript(event.delta);
      });

      ws.on('session.output_transcript.delta', (event) => {
        handler.onOutputTranscript(event.delta);
      });

      ws.on('session.delegation.created', (event) => {
        handler.onDelegationCreated(event.delegation.id, event.offset_ms);
      });

      ws.on('session.usage.updated', (event) => {
        handler.onUsageUpdate(event.usage.seconds);
      });

      ws.on('session.closed', (event) => {
        handler.onSessionClosed(event.reason, event.usage);
      });

      ws.on('error', (err) => {
        handler.onError('sideband_error', err.message);
      });

      return {
        close() {
          ws.close({ code: 1000, reason: 'session ended' });
        },
      };
    },

    sendThinking(content, delegationId) {
      if (!sideband) return;
      sideband.send({
        type: 'session.thinking.append',
        content: content.slice(0, 2000),
        delegation_id: delegationId,
      });
    },

    sendCommentary(content, delegationId) {
      if (!sideband) return;
      sideband.send({
        type: 'session.commentary.append',
        content: content.slice(0, 2000),
        delegation_id: delegationId,
      });
    },

    closeSession() {
      if (!sideband) return;
      sideband.send({ type: 'session.close' });
    },

    async hangup(sessionId) {
      await client.live.sessions.hangup(sessionId, { timeout: 5_000 });
    },

    destroy() {
      if (sideband) {
        sideband.close({ code: 1000, reason: 'destroyed' });
        sideband = null;
      }
    },
  };
}
