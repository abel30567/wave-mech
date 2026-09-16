# Issue 15 — default-mode speech realtime & flow-control report

Branch: `agent/issue-15-default-speech-20260916`
Base SHA: `218f578acf9a5b9add7b85f956e24d05fb3c0a5b` (branch `feat/issue-15-realtime-repair`)
Final SHA: _pending_
Model: claude-opus-4-8

## Status

Work in progress. This report is updated at each green checkpoint.

## Scope (issue #15 section 3)

1. Speak only useful text (gate narration once a tool starts; synthesize the final result via `onResult`).
2. Cut first-audio latency (prewarm TTS socket, keepalive with `inactivity_timeout`, sentence-boundary flush, tolerate idle close).
3. Consumption-based output flow control (`playback_progress`, bounded server outbox, bounded client look-ahead, `output_truncated`).
4. Fence audio on failure (stop/disconnect scheduled source nodes on interrupt/error/truncation).
5. Diagnostics with explicit units and new codes.

## Changed paths

_pending_

## Commands & outputs

_pending_

## Measured fixture first-audio latency (before/after)

_pending_

## Limitations / NOT COMPLETE

_pending_
