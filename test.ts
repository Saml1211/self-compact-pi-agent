import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import registerSelfCompact, { writeNoteBackupAtomic } from "./index.ts";

console.log("=== Testing self-compact-pi-agent (Hardened) ===");

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
};

const abortController = new AbortController();
// Pi's 5-argument signature: (toolCallId, params, signal, onUpdate, ctx)
const res = await selfCompactTool.execute(
  "call-1",
  { note: "Goal: Test compaction\nNext: Verification" },
  abortController.signal,
  () => {},
  mockCtx
);

assert(compactedCalled, "ctx.compact must be invoked via 5-argument signature");
assert(customPromptSeen.includes("Goal: Test compaction"), "Preserve prompt must contain note");
assert(res.content[0].text.includes("Compaction initiated successfully"), "Success text expected");
console.log("✓ Pi 5-argument tool.execute contract verified");

// 2. Rejection of blank / whitespace notes
let threwBlank = false;
try {
  await selfCompactTool.execute("call-2", { note: "   " }, abortController.signal, () => {}, mockCtx);
} catch (e: any) {
  threwBlank = true;
  assert(e.message.includes("Continuation note cannot be empty"), "Must reject empty note");
}
assert(threwBlank, "Empty note must throw");
console.log("✓ Blank continuation note rejection verified");

// 3. Atomic backup write test
const tmpBackup = path.join(os.tmpdir(), `test-backup-${Date.now()}.md`);
const writeOk = writeNoteBackupAtomic(tmpBackup, "Atomic content check");
assert(writeOk, "Atomic backup write must succeed");
assert.equal(fs.readFileSync(tmpBackup, "utf8"), "Atomic content check");
fs.unlinkSync(tmpBackup);
console.log("✓ Atomic backup writing verified");

console.log("\nALL TESTS PASSED! self-compact-pi-agent is fully hardened.");
