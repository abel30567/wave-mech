# wave-mech

A voice-first application built around the Claude Code harness and Fermi MCP.

## Status

Initial project setup. The voice application is not implemented yet.

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
