# self-compact-pi-agent

Autonomous context self-compaction and 3-tier threshold gate for the **Pi Coding Agent**, inspired by Dan Disler's ([IndyDevDan](https://github.com/disler)) *Tactical Agentic Coding* and augmented with **TypeSafe Jev** calibrated quality judgments.

## Core Problem Solved

Standard CLI agent harnesses default to passive auto-compaction based strictly on fixed percentage thresholds (e.g. 80-90% token capacity). This triggers arbitrarily mid-thought, mid-edit, or mid-debugging, often discarding critical uncommitted file diffs, command flags, and immediate next steps.

`self-compact-pi-agent` shifts control directly to the agent itself:
1. **Autonomous Invocation:** The agent invokes `self_compact` at natural task milestones.
2. **State & Note Preservation:** Continuation notes are saved, audited, and restored verbatim post-compaction.
3. **TypeSafe Jev Quality Audit:** Evaluates note completeness and actionability so agents don't compact with amnesia or vague notes.
4. **3-Tier Context Pressure Watchdog:**
   - **Notice (70%):** Soft advisory notifying the agent that context budget is depleting.
   - **Warning (80%):** Strong recommendation to wrap up in-flight work and trigger compaction.
   - **Force (90%):** Hard gate that locks non-compaction tools until the agent calls `self_compact`.

## Architecture & Lifecycles

```
┌────────────────────────────────────────────────────────┐
│                   Agent Turn Loop                      │
└──────────────────────────┬─────────────────────────────┘
                           │
             Check Token Usage vs Thresholds
                           │
      ┌────────────────────┼─────────────────────┐
      ▼                    ▼                     ▼
 [ < 70% Usage ]     [ 70-80% Notice ]     [ >= 90% Force ]
 Normal tool use     Advisory prompt       Blocks all tools except
                     emitted.              self_compact.
                           │                     │
                           └──────────┬──────────┘
                                      │
                         Agent calls self_compact(note)
                                      │
                         TypeSafe Jev Quality Audit
                                      │
                         Pi Compaction with Note Verbatim
                                      │
                         Post-Compaction Note Restoration
```

## Tool Specification: `self_compact`

- **Parameters**:
  - `note` (string, required): Structured continuation notes (Goal, Completed Work, In Progress, Blockers, Key Decisions, Next Steps, Critical Invariants).
  - `customInstructions` (string, optional): Extra instructions for the summarizer.
- **Jev Integration**: Calls TypeSafe Jev (`jev-latest`) to score the note on completeness (0..2), actionability (probability), and readiness (`ready` / `needs_detail` / `insufficient`).

## Configuration

Set via environment variables or default settings:
- `PI_SELF_COMPACT_NOTICE_PCT` (default: 70)
- `PI_SELF_COMPACT_WARNING_PCT` (default: 80)
- `PI_SELF_COMPACT_FORCE_PCT` (default: 90)
- `PI_SELF_COMPACT_JEV` (default: "true")
- `TYPESAFE_API_KEY` (or `~/.pi/agent/pi-jev.json`)

## Verification

Run the test suite:
```bash
node --input-type=module test.ts
```
