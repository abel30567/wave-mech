# GPT-Live Contract Verification Report

Worker: `agent/gpt-live-contract-verify-20260915`
Base: `5bf8c53` (feat/gpt-live-integrated-20260915)
Model: claude-opus-4-6 | Node 22.23.2

## Findings and Fixes

### P1: End + diagnostics ACTUAL CONTRACT — FIXED

**Bug**: `getDiagnostics()` returned empty default state after `finishCleanup()` set `this.active = null`. The `/diagnostics` endpoint returned the null-session default (no sessionId, no transcript, no closure info) immediately after End. Browser tests passed because they mocked the server response.

**Fix**: Added `lastDiagnosticSnapshot` field that captures a full diagnostic snapshot in `finishCleanup()` before clearing `this.active`. `getDiagnostics()` now falls back to this snapshot when no active session exists. Added owner-bound access: `getDiagnostics(ownerId?)` returns empty diagnostics if the caller's ownerId doesn't match the session owner.

**Fix**: `/end` handler now checks `getSessionOwnerId()` against the requesting owner before allowing close.

### P2: Fresh complete delegated input — FIXED

**Bug**: `assembleUserContext()` joined ALL user transcript entries across the session lifetime. When a new delegation arrived, it would assemble the same old user input (e.g., "buy 100 shares of AAPL") and re-execute it — a critical consequential-action safety issue.

**Fix**: Added `inputCursor` field to `ActiveTrialSession`. After each delegation's `send()` settles, the cursor advances to `session.transcript.length`. `assembleUserContext()` now only reads entries at or after the cursor. New delegations must have genuinely new user input to execute; stale delegations without fresh input time out safely via the existing `DELEGATION_INPUT_TIMEOUT_MS` (3s).

### P3: Final result delivery — VERIFIED, PARTIAL

**Verified working**: Chunked commentary preserves full text (<=500 UTF-8 bytes per chunk). Provider `sendCommentary` errors are caught and non-fatal. End during in-flight send is properly fenced — late results after close are not sent.

**NOT COMPLETE**: SDK acknowledgment correlation for `CommentaryAppendedEvent`. The current provider adapter calls `sideband.send()` which returns void. The SDK `CommentaryAppendedEvent` carries `client_event_id` matching the command `event_id`, but the adapter doesn't generate command event IDs or track acknowledgments. This would require an optional-compatible extension to the provider adapter. Labeled as future work — does not affect correctness, only delivery confirmation.

### P4: Billing/transport stop conditions — VERIFIED

All five edge cases verified:

1. **Unknown create before session ID**: `markCreationAttempted` persists before provider POST. Remains locked across restart via `reconcileOrphans`.
2. **Persist-failure latch**: `_saveFailed` flag blocks new sessions permanently.
3. **Sync-close race**: `closeSession` checks `session.closing` flag — idempotent.
4. **Valid >300s actual usage retained**: `finalize` and `confirmClosure` do not cap at 300s.
5. **Corrupt ledger rejected**: Non-finite `cumulativeUsageUsd`, invalid reservation shapes, and duplicate session IDs all throw on load.

**NOT COMPLETE**: Automatic orphan reconciliation. Only lockout is implemented. `reconcileOrphans()` flags uncertain reservations but does not automatically query the provider to confirm actual usage. Manual `confirmClosure(sessionId, voiceSeconds)` is the only resolution path. This is by spec design — the system fails closed rather than guessing.

### P5: Scope/credentials/cleanup — FIXED

- `/end` handler: Added owner check via `getSessionOwnerId()` before allowing close.
- `/diagnostics` handler: Passes `ownerId` to `getDiagnostics()` for owner-bound access.
- Transcript bounded to 500 entries (existing).
- No raw credential fields (apiKey, SDP, ICE) in diagnostics output (existing).
- `getSessionOwnerId()` returns the owner of the active or most-recently-closed session.

## Test Evidence

| Suite | Count | Status |
|-------|-------|--------|
| Unit tests | 465 (was 442) | PASS |
| Test files | 26 (was 25) | PASS |
| Browser — default voice | 14 | PASS |
| Browser — GPT-Live trial | 9 | PASS |
| Type check (tsc --noEmit) | — | PASS |
| Build (vite + tsc server) | — | PASS |

New test file: `tests/unit/contract-verification.test.ts` (22 tests across 5 priority areas).

All runs used `WAVE_CLAUDE_BIN=/nonexistent-wave-fixture` — no live inference.

## Not Performed

- Real OpenAI provider API calls
- iPhone/mobile qualification
- Live WebRTC media verification
- Production credential integration

## Remaining Gates for Main

1. SDK acknowledgment correlation for commentary delivery (P3)
2. Automatic orphan reconciliation with provider API (P4)
3. Real provider/iPhone qualification
