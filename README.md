# self-compact-pi-agent

Context lifecycle management for the [Pi coding agent](https://github.com/earendil-works/pi): the model writes its own continuation notes before history is compacted, and **the agent keeps working after any compaction** instead of waiting for you to type "continue".

## What it does

| Context usage | Action |
| --- | --- |
| 75% | Steer message to the model (it sees this, unlike a UI toast): call `self_compact` at the next boundary |
| 88% | Asks the model to call `self_compact` now. Any other tool call ends the turn, and the compaction uses a generic note |
| 94% | Ends the turn at the next tool call and compacts with a generic note (safety force gate) |

Percentages are of the **working window**: by default, the full model context window (`workingWindowTokens: 0`). You can configure an optional token cap (e.g. 200K, 300K) if you want early compaction on 1M+ models.

Pi's built-in auto-compaction fires at `contextWindow - reserveTokens` (default 16384): about 92% on 200K, 94% on 272K and 98% on 1M. The default thresholds (75/88/94%) give the agent plenty of runway while ensuring structured self-compaction triggers before Pi's unannounced built-in compaction.

**Auto-resume.** Two compaction paths used to leave the agent idle:

1. **`ctx.compact()` aborts the running agent**, so the extension never calls it mid-run. The `self_compact` tool and the 80%/88% triggers *schedule* a compaction and end the turn cleanly. The tool returns `terminate: true`, and other tool calls are blocked with `terminate`. Pi ends the turn only when every result in the batch terminates, so if the model called another tool *before* `self_compact` in the same batch, one more model request happens; any tool it calls then is blocked and ends the turn. Compaction starts after the run has settled, through Pi's own settle queue: `agent_settled` hands the job to Pi as an internal `/self-compact-run` command (`sendUserMessage` with `expandPromptTemplates`). Pi runs that queue only after every `agent_settled` handler has returned, however slow, in order, and awaits each entry. A run another extension queued ahead of it has fully ended first, and anything queued behind it waits, because the command returns only once the compaction and the resume run are over. There are no timers, so a fast or slow neighbour cannot make a run and the compaction overlap. The extension then resumes from `onComplete` with `pi.sendMessage(..., { triggerTurn: true })`, carrying the note. A failed compaction also resumes, and the auto trigger stops retrying until some compaction succeeds.
2. **Pi's built-in threshold compaction** after a run ends leaves nothing queued, so Pi settles. The extension's `agent_before_settle` hook returns `continue: true` with a continuation message.

Auto-resume is bounded: at most 2 compaction-driven resumes in a row without a turn that ends below the auto threshold, and none when the compaction left usage above that threshold. **A stop wins.** Pi skips `agent_before_settle` whenever an abort was requested, and that hook is what arms a scheduled compaction. If you stop the agent while it is still running, including right after `self_compact` returns, the scheduled compaction is dropped: no compaction and no resume. If a run that Pi drains from the settle queue ahead of the compaction is stopped, the job is dropped too. An aborted or failed run never arms one either. A **cancelled** compaction never resumes, and nothing fires after `session_shutdown`.

**Known gap (Pi 1.0.0 limit).** A stop pressed after the run has settled, while *other extensions' `agent_settled` handlers* are still running, is not seen: the session is idle, so `abort()` has nothing to abort and Pi records no trace that extensions can read. The compaction starts right after those handlers, and Esc then cancels it (a cancelled compaction never resumes). Closing the gap needs a Pi event for a stop while idle.

**Background work and subagents.** The force gate blocks only the one new tool call that crosses the line, and a scheduled compaction starts only on an idle session, so neither aborts a worker. Checked in `e2e.ts` (K): a detached background worker launched before the gate finishes with no abort, and a tool still running in the same batch as `self_compact` finishes before the compaction starts and is never handed an abort. Two limits remain, both Pi's: (1) `/self-compact` typed *mid-run* goes through `ctx.compact()`, which aborts the running turn, so tool calls in flight at that moment are cut off; use it on an idle session or let the scheduler do it. (2) If a worker reports back with `pi.sendMessage(..., { triggerTurn: true })` while the summary is being written, Pi starts that run alongside the compaction (it does not queue it). Nothing is killed, and that turn works on the pre-compaction context; this extension cannot hold another extension's message back.

`/self-compact` is yours, so it compacts immediately, and it resumes only a run it interrupted. After a failed compaction, both the auto trigger and the force gate pause until some compaction succeeds, so a failure can't deadlock the agent.

It does not resume after overflow recovery (Pi already retries), after a plain `/compact` you ran yourself, after `/self-compact` on an idle session, or after a compaction in the middle of a run (the agent is still working).

## Usage

- Tool: `self_compact(note, customInstructions?)`. Notes are optionally audited by TypeSafe Jev (`TYPESAFE_API_KEY` or `~/.pi/agent/pi-jev.json`). The latest note is backed up atomically (0600) to a **per-workspace** file, `~/.pi/state/continuation-notes/<sha256(cwd)[:16]>.md`, with a cwd header, so one repo's note is never replayed into another. Override the directory with `PI_SELF_COMPACT_STATE_DIR`; the tests use this so they never touch the real file.
- Command:
  - `/self-compact status` — inspect current token usage, working window, and threshold configuration.
  - `/self-compact enable` / `/self-compact disable` — toggle autonomous threshold compactions on or off.
  - `/self-compact set <warning|auto|force|window|jev|enabled> <val>` — update config and persist to `~/.pi/agent/self-compact.json`.
  - `/self-compact reset` — restore default thresholds.
  - `/self-compact [notes]` — compact immediately with continuation notes.

## Configuration

Configuration is loaded from `~/.pi/agent/self-compact.json` (or `PI_SELF_COMPACT_CONFIG_FILE`), falling back to `DEFAULT_CONFIG`. Environment variables override file settings:

- `PI_SELF_COMPACT_ENABLED=false` or `{"enabled": false}` disables autonomous threshold compaction (manual tool / command still works).
- `PI_SELF_COMPACT_WARNING_PCT` (nudge, default `75`), `PI_SELF_COMPACT_AUTO_PCT` (auto, default `88`), `PI_SELF_COMPACT_FORCE_PCT` (force gate, default `94`) override the threshold percentages. They must satisfy warning < auto < force.
- `PI_SELF_COMPACT_WORKING_WINDOW` or `{"workingWindowTokens": N}` sets an optional token cap (default `0` = uncapped, using the model's full window).
- `PI_SELF_COMPACT_JEV=false` disables the Jev note audit.
- Nothing runs in pi-crew subagents.

## Verification

```bash
bun run test.ts   # unit: event ordering, guards, no-resume cases
bun run e2e.ts    # real Pi AgentSession + faux provider: both resume paths; cancel, stop-during-audit and stop-after-tool = no resume; another extension's settle-time run (fast or slow, queued before or after ours) never overlaps the compaction; stop after settle; background workers survive the gate; no network
```

Both need Pi's packages resolvable, for example `NODE_PATH=$(npm root -g):$(npm root -g)/@earendil-works/pi-coding-agent/node_modules`.
