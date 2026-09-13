import type {
  ClientMessage, HarnessEvent, HarnessSession, ServerMessage, SpeechSession,
} from '../shared/contracts.js';

interface SessionDependencies {
  mode: 'live' | 'fixture';
  send(message: ServerMessage): void;
  harness(onEvent: (event: HarnessEvent) => void): HarnessSession;
  speech?: (callbacks: {
    onPartial(text: string): void;
    onAudio(audio: string, sampleRate: number): void;
    onError(message: string): void;
  }) => SpeechSession;
}

type State = 'new' | 'starting' | 'ready' | 'opening-mic' | 'recording' | 'responding' | 'draining' | 'closed';

export class VoiceSession {
  private state: State = 'new';
  private harness?: HarnessSession;
  private speech?: SpeechSession;
  private capturedBytes = 0;

  constructor(private readonly dependencies: SessionDependencies) {}

  async handle(message: ClientMessage): Promise<void> {
    if (message.type === 'end') return this.close();
    if (this.state === 'closed') return;
    try {
      switch (message.type) {
        case 'start': {
          if (this.state !== 'new') return this.notice('A session is already open.');
          this.state = 'starting';
          this.harness = this.dependencies.harness((event) => this.onHarness(event));
          this.speech = this.dependencies.speech?.({
            onPartial: (text) => {
              if (this.state === 'recording' || this.state === 'responding') {
                this.emit({ type: 'partial', text });
              }
            },
            onAudio: (audio, sampleRate) => {
              if (this.state === 'responding') this.emit({ type: 'audio', audio, sampleRate });
            },
            onError: () => { void this.fail('Speech connection failed. End this session and check the speech setup.'); },
          });
          await this.harness.start();
          if (this.isClosed()) return;
          this.state = 'ready';
          this.emit({ type: 'ready', speechAvailable: Boolean(this.speech), mode: this.dependencies.mode });
          return;
        }
        case 'record': {
          if (this.state !== 'ready') return this.notice('Wait for the current turn to finish.');
          if (!this.speech) return this.notice('Speech is not configured. You can still type a message.');
          this.state = 'opening-mic';
          this.capturedBytes = 0;
          await this.speech.startRecognition();
          if (this.isClosed()) return;
          this.state = 'recording';
          this.emit({ type: 'recording' });
          return;
        }
        case 'finish': {
          if (this.state !== 'recording' || !this.speech) return this.notice('There is no recording to finish.');
          this.state = 'responding';
          const text = (await this.speech.commitRecognition()).trim();
          if (this.isClosed()) return;
          if (!text) {
            this.state = 'ready';
            this.notice('No speech was recognized. Try again or type your message.');
            this.emit({ type: 'idle' });
            return;
          }
          await this.respond(text);
          return;
        }
        case 'text': {
          if (this.state !== 'ready') return this.notice('Wait for the current turn to finish.');
          this.state = 'responding';
          await this.respond(message.text);
          return;
        }
        case 'playback_done': {
          if (this.state === 'draining') {
            this.state = 'ready';
            this.emit({ type: 'idle' });
          }
          return;
        }
      }
    } catch {
      await this.fail('This turn could not finish. Check the local harness and speech connections, then start a new session.');
    }
  }

  audio(pcm: Uint8Array): void {
    if (this.state !== 'recording' || !this.speech) return;
    // Two minutes of mono PCM16 at 16 kHz. No unbounded recording buffer.
    this.capturedBytes += pcm.byteLength;
    if (pcm.byteLength > 32768 || pcm.byteLength % 2 || this.capturedBytes > 16000 * 2 * 120) {
      void this.fail('Recording limit reached. Start a new session and use a shorter turn.');
      return;
    }
    try {
      this.speech.writeAudio(pcm);
    } catch {
      void this.fail('Audio could not be sent. Start a new session or use typed input.');
    }
  }

  private async respond(text: string): Promise<void> {
    if (!this.harness || this.isClosed()) return;
    this.emit({ type: 'user', text });
    await this.harness.send(text);
    if (this.isClosed()) return;
    await this.speech?.finishSpeech();
    if (this.isClosed()) return;
    this.state = 'draining';
    this.emit({ type: 'response_done' });
  }

  private onHarness(event: HarnessEvent): void {
    if (this.isClosed()) return;
    if (event.type === 'error') {
      void this.fail('The local Claude Code process failed. Check its login and configuration, then start a new session.');
    } else if (event.type === 'text' && this.state === 'responding') {
      this.emit(event);
      try { this.speech?.writeText(event.text); }
      catch { void this.fail('Speech output failed. End this session and check the speech setup.'); }
    } else if (event.type === 'tool' && this.state === 'responding') {
      this.emit(event);
    }
  }

  private emit(message: ServerMessage): void {
    if (!this.isClosed()) this.dependencies.send(message);
  }

  private notice(message: string): void {
    this.emit({ type: 'error', message });
  }

  private isClosed(): boolean { return this.state === 'closed'; }

  private async fail(message: string): Promise<void> {
    if (this.isClosed()) return;
    this.dependencies.send({ type: 'error', message, fatal: true });
    await this.close();
  }

  async close(): Promise<void> {
    if (this.isClosed()) return;
    this.state = 'closed';
    try { this.speech?.close(); } catch { /* Continue releasing the harness. */ }
    try { await this.harness?.close(); } catch { /* The session is already closed. */ }
    this.dependencies.send({ type: 'ended' });
  }
}
