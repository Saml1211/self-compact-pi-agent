import assert from "node:assert";
import registerSelfCompact from "./index.ts";

console.log("=== Testing self-compact-pi-agent extension ===");

// Mock Pi ExtensionAPI
const registeredTools = new Map();
const registeredCommands = new Map();
const eventHandlers = new Map();

const mockPi = {
  registerTool(tool: any) {
    registeredTools.set(tool.name, tool);
  },
  registerCommand(name: string, cmd: any) {
    registeredCommands.set(name, cmd);
  },
  on(event: string, handler: any) {
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event).push(handler);
  },
};

// Initialize extension
registerSelfCompact(mockPi as any);

// 1. Verify Tool Registration
assert(registeredTools.has("self_compact"), "self_compact tool must be registered");
const tool = registeredTools.get("self_compact");
assert.equal(tool.name, "self_compact");
assert(tool.parameters.properties.note, "tool must accept 'note' parameter");
console.log("✓ Tool registration verified: 'self_compact'");

// 2. Verify Slash Command Registration
assert(registeredCommands.has("self-compact"), "/self-compact command must be registered");
console.log("✓ Command registration verified: '/self-compact'");

// 3. Verify Force Gate Threshold
const toolCallHandler = eventHandlers.get("tool_call")?.[0];
assert(toolCallHandler, "tool_call handler must be registered");

// Case 3a: Context is safe (50%) -> non-compaction tools allowed
const safeContext: any = {
  getContextUsage: () => ({ tokens: 50000, contextWindow: 100000, percent: 50 }),
};
const resSafe = await toolCallHandler({ toolName: "bash" }, safeContext);
assert.equal(resSafe, undefined, "bash should be allowed when context is 50%");
console.log("✓ Normal tool execution permitted under 50% usage");

// Case 3b: Context is critical (92%) -> non-compaction tools blocked
const criticalContext: any = {
  getContextUsage: () => ({ tokens: 92000, contextWindow: 100000, percent: 92 }),
};
const resBlocked = await toolCallHandler({ toolName: "bash" }, criticalContext);
assert(resBlocked?.block, "bash must be blocked when context is 92%");
assert(resBlocked?.reason?.includes("FORCE GATE"), "reason should cite FORCE GATE");
console.log("✓ Force gate blocks non-compaction tool at 92% context usage");

// Case 3c: Context is critical (92%) -> self_compact is allowed
const resAllowed = await toolCallHandler({ toolName: "self_compact" }, criticalContext);
assert.equal(resAllowed, undefined, "self_compact tool must NOT be blocked at 92%");
console.log("✓ Force gate permits self_compact tool at 92% context usage");

// 4. Verify Execution of self_compact tool and Jev Note Audit
let compactedWithInstructions = "";
const mockExecContext: any = {
  compact: (opts: any) => {
    compactedWithInstructions = opts?.customInstructions || "";
  },
  ui: {
    notify: () => {},
  },
};

const testNote = "Goal: Finish self-compact extension\nDone: Created index.ts and tests\nNext: Deploy extension";
const execResult = await tool.execute("call-1", { note: testNote }, mockExecContext);
assert(execResult.content[0].text.includes("Compaction initiated"), "tool should confirm compaction initiated");
assert(compactedWithInstructions.includes("Finish self-compact extension"), "custom instructions must preserve the note");
console.log("✓ self_compact tool executes, triggers compaction, and carries note");
if (execResult.content[0].text.includes("Jev Audit")) {
  console.log("✓ Live TypeSafe Jev note audit confirmed in tool output");
}

// 5. Verify Compaction Lifecycle Preservation
const beforeCompactHandler = eventHandlers.get("session_before_compact")?.[0];
const sessionCompactHandler = eventHandlers.get("session_compact")?.[0];
const beforeAgentStartHandler = eventHandlers.get("before_agent_start")?.[0];

assert(beforeCompactHandler, "session_before_compact handler registered");
assert(sessionCompactHandler, "session_compact handler registered");
assert(beforeAgentStartHandler, "before_agent_start handler registered");

const compactEvent: any = { customInstructions: "Standard auto-summary" };
await beforeCompactHandler(compactEvent);
assert(compactEvent.customInstructions.includes(testNote), "session_before_compact must inject carryover note");

await sessionCompactHandler();

const startEvent: any = { systemPromptOptions: {} };
await beforeAgentStartHandler(startEvent, mockExecContext);
assert(
  startEvent.systemPromptOptions.guidelines.some((g: string) => g.includes(testNote)),
  "before_agent_start must restore note into systemPrompt guidelines post-compaction"
);
console.log("✓ Post-compaction note restoration verified into session guidelines");

console.log("\nALL TESTS PASSED! self-compact-pi-agent is fully verified.");
