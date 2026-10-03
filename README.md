# self-compact-pi-agent

Context lifecycle management for the [Pi coding agent](https://github.com/earendil-works/pi): the model writes its own continuation notes before history is compacted, and **the agent keeps working after any compaction** instead of waiting for you to type "continue".

## What it does

| Context usage | Action |
| --- | --- |
| 70% | Steer message to the model (it sees this, unlike a UI toast): call `self_compact` at the next boundary |
| 80% | Asks the model to call `self_compact` now. Any other tool call ends the turn, and the compaction uses a generic note |
| 88% | Ends the turn at the next tool call and compacts with a generic note |

Pi's built-in auto-compaction fires at `contextWindow - reserveTokens` (default 16384), about 92% on 200K, 94% on 272K and 98% on 1M, so every stage above happens first.

**Auto-resume.** Two compaction paths used to leave the agent idle:

1. **`ctx.compact()` aborts the running agent**, so the extension never calls it mid-run. The `self_compact` tool and the 80%/88% triggers *schedule* a compaction and end the turn cleanly. The tool returns `terminate: true`, and other tool calls are blocked with `terminate`, so no extra model request is made. Compaction starts on `agent_settled`, once the run is over. The extension then resumes from `onComplete` with `pi.sendMessage(..., { triggerTurn: true })`, carrying the note. A failed compaction also resumes, and the auto trigger stops retrying until some compaction succeeds.
2. **Pi's built-in threshold compaction** after a run ends leaves nothing queued, so Pi settles. The extension's `agent_before_settle` hook returns `continue: true` with a continuation message.

Auto-resume is bounded: at most 2 compaction-driven resumes in a row without a turn that ends below the auto threshold, and none when the compaction left usage above that threshold. **Stopping wins.** Pi skips `agent_before_settle` whenever an abort was requested, and that hook is what arms a scheduled compaction. If you stop the agent after `self_compact` returns, the scheduled compaction is dropped: no compaction and no resume. A **cancelled** compaction never resumes either, and nothing fires after `session_shutdown`.

One window remains, and Pi 1.0.0 gives extensions no way to see it: a stop pressed after `agent_before_settle` but before `agent_settled`. That is only as long as the other extensions' settle handlers take. Pressing Esc while the compaction runs still cancels it.

`/self-compact` is yours, so it compacts immediately, and it resumes only a run it interrupted. After a failed compaction, both the auto trigger and the force gate pause until some compaction succeeds, so a failure can't deadlock the agent.

It does not resume after overflow recovery (Pi already retries), after a plain `/compact` you ran yourself, after `/self-compact` on an idle session, or after a compaction in the middle of a run (the agent is still working).

## Usage

- Tool: `self_compact(note, customInstructions?)`. Notes are optionally audited by TypeSafe Jev (`TYPESAFE_API_KEY` or `~/.pi/agent/pi-jev.json`). The latest note is backed up atomically (0600) to a **per-workspace** file, `~/.pi/state/continuation-notes/<sha256(cwd)[:16]>.md`, with a cwd header, so one repo's note is never replayed into another. Override the directory with `PI_SELF_COMPACT_STATE_DIR`; the tests use this so they never touch the real file.
- Command: `/self-compact [notes]`

## Configuration

`PI_SELF_COMPACT_WARNING_PCT` (nudge), `PI_SELF_COMPACT_AUTO_PCT` and `PI_SELF_COMPACT_FORCE_PCT` override the thresholds. They must satisfy nudge < auto < force; otherwise all three fall back to the defaults. `PI_SELF_COMPACT_JEV=false` disables the Jev audit. Nothing runs in pi-crew subagents.

## Verification

```bash
bun run test.ts   # unit: event ordering, guards, no-resume cases
bun run e2e.ts    # real Pi AgentSession + faux provider: both resume paths; cancel, stop-during-audit and stop-after-tool = no resume; no network
```

Both need Pi's packages resolvable, for example `NODE_PATH=$(npm root -g):$(npm root -g)/@earendil-works/pi-coding-agent/node_modules`.
