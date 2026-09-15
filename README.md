# wave-mech

A voice-first application built around the Claude Code harness and Fermi MCP.

## Status

The P2 preview supports hands-free foreground turns, bounded mobile reconnection, web/Fermi tools, and copyable conversation diagnostics. The owner has explicitly authorized automatic execution of requested Fermi actions, including consequential actions. It remains a development preview: physical iPhone acceptance and final PR merge are still pending.

## Run locally

Use the Node version in `.node-version`:

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4317`. `npm run dev` runs the development server. Inference follows the Fermi daemon pattern: a persistent Claude Code CLI process, streaming JSON I/O, native Claude login, and explicit `--model 'claude-opus-4-6[1m]'`. Authenticate with the CLI's supported `claude auth login` flow if needed. The application does not call an inference API directly.

For speech, provide `ELEVENLABS_API_KEY` in the server environment, or a private (0600) key file selected by `WAVE_ELEVENLABS_KEY_FILE` (default `.wave-mech/elevenlabs.key`). Never put credentials in browser code, chat, or version control. `WAVE_VOICE_ID` selects the ElevenLabs voice. An optional operator-provided token broker can use `WAVE_SPEECH_TOKEN_URL` with a `{type}` placeholder and `WAVE_SPEECH_TOKEN_AUTH`; that adapter expects POST returning JSON containing `token`.

The voice subprocess uses Anthropic directly, not an inherited coding proxy. The server removes inherited `ANTHROPIC_*` overrides (including API keys and proxy auth tokens), alternate-provider switches, and HTTP(S)/ALL proxy variables from that child while preserving supported Claude OAuth authentication. User/project settings are excluded from voice sessions; global settings and other agents are unchanged. The requested Opus 4.6 / 1M option must be available to the authenticated account; no fallback model is configured. Tool authorization is separate from inference authentication. The app enables `WebSearch`, `WebFetch`, `ToolSearch`, and all tools in the explicitly registered `mcp__fermi__` namespace, including Fermi execution and write capabilities. These run without app-layer tool prompts for user-requested actions. Local Claude shell/filesystem tools and unrelated MCP namespaces remain unavailable; Fermi's enforced service permissions still apply. Loading a skill is not evidence that an integration operation succeeded.

## Copy a debug transcript

Use **Copy transcript** beside the conversation heading. It copies retained conversation text plus timestamped tool attempts/outcomes, safe failure categories, and audio/connection diagnostics. Copy still works after End or disconnect; starting a new session clears the previous report. If the browser denies clipboard access, a selectable report appears instead. Nothing is uploaded automatically.

Diagnostics retain at most 200 records / 64 KiB per log and report when earlier records were omitted. Raw tool inputs/results, HTTP headers, credentials, signed URL queries, and audio are not diagnostic fields. Common credential patterns in conversation text are redacted as a best-effort precaution; **review the transcript before sharing**, since conversation text can contain personal or otherwise sensitive information. Configured and harness-reported models are labeled separately. Operators may set a non-secret `WAVE_BUILD_ID` (for example a tested commit/patch identifier); an unset build is reported as unknown, not guessed.

## Verify

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests launch the actual built application with synthetic microphone input and local provider/CLI fixtures. They cover automatic turns, reconnect/offline finalization, paused playback recovery, 2/5-second receipt stalls, production VAD/WASM startup, mute/text fallback, and session ownership. They do not contact paid inference or speech services. Linux CI runs these same checks. Live-provider and physical-phone acceptance remain separate; fixtures cannot prove recognition quality, acoustic echo handling, or cellular-network behavior.

## Intended architecture

```text
Microphone
  -> Streaming speech recognition
  -> Voice session controller
  -> Persistent Claude Code harness <-> Fermi MCP
  -> Streaming speech synthesis
  -> Speaker
```

- **Inference:** Claude Code in non-interactive mode, using supported harness authentication rather than requiring inference API keys or calling model APIs directly.
- **Tools and memory:** Fermi MCP, connected through the conversational harness.
- **Speech:** ElevenLabs for speech recognition and synthesis, not conversational inference.
- **Conversation:** Persistent context, streaming responses, natural turn-taking, and interruptible playback.

Voice sessions will be isolated from unrelated background tasks. Stopping audio playback, interrupting inference, and cancelling tool execution are separate operations; an interruption does not undo completed actions.

## Security boundaries

Long-lived credentials stay server-side and out of source control, browser code, model context, and diagnostic logs. The owner has authorized automatic Fermi actions for this private preview; there is no additional app confirmation bridge. This does not authorize actions merely because a retrieved page or skill requests them, remove Fermi's service restrictions, or grant access to unrelated local tools. Each harness process must establish and verify its own MCP access. Keep the protected preview access gate enabled.
