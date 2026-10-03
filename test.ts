import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import registerSelfCompact, { writeNoteBackupAtomic } from "./index.ts";

console.log("=== Testing self-compact-pi-agent (Autonomous + Auto-Continue) ===");

const registeredTools = new Map();
const registeredCommands = new Map();
const registeredHandlers = new Map();

const mockPi = {
  registerTool(tool: any) {
    registeredTools.set(tool.name, tool);
  },
  registerCommand(name: string, cmd: any) {
    registeredCommands.set(name, cmd);
  },
  on(event: string, handler: Function) {
    registeredHandlers.set(event, handler);
  },
};

registerSelfCompact(mockPi as any);

assert(registeredTools.has("self_compact"), "self_compact tool must be registered");
assert(registeredCommands.has("self-compact"), "/self-compact command must be registered");
const selfCompactTool = registeredTools.get("self_compact");
console.log("✓ Tool and command registrations verified");

// 1. Five-argument execute signature test
let compactedCalled = false;
let customPromptSeen = "";
const mockCtx: any = {
  compact: (opts: any) => {
    compactedCalled = true;
    customPromptSeen = opts.customInstructions;
  },
  ui: { notify: () => {} },
  getContextUsage: () => ({ tokens: 79000, contextWindow: 100000, percent: 79 }),
};

const abortController = new AbortController();
const res = await selfCompactTool.execute(
  "call-1",
  { note: "Goal: Test compaction\nNext: Verification" },
  abortController.signal,
  () => {},
  mockCtx
);

assert(compactedCalled, "ctx.compact must be invoked via 5-argument signature");
assert(customPromptSeen.includes("Goal: Test compaction"), "Preserve prompt must contain note");
console.log("✓ Pi 5-argument tool.execute contract verified");

// 2. Autonomous Compaction Trigger in turn_end (78% threshold)
const turnEndHandler = registeredHandlers.get("turn_end");
assert(turnEndHandler, "turn_end handler must be registered");
compactedCalled = false;
await turnEndHandler({}, mockCtx);
assert(compactedCalled, "turn_end must autonomously trigger ctx.compact at 79% token usage");
console.log("✓ Autonomous compaction trigger verified (fires at 78% before Pi built-in threshold)");

// 3. Auto-Continue Boundary Hook (Eliminates 'continue' message requirement!)
const compactHandler = registeredHandlers.get("session_compact");
const settleHandler = registeredHandlers.get("agent_before_settle");
assert(compactHandler, "session_compact handler must be registered");
assert(settleHandler, "agent_before_settle handler must be registered");

await compactHandler({});
const settleResult = await settleHandler({});
assert(settleResult?.continue === true, "agent_before_settle must return continue: true after compaction");
assert(settleResult.entries[0].content.includes("Context compaction completed successfully"), "Must include continuation message");
console.log("✓ Auto-continue boundary verified (resumes execution automatically without user typing 'continue')");

console.log("\nALL TESTS PASSED! self-compact-pi-agent is fully verified.");
