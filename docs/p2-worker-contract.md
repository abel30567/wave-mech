# P2 integration contract

Implement code and tests, not another design phase. P2 adds hands-free foreground conversation, bounded mobile recovery, and explicit read-only web/Fermi access. Keep existing CLI inference routing; no API replacement, secrets, auth-cache extraction, global settings changes, infrastructure changes, nested agents, or merges to main.

## Shared contracts (main-owned, do not edit)

`src/shared/realtime.ts`, `realtime-wire.ts`, and `access-contracts.ts` are the integration API. Legacy contracts remain buildable while main integrates the new UI/server entry. Request a contract change instead of inventing incompatible fields.

Audio frames have a 12-byte header: uint16 magic 0x574d, uint8 version 2, uint8 reserved 0, uint32 turnId, uint32 seq, all header integers big-endian; remainder is mono PCM16 little-endian at 16 kHz. Use the shared encoder/decoder. Sequence numbers start at 1. A finish declares the last audio sequence. JSON `hello` is the first command; main authenticates/attaches the socket before forwarding commands. Session/connection ownership is not encoded in user-controlled audio bytes.

## Client worker ownership and exports

Own only `src/client/realtime/` and its tests/fixtures. Reuse the existing PCM resampler if useful but do not edit legacy UI or shared/root files. Export:

- `audio.ts`: `createHandsFreeAudio(options: HandsFreeAudioOptions): Promise<HandsFreeAudio>`.
- `client.ts`: `createConversationClient(options: ConversationClientOptions): ConversationClient`.

Client owns its reconnecting WebSocket transport, outstanding PCM FIFO and hands-free control. Main UI renders `ConversationView` and calls start/sendText/mute/resumeAudio/end. Start invokes audio creation directly in the gesture before unrelated awaits, then calls refreshAccess and connects. `refreshAccess` is supplied by main (same-origin bootstrap); call before reconnect too. Preserve known sessionId in hello; never silently replace expired context.

Use the pinned installed `@ricky0123/vad-web` 0.0.31 and `onnxruntime-web` 1.29.0. Matching assets are copied by main to `/vad/` during build. Actual package declarations document MicVAD.new, supplied audioContext, getStream/pauseStream/resumeStream, startOnLoad, onSpeechRealStart/onSpeechEnd/onVADMisfire. Select v5 explicitly; use one WASM thread and no CDN asset loads. Dynamically load browser-only code so Node unit tests can inject audio/socket factories without importing browser globals. Do not invent SDK method names.

One shared stream/context lasts for the session. `setMode('listen'|'barge')` arms detection; paused/muted suppress uploads and rearming, with muted tracks disabled. Confirmed onset calls onSpeechStart synchronously before emitting PCM pre-roll. Then emit each live sample once. VAD's returned whole-segment array is an endpoint signal, not a second copy to send. Speech end triggers producer flush/ACK and transport finish; never close the mic between turns. `flushInput` must account for worklet frames posted before the barrier.

Keep pre-roll, producer/MessagePort backlog, unsent and unacknowledged audio bounded using the shared constants; do not allocate the entire budget independently at each stage. Bound VAD's full utterance memory separately (existing maximum 120 seconds). No speculative acoustic RMS detector presented as reliable VAD. Handle main-thread stalls/discontinuity explicitly rather than committing a truncated prefix.

Record input may be buffered while waiting for input_ready. Retransmit only above cumulative audio_ack. A transient transport fault reconnects automatically; it does not send end or clear messages. On overflow pause/abort the unfinished input and require a repeat notice, preserving context. On snapshot, reconcile the authoritative input/response state; do not rerun accepted commands. Track turnId/responseId and drop stale events.

On barge-in clear output immediately without closing the shared context, request interrupt for the current response, and hold the new turn until server state permits it. Keep queued input bounded during settlement. A cancelled/paused drain is not a successful playback acknowledgement: send playback_done with skipped=true only for explicit cancellation/fallback, not for an unexplained clock stall. Expose paused/resume-audio state; do not leave the UI working indefinitely. End closes everything once, including asynchronously created resources.

## Server worker ownership and exports

Own `src/server/realtime/`, `src/server/harness/`, `src/server/speech/`, and tests/fixtures within them. Export `createConversation(options: ConversationOptions): RetainedConversation` from `src/server/realtime/session.ts`. Do not edit legacy `src/server/session.ts`, server entry, UI, shared/root files, credential broker, or security helpers.

