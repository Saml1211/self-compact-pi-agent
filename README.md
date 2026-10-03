# self-compact-pi-agent

Context lifecycle management for the [Pi coding agent](https://github.com/earendil-works/pi): the model writes its own continuation notes before history is compacted, and **the agent keeps working after any compaction** instead of waiting for you to type "continue".

## What it does

| Context usage | Action |
| --- | --- |
| 70% | Steer message to the model (it sees this, unlike a UI toast): call `self_compact` at the next boundary |
| 80% | Auto-compacts with a generic note if the model ignored the nudge |
| 88% | Blocks every tool except `self_compact` / `yield_control` |

Pi's built-in auto-compaction fires at `contextWindow - reserveTokens` (default 16384), about 92% on 200K, 94% on 272K and 98% on 1M, so every stage above happens first.

**Auto-resume.** Two compaction paths used to leave the agent idle:

1. **`ctx.compact()`**, which the `self_compact` tool, `/self-compact` and the 80% trigger all use, aborts the running agent. The extension resumes it from `onComplete` with `pi.sendMessage(..., { triggerTurn: true })`, carrying the note. A failed compaction also resumes, and the 80% trigger stops retrying until some compaction succeeds.
2. **Pi's built-in threshold compaction** after a run ends leaves nothing queued, so Pi settles. The extension's `agent_before_settle` hook returns `continue: true` with a continuation message.

Auto-resume is bounded: at most 2 compaction-driven resumes in a row without a turn that ends below the auto threshold, and none when the compaction left usage above that threshold. A **cancelled** compaction never resumes, and nothing fires after `session_shutdown`. After a failed compaction, both the auto trigger and the force gate pause until some compaction succeeds, so a failure can't deadlock the agent.

It does not resume after overflow recovery (Pi already retries), after a plain `/compact` you ran yourself, after `/self-compact` on an idle session, or after a compaction in the middle of a run (the agent is still working).

## Usage

- Tool: `self_compact(note, customInstructions?)`. Notes are optionally audited by TypeSafe Jev (`TYPESAFE_API_KEY` or `~/.pi/agent/pi-jev.json`). The latest note is backed up atomically (0600) to a **per-workspace** file, `~/.pi/state/continuation-notes/<sha256(cwd)[:16]>.md`, with a cwd header, so one repo's note is never replayed into another. Override the directory with `PI_SELF_COMPACT_STATE_DIR`; the tests use this so they never touch the real file.
- Command: `/self-compact [notes]`

## Configuration

`PI_SELF_COMPACT_WARNING_PCT` (nudge), `PI_SELF_COMPACT_AUTO_PCT` and `PI_SELF_COMPACT_FORCE_PCT` override the thresholds. They must satisfy nudge < auto < force; otherwise all three fall back to the defaults. `PI_SELF_COMPACT_JEV=false` disables the Jev audit. Nothing runs in pi-crew subagents.

## Verification

```bash
bun run test.ts   # unit: event ordering, guards, no-resume cases
bun run e2e.ts    # real Pi AgentSession + faux provider: both resume paths; cancel and stop-during-audit = no resume; no network
```

Both need Pi's packages resolvable, for example `NODE_PATH=$(npm root -g):$(npm root -g)/@earendil-works/pi-coding-agent/node_modules`.
