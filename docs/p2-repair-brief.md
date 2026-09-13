# Targeted P2 correctness repairs

The integration candidate builds and passes 194 unit tests, but review reproduced the failures below. It is NOT ready to deploy. Reuse these findings; do not rerun a broad review or spawn local subagents. Fix production behavior and add regression tests in the same job. Preserve the shared wire/adapter contracts unless a change is essential and reported to main.

## Client repair (claude-opus-4-8)

Own `src/client/realtime/`, `tests/e2e/`, and `playwright.config.ts`. No server/security/shared/root dependency edits.

1. `audio.ts`: ordinary onset transfers 20,480-byte pre-roll synchronously into a 16,384-byte producer backlog before its microtask drains. This aborts real utterances. Deliver bounded pre-roll incrementally/with correct capacity accounting, without inflating every queue or dropping first syllables. Add an integrated audio/client/VAD-frame reproduction, not only isolated queue tests.
2. `client.ts`: use one coherent pending-input lifecycle. Speech end can precede `input_ready`, audio ACKs, or reconnect. Keep finalization intent until readiness and contiguous receipt through lastSeq; never send finish while captured audio is unsent. Preserve and reconcile that intent when speech ends offline. Duplicate ready/ACK/snapshot/finish cannot submit inference twice.
3. Barge-in currently sends interrupt immediately followed by record; the server is still busy and rejects replacement speech. Buffer bounded replacement input and admit/retry its record only after authoritative settlement/readiness. Wire order does not serialize asynchronous handlers. Handle speech ending while cancellation is pending.
4. A paused output completion loses currentResponseId; resume then never sends playback_done. Retain the completion obligation, resume/re-establish its waiter, and acknowledge only genuine drain or explicit skip. Observe context state changes and a stopped playback clock after a drain has begun, not only at the initial check. Never advertise listening while the server still awaits playback.
5. Restore bounded output allocation/duration and remove settled response bookkeeping with safe stale-generation rejection. Slow/suspended playback must not retain unlimited audio nodes. End must stop/disconnect sources and close owned resources; cancellation must preserve the shared context.
6. Start audio initialization during the gesture but connect independently; an unanswered microphone prompt or slow WASM load must not block typed chat. Honor speechAvailable=false by skipping audio/VAD entirely. Late initialization after End must dispose resources, not attach them.
7. Bound the VAD library's own utterance retention (120 seconds), not only forwarded queues. Reset/pause its internal segment on abort/overflow; no continued unbounded retention or automatic partial-prefix commit. Ensure manual fallback flush accounts for producer/VAD work already captured.
8. Avoid cloning/redrawing the entire transcript on every audio-only frame when no visible state changes.
9. Replace obsolete P1 Record/Finish browser scenarios with genuine hands-free/reconnect/paused-audio coverage. Use injected boundary fixtures where appropriate and clearly distinguish them from real VAD/acoustic qualification. Keep at least one real production-audio/VAD asset/startup test; do not simply rename selectors or remove assertions to turn CI green.

Acceptance: initial pre-roll, early speech end, offline end, lost ACK, delayed interrupt settlement, paused-before/mid-drain resume, 2/5-second stalls, overflow/repeat notice, typed fallback while mic setup is pending, mute/end and no repeated microphone/context acquisition. Keep ordinary fixtures offline; no production credentials or paid services.

## Server repair (claude-opus-4-8)

Own `src/server/harness/`, `src/server/realtime/`, `src/server/speech/` and their tests.

1. `harness/index.ts`: failPending resolves pending interruption even on a local timeout. Acknowledgement without terminal result, no acknowledgement, and explicit interrupt rejection have reproduced late first-turn text/result being attributed to a second turn. Separate local failure from proven process-side settlement. Reject unconfirmed interruption and quarantine/close the process; a replacement send must not lift the fence while old generation output remains possible.
2. `realtime/session.ts`: interruption rejection currently falls through to clearing inferenceActive, response_cancelled and idle. Do not announce settled cancellation or reopen admission after a failed settlement. Preserve the fence and expose a clear recovery/closed outcome without fabricating continuity.
3. The busy predicate ignores the interval after inference resolves but before finishSpeech resolves. New typed input replaces the active response and mislabels its trailing audio. Remain busy through synthesis finalization and playback acknowledgement/cancellation.
4. Verify the receipt contract is truthful through speech.acceptAudio: accepted frames cannot silently disappear during provider opening/commit/overflow. Preserve final-frame commit and generation-fenced STT/TTS cancellation. Consolidate duplicate ingestion only if supported behavior and tests remain correct.

Acceptance: actual deterministic CLI subprocesses that ACK/no-result, reject interrupt, or emit late old output/results; no replacement admission/old-data contamination. Deferred TTS finish followed by attempted second input must not retag audio. Reconnect/duplicate commit tests must continue passing.

## Access-policy repair (claude-opus-4-6)

Own `src/server/security/` and its tests only.

`buildToolArguments()` currently returns only --settings with mcpServers embedded there. The installed CLI does not register MCP servers from that settings location. Emit explicit supported --mcp-config JSON (type http, supplied URL, name fermi), --strict-mcp-config, --tools WebSearch/WebFetch/ToolSearch, --permission-mode dontAsk, exact read-only preapprovals and sensitive-tool denies. Keep --settings only for the supported deny-by-default PreToolUse enforcement/settings. Do not weaken the hook or enable skills writes, secret access, generic execute, shell or other MCP servers.

Tests must inspect effective argv channels, not just the settings JSON, and exercise the actual generated hook subprocess. No auth-cache/secret reads or live runtime authentication; main has already verified the explicit Fermi connection and will perform credentialed integration checks. Do not change inference routing/authentication.

## Common handoff

- Work from the assigned immutable repair base on your assigned branch, not main.
- No global settings/infrastructure changes, secret reads, additional agents, or automatic deployment.
- Run npm ci, npm run check, npm test, npm run build; client also updates/runs the relevant browser suite. Preserve failing evidence honestly if a gate remains blocked.
- Commit and push your scoped source/tests without force. Return full SHA, actual commands/results, and remaining limitations. Keep out.diff proof; do not let proof-file mechanics turn a code task into endless retries.
- No new local GPT reviews. Main/CI will verify the combined revision. Sensitive security work uses only the required Opus 4.6 route.
