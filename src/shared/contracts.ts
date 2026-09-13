export type HarnessEvent =
  | { type: 'ready'; sessionId?: string; tools?: string[]; mcp?: Array<{ name: string; status: string }> }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'done' | 'failed' | 'denied' }
  | { type: 'error'; message: string };

export interface HarnessOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  onEvent(event: HarnessEvent): void;
}

export interface HarnessSession {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  interrupt?(): Promise<void>;
  close(): Promise<void>;
}

export type SpeechTokenKind = 'realtime_scribe' | 'tts_websocket';

export interface SpeechOptions {
  getToken(kind: SpeechTokenKind): Promise<string>;
  voiceId: string;
  onPartial(text: string): void;
  onAudio(audio: string, sampleRate: number): void;
  onError(message: string): void;
  endpoints?: { stt?: string; tts?: string };
  timeoutMs?: number;
}

export interface SpeechSession {
  startRecognition(): Promise<void>;
  writeAudio(pcm: Uint8Array): void;
  acceptAudio?(pcm: Uint8Array): boolean;
  abortRecognition?(): void;
  cancelSpeech?(): void;
  commitRecognition(): Promise<string>;
  writeText(text: string): void;
  finishSpeech(): Promise<void>;
  close(): void;
}

export interface CaptureSession {
  stop(): Promise<void>;
}

export interface PlaybackSession {
  enqueue(audioBase64: string, sampleRate: number): void;
  drain(): Promise<void>;
  stop(): void;
}

export type ClientMessage =
  | { type: 'start' }
  | { type: 'record' }
  | { type: 'finish' }
  | { type: 'text'; text: string }
  | { type: 'playback_done' }
  | { type: 'end' };

export type ServerMessage =
  | { type: 'ready'; speechAvailable: boolean; mode: 'live' | 'fixture' }
  | { type: 'recording' }
  | { type: 'partial'; text: string }
  | { type: 'user'; text: string }
  | { type: 'text'; text: string }
  | { type: 'audio'; audio: string; sampleRate: number }
  | { type: 'tool'; name: string; status: 'running' | 'done' | 'failed' | 'denied' }
  | { type: 'response_done' }
  | { type: 'idle' }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'ended' };
