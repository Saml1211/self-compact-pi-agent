# self-compact-pi-agent

Autonomous context lifecycle management & structured memory preservation for the **Pi Coding Agent**, inspired by Dan Disler's ([IndyDevDan](https://github.com/disler)) *Automate Coding Agent Compaction (Context Window Engineering)*.

## Why this exists

1. **Context Decay Prevention:** Coding models lose coherence and reasoning reliability as context fills up.
2. **Autonomous Compaction Trigger:** At **78%** token pressure (before Pi's built-in 80-85% threshold), the extension autonomously triggers compaction with structured continuation state.
3. **Auto-Continue (Zero Stalling):** Uses Pi's `agent_before_settle` lifecycle hook to automatically resume execution after compaction without requiring the human to manually send "continue".
4. **TypeSafe Jev Quality Gates:** Audits continuation notes using System One (`jev-latest`) to verify completeness, readiness, and actionability before history is wiped.
5. **Prompt Guidelines Memory Anchor:** Restores preserved notes into `promptGuidelines` so the model immediately regains orientation in the fresh post-compaction context.

## Usage

- Tool: `self_compact(note, customInstructions?)`
- Command: `/self-compact [optional notes]`

## Thresholds

- **Notice (65%):** Periodic status notification.
- **Warning (72%):** Strong recommendation to wrap active subtask.
- **Auto-Compact (78%):** Autonomously triggers compaction before token window limits.
- **Force Gate (85%):** Non-compaction tools locked until state is preserved.

## Verification

```bash
bun run test.ts
```
