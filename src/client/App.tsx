import { useEffect, useRef, useState } from 'react';
import { createCapture } from './audio/capture.js';
import { createPlayback } from './audio/playback.js';
import type { CaptureSession, ClientMessage, PlaybackSession, ServerMessage } from '../shared/contracts.js';
import './style.css';

type Phase = 'offline' | 'connecting' | 'ready' | 'opening' | 'recording' | 'responding';
interface Message { id: number; role: 'user' | 'assistant'; text: string }

function Microphone({ size = 28 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="8" y="2" width="8" height="13" rx="4" stroke="currentColor" strokeWidth="1.7" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('offline');
  const phaseRef = useRef<Phase>('offline');
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [mode, setMode] = useState<'live' | 'fixture'>('live');
  const [notice, setNotice] = useState('');
  const [partial, setPartial] = useState('');
  const [tool, setTool] = useState('');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [finishing, setFinishing] = useState(false);
  const finishingRef = useRef(false);
  const [speechSetup, setSpeechSetup] = useState('');
  const connection = useRef<WebSocket | null>(null);
  const capture = useRef<CaptureSession | null>(null);
  const playback = useRef<PlaybackSession | null>(null);
  const generation = useRef(0);
  const nextMessage = useRef(1);
  const assistantId = useRef(0);
  const conversation = useRef<HTMLDivElement>(null);

  function transition(value: Phase) { phaseRef.current = value; setPhase(value); }
  function send(message: ClientMessage) {
    if (connection.current?.readyState === WebSocket.OPEN) connection.current.send(JSON.stringify(message));
  }

  function release() {
    generation.current++;
    transition('offline');
    finishingRef.current = false;
    setFinishing(false);
    setPartial('');
    setTool('');
    const oldCapture = capture.current;
    capture.current = null;
    void oldCapture?.stop().catch(() => {});
    playback.current?.stop();
    playback.current = null;
    const socket = connection.current;
    connection.current = null;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'end' }));
    socket?.close();
  }

  useEffect(() => {
    fetch('/api/bootstrap').then((response) => response.json()).then((status) => {
      setMode(status.mode);
      if (!status.speechConfigured) setSpeechSetup(status.speechMessage);
    }).catch(() => setNotice('The local server is unavailable. Start it and refresh this page.'));
    return () => { release(); };
  }, []);

  useEffect(() => {
    conversation.current?.scrollTo({ top: conversation.current.scrollHeight, behavior: 'instant' });
  }, [messages, partial]);

  async function start() {
    if (phaseRef.current !== 'offline') return;
    const current = ++generation.current;
    setNotice('');
    setMessages([]);
    transition('connecting');
    try {
      // Called directly by a user gesture so the browser can permit playback.
      const audio = await createPlayback();
      if (current !== generation.current) { audio.stop(); return; }
      playback.current = audio;
      const response = await fetch('/api/bootstrap');
      if (!response.ok) throw new Error('Local session initialization failed.');
      const status = await response.json();
      if (current !== generation.current) return;
      setMode(status.mode);
      setSpeechSetup(status.speechConfigured ? '' : status.speechMessage);
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/session`);
      connection.current = socket;
      socket.onopen = () => { if (current === generation.current) send({ type: 'start' }); };
      socket.onmessage = (incoming) => {
        if (current !== generation.current) return;
        let event: ServerMessage;
        try { event = JSON.parse(incoming.data); } catch { return; }
        switch (event.type) {
          case 'ready': setSpeechAvailable(event.speechAvailable); transition('ready'); break;
          case 'recording': transition('recording'); break;
          case 'partial': setPartial(event.text); break;
          case 'user': {
            setPartial(''); setTool(''); transition('responding');
            const user = nextMessage.current++;
            const assistant = nextMessage.current++;
            assistantId.current = assistant;
            setMessages((existing) => [...existing, { id: user, role: 'user', text: event.text }, { id: assistant, role: 'assistant', text: '' }]);
            break;
          }
          case 'text': setMessages((existing) => existing.map((message) => message.id === assistantId.current ? { ...message, text: message.text + event.text } : message)); break;
          case 'audio':
            try { playback.current?.enqueue(event.audio, event.sampleRate); }
            catch { setNotice('Audio playback failed. Start a new session to try again.'); release(); }
            break;
          case 'tool': setTool(event.status === 'running' ? `Reading with ${event.name.replace(/^mcp__.*?__/, '')}…` : ''); break;
          case 'response_done':
            void (playback.current?.drain() ?? Promise.resolve()).then(() => {
              if (current === generation.current) send({ type: 'playback_done' });
            });
            break;
          case 'idle': transition('ready'); setTool(''); break;
          case 'error': setNotice(event.message); if (event.fatal) release(); break;
          case 'ended': release(); break;
        }
      };
      socket.onerror = () => {
        if (current === generation.current) { setNotice('The local connection failed. Start a new session.'); release(); }
      };
      socket.onclose = () => {
        if (current === generation.current) { setNotice('Session ended. Start a new session when you are ready.'); release(); }
      };
    } catch {
      if (current === generation.current) {
        setNotice('The session could not start. Check browser audio permission and the local server.');
        release();
      }
    }
  }

  async function record() {
    if (phaseRef.current !== 'ready' || !speechAvailable) return;
    const current = generation.current;
    setNotice('');
    transition('opening');
    try {
      const microphone = await createCapture((chunk) => {
        if (current !== generation.current || phaseRef.current !== 'recording') return;
        const socket = connection.current;
        if (socket?.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 65536) {
          setNotice('The audio connection is too slow. Start a new session.');
          release();
          return;
        }
        socket.send(chunk);
      });
      if (current !== generation.current) { await microphone.stop(); return; }
      capture.current = microphone;
      send({ type: 'record' });
    } catch {
      if (current === generation.current) {
        transition('ready');
        setNotice('Microphone access is unavailable. Allow it in your browser or type a message instead.');
      }
    }
  }

  async function finish() {
    if (phaseRef.current !== 'recording' || finishingRef.current) return;
    const current = generation.current;
    finishingRef.current = true; setFinishing(true);
    const microphone = capture.current;
    capture.current = null;
    try { await microphone?.stop(); }
    finally {
      finishingRef.current = false; setFinishing(false);
      if (current === generation.current) { transition('responding'); send({ type: 'finish' }); }
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (phaseRef.current !== 'ready' || !draft.trim()) return;
    setNotice(''); transition('responding');
    send({ type: 'text', text: draft.trim() }); setDraft('');
  }

  const labels: Record<Phase, string> = {
    offline: 'Not connected', connecting: 'Opening a local session', ready: 'Ready for your next thought',
    opening: 'Opening your microphone', recording: 'Listening to you', responding: 'Working on your reply',
  };

  return <div className="app-shell">
    <header className="app-header">
      <a className="wordmark" href="/" aria-label="wave-mech home"><span className="brand-mark" aria-hidden="true">≈</span>wave-mech</a>
      <span className="local-label"><span className={`status-dot ${phase !== 'offline' ? 'connected' : ''}`} />Local voice workspace</span>
    </header>
    <main className="workspace">
      <section className="voice-panel" aria-labelledby="voice-title">
        <div className="intro"><h1 id="voice-title">Talk it through.</h1><p>A thought, a question, a next step.<br />Give it a voice.</p></div>
        <div className={`voice-station ${phase === 'recording' ? 'is-recording' : ''}`}>
          <div className="station-ring"><div className="station-core"><Microphone size={54} /></div></div>
          <p className="station-status" aria-live="polite">{labels[phase]}</p>
          <p className="station-help">{phase === 'recording' ? 'Finish your turn when you are done speaking.' : phase === 'responding' ? 'Your next turn opens after the reply finishes.' : 'One thought at a time. You control each turn.'}</p>
          {phase === 'offline' ? <button className="primary-button" onClick={() => void start()}>Start session</button>
            : <button className={`primary-button ${phase === 'recording' ? 'finish-button' : ''}`} disabled={finishing || (phase !== 'ready' && phase !== 'recording') || !speechAvailable} onClick={() => void (phase === 'recording' ? finish() : record())}>
              {finishing ? 'Finishing…' : phase === 'recording' ? 'Finish turn' : <><Microphone size={18} />Record a thought</>}
            </button>}
          <button className="quiet-button" disabled={phase === 'offline'} onClick={release}>End session</button>
        </div>
        <div className="session-notes"><span className="note-symbol" aria-hidden="true">⌁</span><p>Manual turns keep the conversation clear. Speak, finish your turn, then listen.</p></div>
      </section>
      <section className="conversation-panel" aria-label="Conversation">
        <div className="conversation-heading"><h2>Your conversation</h2><span>{mode === 'fixture' ? 'Synthetic test' : 'Claude Code'}</span></div>
        {mode === 'fixture' && <div className="fixture-banner">Test mode: synthetic responses and audio, not live inference.</div>}
        {speechSetup && <div className="setup-banner"><strong>Voice setup needed</strong><p>{speechSetup}</p></div>}
        <div className="conversation" ref={conversation} role="log" aria-live="polite" aria-label="Conversation messages">
          {messages.length === 0 && <div className="empty-conversation"><span className="empty-symbol" aria-hidden="true">“</span><h3>Room for your next idea.</h3><p>Start a session and record a thought,<br />or use the keyboard below.</p></div>}
          {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span className="speaker">{message.role === 'user' ? 'You' : 'wave-mech'}</span><p>{message.text || <span className="waiting-text">{tool || 'Thinking…'}</span>}</p></article>)}
          {partial && <div className="partial"><span>Listening</span><p>{partial}</p></div>}
          {tool && <p className="tool-note">{tool}</p>}
        </div>
        {notice && <div className="notice" role="status">{notice}</div>}
        <form className="composer" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="message-input">Type a message</label>
          <textarea id="message-input" rows={2} maxLength={12000} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={phase !== 'ready'} placeholder="Or type your thought here…" />
          <button className="send-button" disabled={phase !== 'ready' || !draft.trim()} type="submit">Send<span aria-hidden="true">↗</span></button>
        </form>
        <p className="conversation-footnote">Read-only tools. No messages sent or files changed by this voice session.</p>
      </section>
    </main>
    <footer className="app-footer"><span>Voice, with a little more agency.</span><span>Personal workspace · P1</span></footer>
  </div>;
}
