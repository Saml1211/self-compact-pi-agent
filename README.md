# self-compact-pi-agent

Context lifecycle management for the [Pi coding agent](https://github.com/earendil-works/pi): the model writes its own continuation notes before history is compacted, and **the agent keeps working after any compaction** instead of waiting for you to type "continue".

## What it does

| Context usage | Action |
| --- | --- |
| 70% | Steer message to the model (it sees this, unlike a UI toast): call `self_compact` at the next boundary |
| 80% | Asks the model to call `self_compact` now. Any other tool call ends the turn, and the compaction uses a generic note |
| 88% | Ends the turn at the next tool call and compacts with a generic note |

Percentages are of the **working window**: the model's context window, capped at 200K tokens. On a 1M-token model, 70/80/88% of the whole window (about 734K/839K/922K) is past the point where answer quality drops, and Pi's own compaction (window minus 16,384) would fire first. With the cap, the thresholds sit at 140K/160K/176K, in line with the 120-150K where saved talks and threads report answer quality dropping. Models with windows of 200K or less are unaffected.

Pi's built-in auto-compaction fires at `contextWindow - reserveTokens` (default 16384), about 92% on 200K, 94% on 272K and 98% on 1M, so every stage above happens first.

**Auto-resume.** Two compaction paths used to leave the agent idle:

1. **`ctx.compact()` aborts the running agent**, so the extension never calls it mid-run. The `self_compact` tool and the 80%/88% triggers *schedule* a compaction and end the turn cleanly. The tool returns `terminate: true`, and other tool calls are blocked with `terminate`. Pi ends the turn only when every result in the batch terminates, so if the model called another tool *before* `self_compact` in the same batch, one more model request happens; any tool it calls then is blocked and ends the turn. Compaction starts after the run has settled. It waits for a 100 ms quiet period, so that a run another extension queues from its own settle handler goes first, and it never compacts underneath that run. The extension then resumes from `onComplete` with `pi.sendMessage(..., { triggerTurn: true })`, carrying the note. A failed compaction also resumes, and the auto trigger stops retrying until some compaction succeeds.
2. **Pi's built-in threshold compaction** after a run ends leaves nothing queued, so Pi settles. The extension's `agent_before_settle` hook returns `continue: true` with a continuation message.

Auto-resume is bounded: at most 2 compaction-driven resumes in a row without a turn that ends below the auto threshold, and none when the compaction left usage above that threshold. **A stop during the run wins.** Pi skips `agent_before_settle` whenever an abort was requested, and that hook is what arms a scheduled compaction. If you stop the agent while it is still running, including right after `self_compact` returns, the scheduled compaction is dropped: no compaction and no resume. An aborted or failed run never arms one either. A **cancelled** compaction never resumes either, and nothing fires after `session_shutdown`.

**Known gap (Pi 1.0.0 limit).** A stop pressed *after* the run has reached `agent_before_settle` and before the compaction starts is not seen. That window covers other extensions' settle handlers plus the 100 ms quiet period. Once the run is over, Pi records no trace of an abort that extensions can read. Press Esc again: once the compaction has started, Esc cancels it, and a cancelled compaction never resumes. Closing this gap needs a Pi hook that runs after the deferred settle actions.

`/self-compact` is yours, so it compacts immediately, and it resumes only a run it interrupted. After a failed compaction, both the auto trigger and the force gate pause until some compaction succeeds, so a failure can't deadlock the agent.

It does not resume after overflow recovery (Pi already retries), after a plain `/compact` you ran yourself, after `/self-compact` on an idle session, or after a compaction in the middle of a run (the agent is still working).

## Usage

- Tool: `self_compact(note, customInstructions?)`. Notes are optionally audited by TypeSafe Jev (`TYPESAFE_API_KEY` or `~/.pi/agent/pi-jev.json`). The latest note is backed up atomically (0600) to a **per-workspace** file, `~/.pi/state/continuation-notes/<sha256(cwd)[:16]>.md`, with a cwd header, so one repo's note is never replayed into another. Override the directory with `PI_SELF_COMPACT_STATE_DIR`; the tests use this so they never touch the real file.
- Command: `/self-compact [notes]`

## Configuration

`PI_SELF_COMPACT_WARNING_PCT` (nudge), `PI_SELF_COMPACT_AUTO_PCT` and `PI_SELF_COMPACT_FORCE_PCT` override the thresholds. They must satisfy nudge < auto < force; otherwise all three fall back to the defaults. `PI_SELF_COMPACT_WORKING_WINDOW` sets the cap in tokens (default `200000`; `0` uses the model's whole window). `PI_SELF_COMPACT_JEV=false` disables the Jev audit. Nothing runs in pi-crew subagents.

## Verification

```bash
bun run test.ts   # unit: event ordering, guards, no-resume cases
bun run e2e.ts    # real Pi AgentSession + faux provider: both resume paths; cancel, stop-during-audit and stop-after-tool = no resume; another extension's settle-time run never overlaps the compaction; no network
```

Both need Pi's packages resolvable, for example `NODE_PATH=$(npm root -g):$(npm root -g)/@earendil-works/pi-coding-agent/node_modules`.
