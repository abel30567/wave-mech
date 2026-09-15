# Opt-in GPT-Live voice trial

## Authorization and scope

The owner approved a bounded GPT-Live voice trial with the **existing Claude Code/Fermi backend**, not OpenAI Responses delegation. This explicit trial exception supersedes older blanket GPT-Live/hosted-voice prohibitions for this feature only. Current Claude/ElevenLabs remains the default. No permanent default switch, main-branch merge, global Claude configuration change, or unrelated infrastructure change is authorized.

The default/backend inference remains persistent native Claude Code, direct Anthropic `claude-opus-4-6[1m]`, supported user login, existing Fermi tool policy and interruption fencing. Do not require a new Anthropic key or route the backend through a proxy.

## API verified during planning

OpenAI model lookup returned HTTP200 for `gpt-live-1`; a live session is not yet qualified. Published `openai@7.15.0` was inspected: `client.live.create` exists, and `client.live.sessions.hangup(sessionId)` POSTs to `/live/sessions/{session_id}/hangup`. The SDK also provides `openai/resources/live/sideband/ws`; inspect its actual types instead of guessing constructor arguments. Pin the SDK version. Reuse Node HTTP and existing ws, not Express.

- https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
- https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client#configure-client-delegation
- https://developers.openai.com/api/docs/guides/voice-server-controls?api=live
- https://developers.openai.com/api/docs/guides/live-conversations#usage-and-graceful-close
- https://developers.openai.com/api/docs/models/gpt-live-1

Live WebRTC creation is server-mediated SDP through `/v1/live/sessions`, with `session.model: gpt-live-1`, `session.delegation.type: client`, and `transport.type: webrtc`. Return only required browser session/SDP data. Await `session.started`; do not send `session.start` or substitute Realtime endpoints/events. Long-lived API keys stay on the server.

## Behavior

- Show an opt-in “GPT-Live trial · Claude Code backend” choice only when enabled. Default mode stays selected. Selection alone does not create a paid session. Start is an explicit gesture; disclose OpenAI audio/reply processing and paid usage.
- Use WebRTC media/audio element for the trial, not the default PCM scheduler. Support Start/Mute/End and exceptional browser-required audio resume. End immediately stops local capture and audible output, then completes provider shutdown. Mute does not stop billing/backend work. If user-text submission is not supported by the documented Live protocol, disable it explicitly in trial mode rather than abusing instruction injection.
- Use one authenticated server sideband executor. Accumulate labeled input/output transcript fragments; `session.delegation.created` gives an opaque delegation ID/offset, not task text. Build a bounded backend request from stable available user context; never invent a task from an offset or empty transcript.
- Reuse `createHarness`, `harnessEnvironmentOverrides`, and `buildToolArguments`. One persistent harness per trial session, serialized work, deduplicated delegation IDs, stale-result fences. Speech interruption is not proof an external action was undone.
- Send structured/brief progress through `session.thinking.append`. Audible `session.commentary.append` should use coherent final backend result text, not accumulated pre-tool/API-debugging narration. Add a small typed harness final-result callback if necessary; never duplicate default-mode audio. Respect the 500-token append limit and correlate acknowledgments.
- Keep backend policy separate from voice-model/retrieved context. Preserve current user-requested Fermi authority, secure secret injection, and local-tool restrictions. Automated tests perform only read-only real-world scenarios.

## Security and budget

Suggested server settings: `WAVE_GPT_LIVE_TRIAL_ENABLED=1`, `WAVE_GPT_LIVE_API_KEY_FILE` (default `.wave-mech/openai-live.key`), `WAVE_GPT_LIVE_BUDGET_FILE` (default `.wave-mech/gpt-live-budget.json`), and `WAVE_GPT_LIVE_MAX_SESSION_SECONDS` (default and maximum300; permit shorter qualification calls). Disabled mode must not require a key or make OpenAI requests. Main provisions credentials; cloud workers use fixtures only.

The approved API operating budget is $5, separate from EC2 and Claude subscription inference. Published voice price is $0.05/minute, billed per second. Conservatively account for connected time and cumulative provider voice seconds; do not sum cumulative usage snapshots. One active voice session/mode at a time. Reuse bootstrap/owner/Origin checks; provider IDs alone do not grant control. Validate and bound SDP/request bodies. Force provider model/delegation settings server-side.

Persist reservations and session IDs atomically with0600 permissions; no reset on app restart. Reserve before creation, disable SDK creation retries, deduplicate application start requests, and do not retry uncertain POST outcomes automatically. Enforce a server timer and documented `session.close`, awaiting `session.closed`. Use the SDK's verified hangup endpoint as a fallback if needed, but retain unconfirmed usage and disable new trials if finalization/accounting is uncertain. Reconcile orphaned reservations before new paid sessions after restart. Do not claim this is a provider-enforced account-wide hard cap.

## Diagnostics and acceptance

Reuse bounded Copy transcript support. Distinguish GPT-Live voice model from configured/reported Claude backend. Capture delegation lifecycle, safe errors, cumulative voice seconds, estimated trial cost and confirmed/unknown closure. Exclude credentials, SDP/ICE secrets, raw audio and raw tool payloads.

Test owner isolation, invalid inputs, disabled mode, client-only delegation, delayed/duplicate transcripts/delegations, serialized harness use, final-versus-preamble forwarding, end/callback/transport races, restart recovery, cumulative accounting, budget cutoff, close timeouts and secret exclusion. Preserve all existing default-mode tests. Run Node22.23.2 check/unit/build and browser tests; main independently verifies and qualifies real APIs/iPhone behavior. No claim of parity or production readiness from mocks.

Keep implementation focused in new server/client live modules and trial DTOs, with surgical integration in server entry, App, harness completion metadata and transcript export. Do not redesign the existing speech stack. The live website is an installed Application Support copy; main deploys only verified code and preserves its private configuration/LaunchAgents/access gate.
