import { useState, useRef, useCallback, useEffect } from 'react';
import type {
  GptLiveTrialStatus,
  GptLiveTranscriptEntry,
  GptLiveDiagnostics,
  GptLiveStopCause,
} from '../../shared/gpt-live-trial.js';
import { browserReport, formatTranscriptReport } from '../transcript.js';

export type GptLivePhase = 'idle' | 'connecting' | 'active' | 'muted' | 'ending' | 'ended' | 'error';

interface GptLivePanelProps {
  trialStatus: GptLiveTrialStatus | null;
  defaultModeActive: boolean;
  onModeSwitch: (mode: 'default' | 'gpt-live') => void;
  mode?: 'live' | 'fixture';
  buildId?: string;
}

interface SessionState {
  phase: GptLivePhase;
  sessionId: string | null;
  transcript: GptLiveTranscriptEntry[];
  cumulativeSeconds: number;
  estimatedCostUsd: number;
  errorMessage: string | null;
  budgetRemainingUsd: number;
  closureConfirmed: boolean | null;
  stopCause: GptLiveStopCause | null;
  unfinishedDelegation: boolean;
  remainingSeconds: number | null;
  autoplayBlocked: boolean;
  copyStatus: 'idle' | 'copied' | 'fallback';
  copyFallback: string;
}

const initialState: SessionState = {
  phase: 'idle',
  sessionId: null,
  transcript: [],
  cumulativeSeconds: 0,
  estimatedCostUsd: 0,
  errorMessage: null,
  budgetRemainingUsd: 0,
  closureConfirmed: null,
  stopCause: null,
  unfinishedDelegation: false,
  remainingSeconds: null,
  autoplayBlocked: false,
  copyStatus: 'idle',
  copyFallback: '',
};

// Safety net past the server deadline: if the provider never flips ICE state
// after the server closes, the panel still stops claiming an active session.
const DEADLINE_GRACE_MS = 5000;

