# wave-mech

A voice-first application built around the Claude Code harness and Fermi MCP.

## Status

The manual-turn voice preview is implemented. Hands-free turn-taking, mobile-network recovery, and explicit tool access are the next iteration; do not treat the preview as a production service.

## Run locally

Use the Node version in `.node-version`:

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:4317`. `npm run dev` runs the development server. Inference uses the existing Claude Code CLI configuration and authentication; the application does not call an inference API directly.

For speech, provide `ELEVENLABS_API_KEY` in the server environment, or a private (0600) key file selected by `WAVE_ELEVENLABS_KEY_FILE` (default `.wave-mech/elevenlabs.key`). Never put credentials in browser code, chat, or version control. `WAVE_VOICE_ID` selects the ElevenLabs voice. An optional operator-provided token broker can use `WAVE_SPEECH_TOKEN_URL` with a `{type}` placeholder and `WAVE_SPEECH_TOKEN_AUTH`; that adapter expects POST returning JSON containing `token`.

The CLI's own configuration can select its inference route. Tool authorization is separate from inference authentication, and a working voice reply does not prove MCP tool access.

## Verify

```sh
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Browser tests launch the actual built application with synthetic microphone input and local provider/CLI fixtures. They do not contact paid inference or speech services. Linux CI runs these same checks. Live-provider and physical-phone acceptance remain separate; fixtures cannot prove recognition quality, acoustic echo handling, or network resilience.

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

Long-lived credentials stay server-side and out of source control, browser code, and logs. Consequential tool actions require appropriate confirmation. Each harness process must establish and verify its own MCP access.
