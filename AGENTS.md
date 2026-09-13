# wave-mech development

A Linux-compatible web application: browser microphone → ElevenLabs STT → persistent Claude Code CLI → ElevenLabs TTS → playback. P1 is the existing manual-turn baseline. The approved P2 work adds hands-free foreground conversation, mobile recovery and explicit read-only tools. Read `docs/p2-worker-contract.md` and the shared realtime contracts before implementing P2. No direct inference APIs. Keep long-lived credentials out of source, browser, model context and logs. Consequential tools and skill creation stay disabled.

## Working agreement

- Use the pinned Node version and `npm ci`. Commands: `npm run check`, `npm test`, `npm run build`; browser tests are added by the integrator.
- Implement the assigned feature AND its tests in the same job. Do not weaken shared tests/configuration or add a new orchestration platform.
- Work only in your assigned directories. Shared contracts are in `src/shared/contracts.ts`; request changes rather than editing that file or package/lock/CI files.
- Main session owns server entry/registry, UI shell, credential integration, dependencies/assets, shared contracts and combined browser tests.
- P2 client worker owns `src/client/realtime/`; P2 server worker owns `src/server/realtime/`, `src/server/harness/` and `src/server/speech/`; security worker owns `src/server/security/`. Keep tests/fixtures in owned directories. Do not edit another worker's files.
- The legacy adapter interfaces below remain compatible during integration; new exports and authoritative P2 semantics are in `docs/p2-worker-contract.md`.
- Use `.js` import specifiers in Node TypeScript source. Keep code strict-TypeScript compatible. Browser worklets must bundle with Vite (use `?worker&url` or a verified equivalent).
- No production credentials or authenticated external actions for synthetic tests. Use fixture subprocesses, local WebSockets, and synthetic PCM.
- General fleet model: claude-opus-4-8 or grok-4.6; security-specific fleet work: claude-opus-4-6. Verify actual model rather than silently substituting.
- Delegated work must use Fermi cloud execution, not local GPT subagents or auto-fanout review skills. Do not spawn further agents. For the targeted repair wave, `docs/p2-repair-brief.md` defines the defects and the precise ownership exceptions (including client browser tests); reuse those findings rather than repeating a broad review.
- Return source commit/branch, test commands and actual outcomes, and limitations. An artifact or agent completion claim is not proof tests passed.
- Commit only on the assigned feature branch, never main. Concise one-sentence commit subject with `Co-Authored-By: Claude Code <noreply@anthropic.com>` trailer. Do not merge, create additional agents, or change infrastructure.

## Adapter exports

- Harness: `src/server/harness/index.ts` exports `createHarness(options: HarnessOptions): HarnessSession`.
- Speech: `src/server/speech/index.ts` exports `createSpeech(options: SpeechOptions): SpeechSession`.
- Browser capture: `src/client/audio/capture.ts` exports `createCapture(onChunk: (pcm: ArrayBuffer) => void): Promise<CaptureSession>`; chunks are mono signed little-endian PCM16 at 16 kHz.
- Browser playback: `src/client/audio/playback.ts` exports `createPlayback(): Promise<PlaybackSession>`; enqueue accepts raw PCM16 base64 at the given sample rate. `drain()` waits for already queued audio; `stop()` immediately clears it.
- Harness `start()` spawns the process without an unrequested inference warm-up. `send()` admits one turn and resolves only on its final result; rejects overlap/errors/timeouts. `close()` is idempotent and settles pending work.
- Speech `startRecognition()` establishes one manual-input turn; `commitRecognition()` returns committed text once. `writeText()` accepts incremental fragments; `finishSpeech()` flushes and waits for final audio, allowing a new subsequent turn. `close()` is idempotent.
- P1 main does not admit another user turn until both the harness and speech have completed and the browser acknowledges playback drain. Audio adapters do not implement the application turn coordinator.