function limitLabel(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}-minute` : `${seconds}-second`;
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function stopNotice(stopCause: GptLiveStopCause | null, unfinished: boolean, maxSeconds: number): string | null {
  const unfinishedText = unfinished ? ' A backend task was still running, so its answer was not delivered.' : '';
  switch (stopCause) {
    case 'deadline': return `The session ended at the ${limitLabel(maxSeconds)} limit.${unfinishedText}`;
    case 'budget_exceeded': return `The session ended because reported voice usage reached the configured limit.${unfinishedText}`;
    case 'provider_closed': return `The provider closed the session.${unfinishedText}`;
    case 'sideband_error':
    case 'sideband_failure': return `The provider control channel failed, so the session was stopped.${unfinishedText}`;
    case 'shutdown': return `The server stopped the session.${unfinishedText}`;
    default: return unfinished ? `The session ended while a backend task was still running; its answer was not delivered.` : null;
  }
}

export function GptLivePanel({ trialStatus, defaultModeActive, onModeSwitch, mode, buildId }: GptLivePanelProps) {
  const [state, setState] = useState<SessionState>(() => ({
    ...initialState,
    budgetRemainingUsd: trialStatus?.budgetRemainingUsd ?? 0,
  }));

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const startingRef = useRef(false);
  const endingRef = useRef(false);
  const lastDiagRef = useRef<GptLiveDiagnostics | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const maxSessionSeconds = trialStatus?.maxSessionSeconds ?? 0;

  const stopLocalMedia = useCallback(() => {
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

  const endOnServer = useCallback(async (sid: string): Promise<void> => {
    try {
      await fetch('/api/gpt-live/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionId: sid }),
      });
    } catch { /* best effort */ }
  }, []);

  const fetchDiag = useCallback(async (): Promise<GptLiveDiagnostics | null> => {
    try {
      const r = await fetch('/api/gpt-live/diagnostics', { credentials: 'same-origin' });
      if (r.ok) {
        const d = await r.json() as GptLiveDiagnostics;
        lastDiagRef.current = d;
        return d;
      }
    } catch { /* unavailable */ }
    return null;
  }, []);

  const endSession = useCallback(async () => {
    if (endingRef.current) return;
    endingRef.current = true;
    const g = ++genRef.current;

    stopLocalMedia();
    startedAtRef.current = null;

    const sid = sessionIdRef.current;
    sessionIdRef.current = null;
    startingRef.current = false;

    if (!sid) {
      setState(prev => ({ ...prev, phase: 'idle', errorMessage: null, autoplayBlocked: false, remainingSeconds: null }));
      endingRef.current = false;
      return;
    }

    setState(prev => ({ ...prev, phase: 'ending', autoplayBlocked: false, remainingSeconds: null }));

    await endOnServer(sid);
    if (genRef.current !== g) { endingRef.current = false; return; }

    const diag = await fetchDiag();
    if (genRef.current !== g) { endingRef.current = false; return; }

    setState(prev => ({
      ...prev,
      phase: 'ended',
      closureConfirmed: diag?.closureConfirmed ?? null,
      stopCause: diag?.stopCause ?? null,
      unfinishedDelegation: diag?.unfinishedDelegation === true,
      cumulativeSeconds: diag?.cumulativeVoiceSeconds ?? prev.cumulativeSeconds,
      estimatedCostUsd: diag?.estimatedCostUsd ?? prev.estimatedCostUsd,
      transcript: diag?.transcript ?? prev.transcript,
    }));
    endingRef.current = false;
    onModeSwitch('default');
  }, [stopLocalMedia, endOnServer, fetchDiag, onModeSwitch]);

  useEffect(() => {
    return () => {
      genRef.current++;
      stopLocalMedia();
      const sid = sessionIdRef.current;
      if (sid) {
        sessionIdRef.current = null;
        void endOnServer(sid);
      }
    };
  }, [stopLocalMedia, endOnServer]);

  const isActive = state.phase === 'active' || state.phase === 'muted';

  // Countdown toward the configured limit while the paid session is active.
  useEffect(() => {
    if (!isActive || !maxSessionSeconds) return;
    const tick = () => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      const elapsed = (Date.now() - startedAt) / 1000;
      setState(prev => ({ ...prev, remainingSeconds: Math.max(0, maxSessionSeconds - elapsed) }));
      if (elapsed * 1000 > maxSessionSeconds * 1000 + DEADLINE_GRACE_MS) void endSession();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [isActive, maxSessionSeconds, endSession]);

  const startSession = useCallback(async () => {
    if (!trialStatus?.enabled || !trialStatus?.hasApiKey) return;
    if (startingRef.current || endingRef.current) return;
    if (defaultModeActive) {
      setState(prev => ({
        ...prev,
        errorMessage: 'End the default voice session before starting a GPT-Live trial.',
      }));
      return;
    }

    startingRef.current = true;
    const g = ++genRef.current;

    setState({
      ...initialState,
      budgetRemainingUsd: trialStatus.budgetRemainingUsd,
      phase: 'connecting',
    });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (genRef.current !== g) {
        stream.getTracks().forEach(t => t.stop());
        startingRef.current = false;
        return;
      }
      streamRef.current = stream;

      const pc = new RTCPeerConnection({ iceServers: [] });
      if (genRef.current !== g) {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        pc.close();
        startingRef.current = false;
        return;
      }
      pcRef.current = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      let providerStarted = false;
      const dc = pc.createDataChannel('oai-events', { ordered: true });
      dc.onmessage = (ev) => {
        if (genRef.current !== g) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'session.started') {
            providerStarted = true;
            setState(prev => prev.phase === 'connecting' ? { ...prev, phase: 'active' } : prev);
          }
        } catch { /* non-JSON */ }
      };

      const offer = await pc.createOffer();
      if (genRef.current !== g) { stopLocalMedia(); startingRef.current = false; return; }
      await pc.setLocalDescription(offer);
      if (genRef.current !== g) { stopLocalMedia(); startingRef.current = false; return; }

      const resp = await fetch('/api/gpt-live/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sdp: offer.sdp }),
      });

      if (!resp.ok) {
        if (genRef.current !== g) { stopLocalMedia(); startingRef.current = false; return; }
        const text = await resp.text();
        throw new Error(text || `Session creation failed (${resp.status})`);
      }

      const data = await resp.json() as { sessionId: string; sdp: string };
      if (genRef.current !== g) {
        stopLocalMedia();
        startingRef.current = false;
        void endOnServer(data.sessionId);
        return;
      }
      sessionIdRef.current = data.sessionId;
      // The server's deadline started when the provider session was created,
      // just before this response; the countdown is anchored here.
      startedAtRef.current = Date.now();

      pc.ontrack = (ev) => {
        if (genRef.current !== g) return;
        if (audioRef.current && ev.streams[0]) {
          audioRef.current.srcObject = ev.streams[0];
          audioRef.current.play().catch(err => {
            if (genRef.current !== g) return;
            if (err?.name === 'NotAllowedError') {
              setState(prev => ({ ...prev, autoplayBlocked: true }));
            }
          });
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (genRef.current !== g) return;
        const s = pc.iceConnectionState;
        if (s === 'disconnected' || s === 'failed') {
          void endSession();
        }
      };

      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      if (genRef.current !== g) {
        stopLocalMedia();
        sessionIdRef.current = null;
        startingRef.current = false;
        void endOnServer(data.sessionId);
        return;
      }

      setState(prev => ({ ...prev, sessionId: data.sessionId }));
      onModeSwitch('gpt-live');
      startingRef.current = false;

      setTimeout(() => {
        if (genRef.current === g && !providerStarted) void endSession();
      }, 15000);
    } catch (error) {
      if (genRef.current !== g) { startingRef.current = false; return; }
      stopLocalMedia();
      startedAtRef.current = null;
      const sid = sessionIdRef.current;
      if (sid) { sessionIdRef.current = null; void endOnServer(sid); }
      startingRef.current = false;
      setState(prev => ({
        ...prev,
        phase: 'error',
        errorMessage: error instanceof Error ? error.message : 'Session start failed.',
      }));
    }
  }, [trialStatus, defaultModeActive, stopLocalMedia, endOnServer, endSession, onModeSwitch]);

  const toggleMute = useCallback(() => {
    if (!streamRef.current) return;
    const tracks = streamRef.current.getAudioTracks();
    const muted = state.phase === 'muted';
    tracks.forEach(t => { t.enabled = muted; });
    setState(prev => ({ ...prev, phase: muted ? 'active' : 'muted' }));
  }, [state.phase]);

  const resumeAudio = useCallback(() => {
    if (!audioRef.current) return;
    audioRef.current.play()
      .then(() => setState(prev => ({ ...prev, autoplayBlocked: false })))
      .catch(() => {});
  }, []);

  const copyDiagnostics = useCallback(async () => {
    let diag: GptLiveDiagnostics;
    const fetched = await fetchDiag();
    if (fetched) {
      diag = fetched;
    } else if (lastDiagRef.current) {
      diag = lastDiagRef.current;
    } else {
      diag = {
        sessionId: state.sessionId,
        voiceModel: 'gpt-live-1',
        backendModel: 'claude-opus-4-6[1m]',
        cumulativeVoiceSeconds: state.cumulativeSeconds,
        estimatedCostUsd: state.estimatedCostUsd,
        closureConfirmed: state.closureConfirmed,
        closureReason: null,
        stopCause: state.phase === 'ended' ? 'user_ended' : null,
        unfinishedDelegation: state.unfinishedDelegation,
        delegationsProcessed: 0,
        delegationsSkipped: 0,
        transcript: state.transcript,
        diagnostics: { entries: [], dropped: 0 },
      };
    }
    // Same report format as the default mode's Copy transcript: ISO timestamps,
    // structured tool/error/lifecycle lines, no raw payloads or credentials.
    const report = formatTranscriptReport({
      messages: [],
      diagnostics: diag.diagnostics ?? { entries: [], dropped: 0 },
      capturedAt: Date.now(),
      mode,
      configuredModel: diag.backendModel,
      reportedModel: diag.backendReportedModel ?? undefined,
      buildId,
      browser: browserReport(),
      gptLiveTrial: diag,
    });
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(report);
      setState(prev => ({ ...prev, copyStatus: 'copied', copyFallback: '' }));
    } catch {
      setState(prev => ({ ...prev, copyStatus: 'fallback', copyFallback: report }));
    }
  }, [state, fetchDiag, mode, buildId]);

  if (!trialStatus?.enabled) return null;

  const canStart = trialStatus.hasApiKey && state.phase === 'idle' && !defaultModeActive
    && trialStatus.budgetRemainingUsd > 0;
  const showEnd = state.phase === 'connecting' || isActive;
  const endNotice = state.phase === 'ended' ? stopNotice(state.stopCause, state.unfinishedDelegation, maxSessionSeconds) : null;

  return (
    <div className="gpt-live-panel" data-testid="gpt-live-panel">
      <div className="gpt-live-header">
        <span className="gpt-live-badge">GPT-Live trial</span>
        <span className="gpt-live-identity">
          Voice: gpt-live-1 &middot; Backend: Claude Code (claude-opus-4-6)
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
          <button className="primary-button" disabled>Connecting&hellip;</button>
        )}

        {isActive && (
          <button className="primary-button" onClick={toggleMute}>
            {state.phase === 'muted' ? 'Unmute' : 'Mute'}
          </button>
        )}

        {showEnd && (
          <button className="quiet-button gpt-live-end" onClick={() => void endSession()}>
            End trial session
          </button>
        )}

        {state.autoplayBlocked && isActive && (
          <button className="primary-button gpt-live-resume" onClick={resumeAudio}>
            Resume audio
          </button>
        )}

        {state.phase === 'ending' && (
          <button className="primary-button" disabled>Ending&hellip;</button>
        )}

        {(state.phase === 'ended' || state.phase === 'error') && (
          <>
            {endNotice && (
              <div className="gpt-live-notice gpt-live-stop-notice" role="status">{endNotice}</div>
            )}
            {state.closureConfirmed === false && (
              <div className="gpt-live-notice">
                Session closure was not confirmed by the provider. Usage may be conservatively estimated.
              </div>
            )}
            {state.closureConfirmed === null && state.phase === 'ended' && (
              <div className="gpt-live-notice">
                Session finalization is pending. Usage status unknown.
              </div>
            )}
            <button
              className="primary-button"
              onClick={() => {
                lastDiagRef.current = null;
                setState({ ...initialState, budgetRemainingUsd: trialStatus.budgetRemainingUsd });
              }}
            >
              Reset
            </button>
            <button className="quiet-button gpt-live-copy" onClick={() => void copyDiagnostics()}>
              Copy diagnostics
            </button>
          </>
        )}
      </div>

      {state.copyStatus === 'copied' && (
        <div className="gpt-live-notice" role="status">
          Copied diagnostics. Review before sharing.
        </div>
      )}

      {state.copyStatus === 'fallback' && state.copyFallback && (
        <div className="gpt-live-copy-fallback">
          <div className="gpt-live-notice" role="status">
            Clipboard unavailable. Select and copy the report below.
          </div>
          <textarea
            readOnly
            value={state.copyFallback}
            aria-label="GPT-Live diagnostics — review before sharing"
            onFocus={e => e.currentTarget.select()}
          />
          <button className="quiet-button" onClick={() => setState(prev => ({ ...prev, copyStatus: 'idle', copyFallback: '' }))}>
            Hide report
          </button>
        </div>
      )}

      {state.errorMessage && (
        <div className="gpt-live-error">{state.errorMessage}</div>
      )}

      {isActive && (
        <div className="gpt-live-status">
          <span>Budget: ${(trialStatus.budgetRemainingUsd - state.estimatedCostUsd).toFixed(2)} remaining</span>
          <span data-testid="gpt-live-time-left">
            {state.remainingSeconds === null ? `Max: ${trialStatus.maxSessionSeconds}s` : `Time left: ${clock(state.remainingSeconds)} of ${clock(maxSessionSeconds)}`}
          </span>
        </div>
      )}

      <div className="gpt-live-disclosure">
        Audio is processed by OpenAI (gpt-live-1). Backend actions use Claude Code.
        Paid usage: ~$0.05/min voice. Trial budget: $5. Sessions stop automatically at {clock(maxSessionSeconds)}.
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
      <audio ref={audioRef} style={{ display: 'none' }} />
    </div>
  );
}