Main owns authentication, single-session registry, connection epoch, and the 120-second detach expiry. Coordinator owns conversational state; attach sends an authoritative snapshot, detach removes the sink and suppresses uncertain audio while retaining context. `start` initializes the harness without a hidden inference warm-up. Explicit end/close releases it. A stale socket must not be given authority by the coordinator; main only forwards commands from its current attachment.

Turn IDs increase within the session. Reserve IDs/state before awaits. Duplicate record/finish/text calls with identical content return existing status/ACK; conflicting reuse fails. Audio must be contiguous, accepted exactly once, and bounded by size/count/duration. Keep enough fingerprints/state to detect conflicting duplicate frames without unbounded retention. Emit audio_ack only after the speech adapter actually accepts the frame; provider recognition success is not implied. Finish verifies declared lastSeq and commits once. Audio/STT failure resets only the unfinished input and reports a repeat notice; already accepted inference must not be replayed.

Add optional compatibility methods on existing adapters: harness.interrupt(); speech.acceptAudio(pcm): boolean, abortRecognition(), cancelSpeech(). Main adapts them to the required realtime interfaces. Preserve P1 exports/tests. acceptAudio must not silently report success when closed, absent, committing, over-limit, or unable to enqueue. Separate STT/TTS epochs: late callbacks and pending token/socket opening after cancellation cannot mutate the replacement turn.

CLI interruption uses the supported control_request interrupt message, bounded receipt/whole-turn settlement handling and generation fencing; rejecting the local send Promise alone is not cancellation. If no active inference (only playback), don't wait for a nonexistent result. Never admit overlapping inference or continue after an unconfirmed settlement. Record MCP connection metadata from system/init when present; tool_result is_error must become failed/denied, not done. Unknown/malformed protocol data must fail safely without dumping secrets.

Response events carry responseId/turnId and sequential audio IDs. Completion declares lastAudioSeq. A disconnected response can finish into retained text without continuing unbounded unheard TTS. On resume provide text/current status and report interrupted audio; no automatic replay of possibly heard audio. Bound transcript/output retention explicitly; do not silently reset model context.

## Security worker ownership and exports

Own only `src/server/security/` and its tests. Use claude-opus-4-6. No actual runtime authentication, secret reads, writes to global settings, or other directories.

- `access-policy.ts`: export `buildToolArguments(options: ToolAccessOptions): string[]` and `permissionHookSource(): string`.
- `identity.ts`: export `createSessionIdentity(options?: IdentityOptions): SessionIdentity`, `readOwnerCookie(header: string | undefined): string | undefined`, and `ownerCookieHeader(token: string, secure?: boolean): string`.

Tool arguments supplement the common -p/stream-json/verbose/setting-sources flags (main-owned). Enable only WebSearch, WebFetch, ToolSearch plus explicit HTTP MCP server named fermi at the provided HTTPS URL. Preapprove only those built-ins and mcp__fermi__memory_recall/skill_search/skill_load. Keep dontAsk, strict MCP config and explicit sensitive-tool denies. Do not assume allowedTools alone is an availability restriction.

Implement a deny-by-default supported PreToolUse command hook as a narrow enforcement layer: permissionHookSource produces a standalone Node script (main writes it to its private workspace), reads bounded hook JSON from stdin and emits documented hookSpecificOutput/PreToolUse permissionDecision allow only for the exact whitelist, deny otherwise. Check official CLI hooks docs; no global hooks/settings changes. Build --settings JSON with that hook using safely quoted provided nodeExecutable/hookFile. Do not interpolate tool input into shell. Test the actual generated hook process for allow/deny/malformed/oversized input and shell-path quoting. If this supported enforcement cannot be implemented, report the blocker instead of broadening privileges.

Identity is a stateless signed, expiring per-browser capability using Node crypto, random owner ID, constant-time verification and optional test secret/clock. No shared global owner identity. Reject malformed/forged/expired/future tokens. Cookie name wave_owner, HttpOnly, SameSite=Strict, Path=/; Secure when requested (the existing HTTPS proxy also adds Secure). Main reuses a valid owner cookie on bootstrap; sessionId alone never authorizes resume. No auth database or inference credential manipulation.

## Handoff and verification

Use npm ci, npm run check, npm test, npm run build. Add unit/fixture tests for your cases; main adds combined browser/WebKit/live checks. Do not weaken existing tests or policies. Return branch/full SHA, exact changed paths, actual commands/results, remaining limitations and model metadata. Commit to your assigned agent/p2-* branch only, no force push or merge to main; upload out.diff. Include the required concise commit subject and Claude Code coauthor trailer. Main performs combined-SHA CI and actual credentialed tool/voice verification. No plaintext credentials, private operational config, personal screenshots or generated VAD assets in commits.
