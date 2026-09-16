# Issue 15 — default-mode speech realtime & flow-control report

Branch: `agent/issue-15-default-speech-20260916`
Base SHA: `218f578acf9a5b9add7b85f956e24d05fb3c0a5b` (branch `feat/issue-15-realtime-repair`)
Tested code SHA: `6d93d742d99415cc0cc2c089a317fd10e1c08e9f` (this doc/artifact commit adds no code)
Model: claude-opus-4-8

## Status: COMPLETE (all five behaviours implemented and tested; all suites green)

## Commands & outcomes

| Command | Result |
| --- | --- |
| `npm ci` | ok (0 vulnerabilities) |
| `npm run check` (`tsc --noEmit`) | pass |
| `WAVE_CLAUDE_BIN=/nonexistent-wave-fixture npm test` | **494 passed / 30 files** (was 475 at base) |
| `npm run build` | pass (client bundle built) |
| `npx playwright install --with-deps chromium` | ok |
| `npm run test:e2e` | **25 passed** (chromium) |

Node 22.23.2 (`.node-version`). No network, no real CLI, no live ElevenLabs/Anthropic/OpenAI calls, no credentials.

## What changed (all within owned paths)

1. **Speak only useful text** (`src/server/realtime/session.ts`).
   - Pre-tool narration is streamed to TTS for fast first audio.
   - On the first tool of a turn, streamed narration is gated (kept in the transcript, no longer synthesized) and the open preamble stream is ended (EOS) immediately rather than left open across the tool wait.
   - When a turn used tools, only the concise final answer delivered via `onResult` is synthesized (never the preamble/interim narration). Absent final text says nothing more and is reported.
   - No-tool turns keep the existing streaming behaviour.
   - `ConversationOptions.harness(onEvent, onResult?)` gained the optional `onResult` hook (coordinator wires it; tolerates absence).

2. **Cut first-audio latency** (`src/server/speech/index.ts`, `protocol.ts`).
   - `prewarm()` pre-opens the TTS `stream-input` socket (token fetch + ws open) when inference starts, fenced by the synthesis epoch so a cancel cannot leak a late socket.
   - Warm socket kept alive with the single-space keepalive (never an empty string) plus the documented `inactivity_timeout=180` query param. An idle warm-socket close is treated as benign (`tts_idle_closed`, not `tts_error`) and reopened lazily on the next write.
   - `flush` frame (`{ text: '', flush: true }`) is sent at sentence boundaries; EOS (`{ text: '' }`) is kept distinct. Frame shapes verified against the ElevenLabs stream-input docs.

3. **Consumption-based output flow control** (`src/shared/realtime*.ts`, `src/server/realtime/session.ts`, `src/client/realtime/{client,audio}.ts`).
   - New `playback_progress { responseId, seq }` command; `REALTIME_VERSION` unchanged at 2 (backward-compatible).
   - Server: bounded per-response outbox (120 s); frames forwarded only while the client's unplayed window is below 12 s; released on progress or, for old clients that never report, a realtime time-based fallback (no stall). Outbox-bound overflow marks the response `output_truncated` with a `bufferedMs` diagnostic (coalesced) instead of a silent drop.
   - Client: bounded look-ahead of ≤12 s of AudioBufferSource nodes, the rest held in a bounded queue fed by what the server releases; progress reported from `onended` (throttled ≤500 ms + on drain). The old 30 s `playback_overflow` drop path is removed; exceeding the hold bound is diagnosed (`output_truncated`) and fenced, never dropped.

4. **Fence audio on failure** (`src/client/realtime/audio.ts`).
   - Cancel/interrupt stops and disconnects the response's scheduled source nodes **and** drops its held (unscheduled) frames before ownership is released, so no old audio plays under a new turn. Pause/resume, reconnect and barge-in preserved.

5. **Diagnostics with units** — new codes `speech_gated`, `final_answer_synthesized`, `tts_prewarmed`, `output_truncated`, `tts_idle_closed`; `bufferedMs` used for buffered audio; existing `tts_first_audio`/`first_audio_received`/`first_playback_scheduled` retained; overflow/truncation coalesced to one record per response. No text/URLs/provider bodies in diagnostics.

## Measured fixture-path first-audio latency (before/after)

Measured on the fixture speech path with a simulated 40 ms token-fetch + websocket-handshake latency (the local fixture otherwise opens instantly), 8 runs each, time from the first `writeText` to the first audio frame:

| Path | First-audio latency |
| --- | --- |
| Cold (no prewarm — socket opens on first text) | **~44.0 ms** |
| Warm (prewarm during inference) | **~0.6 ms** |
| Improvement | **~43 ms** (the socket-open cost is moved off the critical path) |

The absolute number scales with real token/handshake latency; the mechanism removes it from the time-to-first-audio entirely.

## Tests added / updated (failing-before / passing-after regressions)

- `src/server/realtime/gating.test.ts` (new): preamble spoken → narration gated at tool → only final answer synthesized; no-tool unchanged; `onResult` absent tolerated; interrupt during the tool wait cancels both epochs and never speaks the late final.
- `src/server/realtime/flow-control.test.ts` (new): window-bounded forwarding, progress-driven release, old-client time-based fallback, outbox-bound truncation with `bufferedMs`.
- `src/client/realtime/integration.test.ts` (new): 60 s of audio through the **real** client controller + audio scheduler coupled to the server coordinator over an in-memory transport — complete ordered delivery, ≤12-node look-ahead, progress-driven release, genuine `played` completion.
- `src/server/speech/speech.test.ts`: prewarm-once-and-fenced-by-cancel, sentence-boundary flush, non-empty keepalive, idle-close-is-benign + lazy reopen (this last one replaces the pre-issue-15 assertion that an idle close was an error — a behaviour the brief explicitly overturns).
- `src/client/realtime/audio.test.ts`: bounded look-ahead + hold (no drop) with progress up to the declared last seq; hold-bound overflow diagnosed not dropped; held-frame fence on cancel. Replaces the two pre-issue-15 assertions that encoded the removed 30 s silent-drop path.
- `tests/unit/{realtime-wire,speech-contract}.test.ts`: `playback_progress` parsing; `ttsForceFlushFrame`/`inactivity_timeout` contract.
- `src/server/realtime/session.test.ts`: the detach test now asserts the real invariant (no audio grows after detach) instead of "never any audio", since prewarm+preamble-EOS can legitimately deliver heard audio before the detach.

No existing assertion was weakened merely to pass; the three updated tests encode behaviour the brief mandates changing, and each is strengthened where possible.

## Limitations / notes for main

- **Prewarm wiring for the latency win in production**: `prewarm()` is exposed on the speech adapter and called by the coordinator via the optional `RealtimeSpeech.prewarm?()`. `src/server/index.ts` (main-owned, not edited) must map `prewarm` into its `RealtimeSpeech` adapter (one line, mirroring the other methods) for the latency benefit to apply in the live path; the coordinator tolerates its absence. Likewise main should pass `onResult` into `ConversationOptions.harness`. Both are additive optionals.
- **Reconnect re-drive**: the existing coordinator deliberately suppresses a detached response's audio (`audioInterrupted`) and does not resume unheard TTS on reattach (per the p2 contract "no automatic replay of possibly heard audio"). The flow-control outbox therefore does not re-drive delivery after a reconnect; this preserves the established suppress-on-detach contract rather than replaying possibly-heard audio. If full post-reconnect re-drive from the last acknowledged progress is desired, it would relax that suppression and is called out here rather than changed unilaterally.

## NOT COMPLETE

None. All five section-3 behaviours and their mandatory tests are implemented and green.
