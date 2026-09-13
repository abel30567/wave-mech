import { useEffect, useRef, useState } from 'react';
import { createConversationClient } from './realtime/client.js';
import type { ConversationClient, ConversationView, ConversationClientOptions } from '../shared/realtime.js';
import './style.css';

type Bootstrap = { protocol: number; mode: 'live' | 'fixture'; speechConfigured: boolean; fermiConfigured: boolean; speechMessage: string };
const initialView: ConversationView = {
  connection: 'offline', phase: 'ended', messages: [], partial: '', muted: false,
  audioAvailable: false, canSendText: false, canResumeAudio: false,
};
function Microphone({ size = 28, muted = false }: { size?: number; muted?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="8" y="2" width="8" height="13" rx="4" stroke="currentColor" strokeWidth="1.7" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    {muted && <path d="m3 3 18 18" stroke="currentColor" strokeWidth="2" />}
  </svg>;
}
function toolLabel(name: string) {
  const labels: Record<string, string> = { WebSearch: 'Searching the web', WebFetch: 'Reading a web page', ToolSearch: 'Finding a tool', mcp__fermi__skill_search: 'Finding a Fermi skill', mcp__fermi__skill_load: 'Loading a Fermi skill', mcp__fermi__memory_recall: 'Reading Fermi memory' };
  return labels[name] ?? name.replace(/^mcp__.*?__/, '').replaceAll('_', ' ');
}

export default function App() {
  const [setup, setSetup] = useState<Bootstrap>();
  const [view, setView] = useState<ConversationView>(initialView);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState('');
  const client = useRef<ConversationClient | undefined>(undefined);
  const generation = useRef(0);
  const conversation = useRef<HTMLDivElement>(null);

  async function refreshAccess() {
    const response = await fetch('/api/bootstrap', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Local access requires authorization. Reload the page to sign in.');
    const value = await response.json() as Bootstrap;
    if (value.protocol !== 2) throw new Error('The server needs the hands-free update.');
    setSetup(value);
  }
  useEffect(() => {
    void refreshAccess().catch(() => setNotice('The workspace is unavailable. Refresh to reconnect or sign in.'));
    return () => { generation.current++; void client.current?.end(); };
  }, []);
  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'instant' });
  }, [view.messages, view.partial]);

  function start() {
    if (!setup) { void refreshAccess().catch(() => setNotice('The workspace is unavailable.')); return; }
    const revision = ++generation.current;
    void client.current?.end();
    setNotice(''); setDraft(''); setView({ ...initialView, connection: 'connecting', phase: 'loading-audio' });
    const testFactory = (window as unknown as { __waveTestAudioFactory?: ConversationClientOptions['audioFactory'] }).__waveTestAudioFactory;
    const next = createConversationClient({
      url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/session`,
      speechAvailable: setup.speechConfigured,
      refreshAccess,
      audioFactory: setup.mode === 'fixture' ? testFactory : undefined,
      onChange: state => { if (generation.current === revision) setView(state); },
    });
    client.current = next;
    void next.start().catch(() => {
      if (generation.current === revision) setNotice('The conversation could not start. Check audio permission and your connection.');
    });
  }
  function end() {
    generation.current++;
    const current = client.current; client.current = undefined;
    void current?.end();
    setView(previous => ({ ...initialView, messages: previous.messages }));
    setNotice('');
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!view.canSendText || !draft.trim()) return;
    client.current?.sendText(draft.trim()); setDraft(''); setNotice('');
  }
  const active = view.connection !== 'offline' && view.connection !== 'expired';
  const phaseLabels: Record<ConversationView['phase'], string> = {
    'loading-audio': 'Preparing your microphone', listening: 'Listening', recording: 'Listening to your thought',
    thinking: 'Thinking', speaking: 'Speaking', paused: 'Audio paused', muted: 'Microphone muted', ended: 'Not connected',
  };
  const status = view.connection === 'reconnecting' ? 'Reconnecting — keeping your conversation'
    : view.connection === 'expired' ? 'Session expired'
    : view.muted ? 'Microphone muted' : view.canResumeAudio ? 'Audio paused' : phaseLabels[view.phase];
  const help = !active ? 'Start once, then speak naturally.'
    : view.connection === 'reconnecting' ? 'Short connection interruptions do not reset the conversation.'
    : view.canResumeAudio ? 'Your browser paused audio. Tap below to resume.'
    : view.muted ? 'Your microphone is muted. You can still type.'
    : view.phase === 'recording' ? 'Pause when you finish your thought. No button needed.'
    : view.phase === 'speaking' ? 'Speak to interrupt, or wait for the reply to finish.'
    : view.phase === 'thinking' ? 'Your reply is on its way.' : 'Speak when you are ready. I will listen again after replying.';
  const fermi = view.capabilities?.fermi ?? (setup?.fermiConfigured ? 'pending' : 'unavailable');
  const tool = view.tool;
  const displayedNotice = notice || view.notice;

  return <div className={`app-shell ${active ? 'in-session' : ''}`}>
    <header className="app-header">
      <a className="wordmark" href="/" aria-label="wave-mech home"><span className="brand-mark" aria-hidden="true">≈</span>wave-mech</a>
      <span className="local-label"><span className={`status-dot ${view.connection === 'connected' ? 'connected' : ''}`} />Hands-free workspace</span>
    </header>
    <main className="workspace">
      <section className="voice-panel" aria-labelledby="voice-title">
        <div className="intro"><h1 id="voice-title">Talk it through.</h1><p>A thought, a question, a next step.<br />Just start talking.</p></div>
        <div className={`voice-station ${view.phase === 'recording' ? 'is-recording' : ''} ${view.phase === 'listening' ? 'is-listening' : ''}`}>
          <div className="station-ring"><div className="station-core"><Microphone size={54} muted={view.muted} /></div></div>
          <p className="station-status" aria-live="polite">{status}</p>
          <p className="station-help">{help}</p>
          <div className="session-controls">
            {!active ? <button className="primary-button" disabled={!setup} onClick={start}>Start session</button>
              : view.canResumeAudio ? <button className="primary-button" onClick={() => void client.current?.resumeAudio().catch(() => setNotice('Audio still needs permission. Check your browser settings.'))}>Resume audio</button>
              : <button className="primary-button" disabled={!view.audioAvailable || !setup?.speechConfigured} onClick={() => client.current?.mute(!view.muted)}>
                <Microphone size={18} muted={!view.muted} />{view.muted ? 'Unmute microphone' : view.phase === 'loading-audio' ? 'Preparing audio…' : 'Mute microphone'}
              </button>}
            <button className="quiet-button" disabled={!client.current} onClick={end}>End session</button>
            {view.phase === 'recording' && <button className="manual-fallback" onClick={() => void client.current?.finishTurn()}>Finish now</button>}
          </div>
        </div>
        <div className="session-notes"><span className="note-symbol" aria-hidden="true">⌁</span><p>Keep this page open for hands-free listening. Mute or end the session whenever you want.</p></div>
      </section>
      <section className="conversation-panel" aria-label="Conversation">
        <div className="conversation-heading"><h2>Your conversation</h2><span>{setup?.mode === 'fixture' ? 'Synthetic test' : 'Claude Code'}</span></div>
        <div className="capability-row" aria-label="Tool connection status">
          <span className={view.capabilities?.web ? 'available' : ''}>{view.capabilities ? view.capabilities.web ? 'Web tools available' : 'Web tools unavailable' : 'Web tools checking'}</span>
          <span className={fermi === 'connected' ? 'available' : ''}>{fermi === 'connected' ? 'Fermi connected' : fermi === 'pending' ? 'Fermi checking' : 'Fermi unavailable'}</span>
        </div>
        {setup?.mode === 'fixture' && <div className="fixture-banner">Test mode: synthetic provider responses, not live inference.</div>}
        {setup && !setup.speechConfigured && <div className="setup-banner"><strong>Voice setup needed</strong><p>{setup.speechMessage}</p></div>}
        <div className="conversation" ref={conversation} role="log" aria-live="polite" aria-label="Conversation messages">
          {!view.messages.length && <div className="empty-conversation"><span className="empty-symbol" aria-hidden="true">“</span><h3>Room for your next idea.</h3><p>Start a session and speak naturally,<br />or use the keyboard below.</p></div>}
          {view.messages.map(message => <article key={`${message.turnId}-${message.role}`} className={`message ${message.role}`}><span className="speaker">{message.role === 'user' ? 'You' : 'wave-mech'}</span><p>{message.text || <span className="waiting-text">{tool?.status === 'running' ? `${toolLabel(tool.name)}…` : 'Thinking…'}</span>}</p></article>)}
          {view.partial && <div className="partial"><span>Listening</span><p>{view.partial}</p></div>}
          {tool && <p className={`tool-note ${tool.status === 'failed' || tool.status === 'denied' ? 'tool-failed' : ''}`}>{toolLabel(tool.name)}{tool.status === 'running' ? '…' : tool.status === 'done' ? ' — complete' : ` — ${tool.status}`}</p>}
        </div>
        {displayedNotice && <div className="notice" role="status">{displayedNotice}</div>}
        <form className="composer" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="message-input">Type a message</label>
          <textarea id="message-input" rows={2} maxLength={12000} value={draft} onChange={event => setDraft(event.target.value)} disabled={!view.canSendText} placeholder="Or type your thought here…" />
          <button className="send-button" disabled={!view.canSendText || !draft.trim()} type="submit">Send<span aria-hidden="true">↗</span></button>
        </form>
        <p className="conversation-footnote">Read-only tools when connected. Skill creation and consequential actions are disabled.</p>
      </section>
    </main>
    <footer className="app-footer"><span>Voice, with a little more agency.</span><span>Hands-free preview</span></footer>
  </div>;
}
