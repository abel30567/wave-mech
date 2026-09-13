import type { HarnessEvent, HarnessSession, SpeechSession } from './contracts.js';

export const REALTIME_VERSION = 2;
export const PCM_RATE = 16000;
export const OUTSTANDING_AUDIO_BYTES = 256000;
export const PREROLL_MS = 640;
export const PREROLL_BYTES = PCM_RATE * 2 * PREROLL_MS / 1000;
export const PRODUCER_AUDIO_BYTES = 16384;
export const TRANSPORT_AUDIO_BYTES = OUTSTANDING_AUDIO_BYTES - PREROLL_BYTES - PRODUCER_AUDIO_BYTES;
export const MAX_AUDIO_SEQUENCE = 8192;
export const SESSION_GRACE_MS = 120000;

export type ConversationPhase = 'idle' | 'opening-input' | 'recording' | 'thinking' | 'speaking' | 'interrupting' | 'paused' | 'closed';
export type ToolStatus = 'running' | 'done' | 'failed' | 'denied';
export interface TranscriptEntry { turnId: number; role: 'user' | 'assistant'; text: string }
export interface AudioFrame { turnId: number; seq: number; pcm: Uint8Array }
export interface InputProgress { turnId: number; lastSeq: number; committed: boolean }
export interface ResponseProgress { turnId: number; responseId: number; lastAudioSeq: number; finished: boolean; audioInterrupted: boolean }
export interface ToolCapabilities { web: boolean; fermi: 'pending' | 'connected' | 'unavailable'; tools: string[] }
export interface ConversationSnapshot {
  sessionId: string;
  mode: 'live' | 'fixture';
  phase: ConversationPhase;
  speechAvailable: boolean;
  lastTurnId: number;
  messages: TranscriptEntry[];
  input?: InputProgress;
  response?: ResponseProgress;
  capabilities?: ToolCapabilities;
  notice?: string;
}

export type RealtimeCommand =
  | { type: 'hello'; version: 2; sessionId?: string }
  | { type: 'record'; turnId: number }
  | { type: 'finish'; turnId: number; lastSeq: number }
  | { type: 'text'; turnId: number; text: string }
  | { type: 'abort_input'; turnId: number; reason: 'overflow' | 'muted' | 'interrupted' | 'discontinuity' }
  | { type: 'interrupt'; responseId: number }
  | { type: 'playback_done'; responseId: number; lastSeq: number; skipped?: boolean }
  | { type: 'ping'; id: number }
  | { type: 'end' };

export type RealtimeEvent =
  | { type: 'snapshot'; snapshot: ConversationSnapshot }
  | { type: 'state'; phase: ConversationPhase }
  | { type: 'input_ready'; turnId: number }
  | { type: 'audio_ack'; turnId: number; seq: number }
  | { type: 'input_aborted'; turnId: number; reason: string }
  | { type: 'partial'; turnId: number; text: string }
  | { type: 'user'; turnId: number; text: string }
  | { type: 'text'; turnId: number; responseId: number; text: string }
  | { type: 'audio'; turnId: number; responseId: number; seq: number; audio: string; sampleRate: number }
  | { type: 'response_done'; turnId: number; responseId: number; lastAudioSeq: number }
  | { type: 'response_cancelled'; responseId: number }
  | { type: 'tool'; responseId: number; name: string; status: ToolStatus }
  | { type: 'capabilities'; capabilities: ToolCapabilities }
  | { type: 'notice'; code: string; message: string }
  | { type: 'error'; code: string; message: string; fatal: boolean }
  | { type: 'pong'; id: number }
  | { type: 'ended' };

export interface RealtimeHarness extends HarnessSession { interrupt(): Promise<void> }
export interface RealtimeSpeech extends Omit<SpeechSession, 'writeAudio'> {
  writeAudio(pcm: Uint8Array): boolean;
  abortRecognition(): void;
  cancelSpeech(): void;
}
export interface ConversationOptions {
  id: string;
  mode: 'live' | 'fixture';
  harness(onEvent: (event: HarnessEvent) => void): RealtimeHarness;
  speech?: (callbacks: {
    onPartial(text: string): void;
    onAudio(audio: string, sampleRate: number): void;
    onError(message: string): void;
  }) => RealtimeSpeech;
  now?: () => number;
}
export interface RetainedConversation {
  readonly id: string;
  start(): Promise<void>;
  attach(send: (event: RealtimeEvent) => void): void;
  detach(): void;
  handle(command: RealtimeCommand): Promise<void>;
  audio(frame: AudioFrame): void;
  snapshot(): ConversationSnapshot;
  close(): Promise<void>;
}

export type AudioMode = 'listen' | 'barge' | 'paused' | 'muted';
export interface HandsFreeAudioOptions {
  onSpeechStart(): void;
  onSpeechEnd(): void;
  onMisfire(): void;
  onPcm(pcm: ArrayBuffer): void;
  onState(state: 'ready' | 'suspended' | 'closed'): void;
  onError(message: string): void;
  onDiscontinuity(): void;
}
export interface HandsFreeAudio {
  setMode(mode: AudioMode): void;
  flushInput(): Promise<void>;
  clearInput(): void;
  enqueueOutput(audio: string, sampleRate: number, responseId: number, seq: number): void;
  finishOutput(responseId: number, lastSeq: number): Promise<'played' | 'interrupted' | 'paused'>;
  cancelOutput(responseId?: number): void;
  resume(): Promise<void>;
  close(): Promise<void>;
}
export interface ConversationView {
  connection: 'offline' | 'connecting' | 'connected' | 'reconnecting' | 'expired';
  phase: 'loading-audio' | 'listening' | 'recording' | 'thinking' | 'speaking' | 'paused' | 'muted' | 'ended';
  messages: TranscriptEntry[];
  partial: string;
  muted: boolean;
  audioAvailable: boolean;
  canSendText: boolean;
  canResumeAudio: boolean;
  sessionId?: string;
  notice?: string;
  tool?: { name: string; status: ToolStatus };
  capabilities?: ToolCapabilities;
}
export interface ConversationClientOptions {
  url: string;
  speechAvailable: boolean;
  refreshAccess(): Promise<void>;
  onChange(view: ConversationView): void;
  audioFactory?: (options: HandsFreeAudioOptions) => Promise<HandsFreeAudio>;
  socketFactory?: (url: string) => WebSocket;
}
export interface ConversationClient {
  start(): Promise<void>;
  sendText(text: string): void;
  finishTurn(): Promise<void>;
  mute(muted: boolean): void;
  resumeAudio(): Promise<void>;
  end(): Promise<void>;
}
