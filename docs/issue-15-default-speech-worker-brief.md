# Issue 15 — default-mode speech realtime and flow-control worker brief

Base: branch `feat/issue-15-realtime-repair` (exact SHA supplied in the launch prompt). Work on `agent/issue-15-default-speech-20260916` only. Reference: https://github.com/abel30567/wave-mech/issues/15 section 3 and the mandatory acceptance tests. Read `CLAUDE.md`, `docs/p2-worker-contract.md`, `plan/lessons.md` is not in Git; the rules below repeat what matters.

## Goal

Make the default Claude/ElevenLabs conversation feel as immediate as a native speech-to-speech product without changing the inference architecture: fast first audio, no narration of tool work, no lost or lingering audio on long answers, truthful diagnostics. Measured, not assumed.

## Ownership

You may edit: `src/shared/realtime.ts`, `src/shared/realtime-wire.ts`, `src/server/realtime/**`, `src/server/speech/**`, `src/client/realtime/**`, `tests/unit/realtime-wire.test.ts`, `tests/unit/speech-contract.test.ts`, `tests/unit/session.test.ts`, `tests/fixtures/harness.mjs`, `tests/e2e/voice.spec.ts`, and new tests/fixtures under those paths. Do not edit `src/server/index.ts`, `src/server/harness/**`, `src/server/live/**`, `src/server/security/**`, `src/client/App.tsx`, `src/client/live/**`, `src/shared/contracts.ts`, `src/shared/diagnostics.ts`, `src/shared/gpt-live-trial.ts`, package/lock/config files or GitHub workflows. If a shared-contract change outside these is unavoidable, describe the exact minimal change in your report instead of making it.

`HarnessEvent` already includes `{ type: 'result'; durationMs?; numTurns? }` and `HarnessOptions.onResult(text)` delivers the final assistant text of a turn (the text after the last tool call; the whole text when no tools ran). The default coordinator's harness factory in `src/server/index.ts` currently passes only `onEvent`; if you need `onResult` in the coordinator, add an optional `onResult` hook to `ConversationOptions.harness(onEvent, onResult?)` so main can wire it in one line, and make the coordinator tolerate its absence.

## Required behaviour

1. Speak only what a listener wants to hear.
   - Text streamed before the first tool call of a turn is synthesized immediately (this gives fast first audio).
   - Once a tool starts in a turn, stop feeding further streamed text to synthesis; the transcript still keeps all text. Finish (end-of-sequence) the open preamble synthesis right away instead of leaving it open across the tool wait.
   - When the turn completes and at least one tool ran, synthesize the final result text delivered through `onResult` (concise final answer). Do not re-speak the preamble. If no final text exists, say nothing more and report it in diagnostics.
   - Turns with no tool calls keep the existing streaming behaviour.
2. Cut first-audio latency.
   - Pre-open the ElevenLabs TTS `stream-input` socket when a turn's inference starts (token fetch and websocket open in parallel with the model), inside the existing generation/epoch fences so cancellation cannot leak a late-opened socket into a replacement turn.
   - Keep a warm socket alive during tool work with the existing single-space keepalive (never an empty string), and use the documented `inactivity_timeout` query parameter (maximum 180 s) so the socket survives long tool waits. If the warm socket closes anyway, reopen lazily on the next write; an idle warm socket closing is NOT a speech error for the response and must not raise `tts_error`.
   - Send a `flush` after each sentence boundary so short first sentences are synthesized without waiting for the provider's buffer threshold. Verify the exact frame shapes against the ElevenLabs stream-input documentation before changing `protocol.ts`; do not guess field names.
3. Consumption-based output flow control (issue section 3, bullet 3).
   - Add a client → server `playback_progress` command carrying `responseId` and the highest sequence actually played (scheduled sources that ended), sent at most every ~500 ms and on every drain. Extend `parseRealtimeCommand` and keep `REALTIME_VERSION` at 2 if the extension is backward-compatible; old clients that never report progress must still get bounded delivery (fall back to a time-based window), not a stall.
   - Server: keep a bounded per-response outbox (declare the bound in seconds of audio, e.g. 120 s), forward frames to the client only while the client's unplayed window is below a threshold (e.g. 12 s), and continue on progress reports. If the outbox bound is exceeded, mark the response `output_truncated` with an explicit diagnostic (`bufferedMs`), never drop silently. Reconnect/snapshot must re-drive delivery from the last acknowledged progress without replaying already-played audio.
   - Client: never drop frames past a 30 s ceiling. Schedule at most a small look-ahead (e.g. 8–12 s) of AudioBufferSource nodes; hold the rest in a bounded queue fed only by what the server released; report progress from `onended`. Remove `playback_overflow` as a drop path; if the queue would exceed its bound, that is a protocol violation to diagnose, not audio to discard.
4. Fence audio on failure. Whenever a response is finalized as interrupted (cancel, provider error, truncation), stop and disconnect that response's scheduled source nodes before ownership is released, so no old audio keeps playing under a new turn. Preserve pause/resume, reconnect, and barge-in behaviour.
5. Diagnostics with units. Use `bufferedMs`/`gapMs`/`durationMs` for time quantities; coalesce repeated overflow/truncation warnings into one record per response; keep `tts_first_audio`, `first_audio_received`, `first_playback_scheduled`, and add `speech_gated` (narration suppressed), `final_answer_synthesized`, `tts_prewarmed`, `output_truncated`. Never put text, URLs or provider error bodies in diagnostics.

## Mandatory tests (all deterministic, virtual time where needed, no network, no real CLI)

- Coordinator: tool turn speaks preamble then gates narration, finishes the preamble stream, and synthesizes only the final result; no-tool turn unchanged; `onResult` absent tolerated; interruption during the tool wait cancels both epochs and does not speak the late final result.
- Speech adapter: prewarm opens once per turn and is fenced by cancel; warm-idle close does not report an error; keepalive never sends an empty string; flush frames only at sentence boundaries; reopen after idle close.
- 45–90 s of generated audio delivered much faster than realtime through the actual client controller and audio scheduler coupled to the server coordinator over an in-memory transport: complete ordered playback, bounded buffers at every stage, no silent tail loss, no false `played` acknowledgement, progress-driven release observable.
- Pause/resume, reconnect and barge-in during a long answer and after a provider error: old source nodes really stop; old audio cannot enter the next response.
- Provider idle/error fixtures distinguish safe categories without exporting raw messages.
- Existing suites keep passing: `npm run check`, `WAVE_CLAUDE_BIN=/nonexistent-wave-fixture npm test`, `npm run build`, `npm run test:e2e` (chromium). Do not weaken or delete existing assertions to make them pass.

## Handoff

Commit early (within 10 minutes) and often on the assigned branch with one-sentence subjects and the trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Push after every green checkpoint. Write `docs/issue-15-default-speech-report.md` with: final SHA, exact changed paths, commands and outputs, measured first-audio latency in the fixture path before/after, remaining limitations, and anything you could not finish labelled NOT COMPLETE. Save `artifacts/result.json` (required proof, at least 100 bytes: `{ "sha": ..., "check": ..., "unit": ..., "build": ..., "e2e": ..., "notes": ... }`) and `artifacts/out.diff`. No live ElevenLabs or Anthropic calls, no credentials, no deployment, no PR to main, no force push, no nested agents.
