import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  GptLiveTrialStatus,
  GptLiveTranscriptEntry,
  GptLiveDiagnostics,
} from '../../shared/gpt-live-trial.js';

export type GptLivePhase = 'idle' | 'connecting' | 'active' | 'muted' | 'ending' | 'ended' | 'error';

interface GptLivePanelProps {
  trialStatus: GptLiveTrialStatus | null;
  defaultModeActive: boolean;
  onModeSwitch: (mode: 'default' | 'gpt-live') => void;
}

interface SessionState {
  phase: GptLivePhase;
  transcript: GptLiveTranscriptEntry[];
  cumulativeSeconds: number;
  estimatedCostUsd: number;
  errorMessage: string | null;
  budgetRemainingUsd: number;
}

const initialState: SessionState = {
  phase: 'idle',
  transcript: [],
  cumulativeSeconds: 0,
  estimatedCostUsd: 0,
  errorMessage: null,
  budgetRemainingUsd: 0,
};

export function GptLivePanel({ trialStatus, defaultModeActive, onModeSwitch }: GptLivePanelProps) {
  const [state, setState] = useState<SessionState>({
    ...initialState,
    budgetRemainingUsd: trialStatus?.budgetRemainingUsd ?? 0,
  });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      void cleanup();
    };
  }, []);

  const cleanup = useCallback(async () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
  }, []);

  const startSession = useCallback(async () => {
    if (!trialStatus?.enabled || !trialStatus?.hasApiKey) return;
    if (defaultModeActive) {
      setState(prev => ({
        ...prev,
        errorMessage: 'End the default voice session before starting a GPT-Live trial.',
      }));
      return;
    }

    setState(prev => ({ ...prev, phase: 'connecting', errorMessage: null }));

    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      pc.addTransceiver('audio', { direction: 'sendrecv' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch('/api/gpt-live/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sdp: offer.sdp }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Session creation failed (${response.status})`);
      }

      const data = await response.json() as { sessionId: string; sdp: string };

      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });

      pc.ontrack = (event) => {
        if (audioRef.current && event.streams[0]) {
          audioRef.current.srcObject = event.streams[0];
          void audioRef.current.play().catch(() => {});
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          void endSession();
        }
      };

      setState(prev => ({
        ...prev,
        phase: 'active',
        transcript: [],
        cumulativeSeconds: 0,
        estimatedCostUsd: 0,
      }));

      onModeSwitch('gpt-live');
    } catch (error) {
      await cleanup();
      setState(prev => ({
        ...prev,
        phase: 'error',
        errorMessage: error instanceof Error ? error.message : 'Session start failed.',
      }));
    }
  }, [trialStatus, defaultModeActive, cleanup, onModeSwitch]);

  const endSession = useCallback(async () => {
    setState(prev => ({ ...prev, phase: 'ending' }));
    await cleanup();
    setState(prev => ({
      ...prev,
      phase: 'ended',
    }));
    onModeSwitch('default');
  }, [cleanup, onModeSwitch]);

  const toggleMute = useCallback(() => {
    if (!streamRef.current) return;
    const tracks = streamRef.current.getAudioTracks();
    const isMuted = state.phase === 'muted';
    tracks.forEach(t => { t.enabled = isMuted; });
    setState(prev => ({
      ...prev,
      phase: isMuted ? 'active' : 'muted',
    }));
  }, [state.phase]);

  const copyDiagnostics = useCallback(async () => {
    const diagnostics: GptLiveDiagnostics = {
      sessionId: null,
      voiceModel: 'gpt-live-1',
      backendModel: 'claude-opus-4-6[1m]',
      cumulativeVoiceSeconds: state.cumulativeSeconds,
      estimatedCostUsd: state.estimatedCostUsd,
      closureConfirmed: state.phase === 'ended' ? true : null,
      closureReason: state.phase === 'ended' ? 'user_ended' : null,
      delegationsProcessed: 0,
      delegationsSkipped: 0,
      transcript: state.transcript,
    };
    const lines = [
      'wave-mech GPT-Live trial diagnostics',
      `Voice model: ${diagnostics.voiceModel}`,
      `Backend model: ${diagnostics.backendModel}`,
      `Cumulative voice: ${diagnostics.cumulativeVoiceSeconds.toFixed(1)}s`,
      `Estimated cost: $${diagnostics.estimatedCostUsd.toFixed(4)}`,
      `Closure confirmed: ${diagnostics.closureConfirmed}`,
      '',
      'TRANSCRIPT',
      ...diagnostics.transcript.map(
        t => `[${t.source}] ${t.role}: ${t.text}`,
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
    } catch { /* clipboard unavailable */ }
  }, [state]);

  if (!trialStatus?.enabled) return null;

  const isSessionActive = state.phase === 'active' || state.phase === 'muted';
  const canStart = trialStatus.hasApiKey && state.phase === 'idle' && !defaultModeActive
    && trialStatus.budgetRemainingUsd > 0;

  return (
    <div className="gpt-live-panel">
      <div className="gpt-live-header">
        <span className="gpt-live-badge">GPT-Live trial</span>
        <span className="gpt-live-identity">
          Voice: gpt-live-1 · Backend: Claude Code (claude-opus-4-6)
        </span>
      </div>

      {!trialStatus.hasApiKey && (
        <div className="gpt-live-notice">
          API key not configured. The trial cannot start without a provisioned key.
        </div>
      )}

      {trialStatus.budgetRemainingUsd <= 0 && (
        <div className="gpt-live-notice gpt-live-budget-exhausted">
          Trial budget exhausted.
        </div>
      )}

      <div className="gpt-live-controls">
        {state.phase === 'idle' && (
          <button
            className="primary-button gpt-live-start"
            disabled={!canStart}
            onClick={() => void startSession()}
          >
            Start GPT-Live trial
          </button>
        )}

        {state.phase === 'connecting' && (
          <button className="primary-button" disabled>
            Connecting…
          </button>
        )}

        {isSessionActive && (
          <>
            <button className="primary-button" onClick={toggleMute}>
              {state.phase === 'muted' ? 'Unmute' : 'Mute'}
            </button>
            <button
              className="quiet-button"
              onClick={() => void endSession()}
            >
              End trial session
            </button>
          </>
        )}

        {state.phase === 'ending' && (
          <button className="primary-button" disabled>
            Ending…
          </button>
        )}

        {(state.phase === 'ended' || state.phase === 'error') && (
          <>
            <button
              className="primary-button"
              onClick={() => setState({ ...initialState, budgetRemainingUsd: trialStatus.budgetRemainingUsd })}
            >
              Reset
            </button>
            <button className="quiet-button" onClick={() => void copyDiagnostics()}>
              Copy diagnostics
            </button>
          </>
        )}
      </div>

      {state.errorMessage && (
        <div className="gpt-live-error">{state.errorMessage}</div>
      )}

      {isSessionActive && (
        <div className="gpt-live-status">
          <span>Budget: ${(trialStatus.budgetRemainingUsd - state.estimatedCostUsd).toFixed(2)} remaining</span>
          <span>Max: {trialStatus.maxSessionSeconds}s</span>
        </div>
      )}

      <div className="gpt-live-disclosure">
        Audio is processed by OpenAI (gpt-live-1). Backend actions use Claude Code.
        Paid usage: ~${GPT_LIVE_PRICE_PER_MIN}/min voice. Trial budget: $5.
      </div>

      {state.transcript.length > 0 && (
        <div className="gpt-live-transcript" aria-label="GPT-Live transcript">
          {state.transcript.map((entry, i) => (
            <div key={i} className={`gpt-live-msg gpt-live-msg-${entry.role}`}>
              <span className="gpt-live-msg-source">[{entry.source}]</span>
              <span className="gpt-live-msg-role">
                {entry.role === 'user' ? 'You' : 'wave-mech'}
              </span>
              <span>{entry.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="gpt-live-text-disabled">
        Typed input is not supported in GPT-Live trial mode.
      </div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={audioRef} autoPlay style={{ display: 'none' }} />
    </div>
  );
}

const GPT_LIVE_PRICE_PER_MIN = '0.05';
