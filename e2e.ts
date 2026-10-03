// Real-runtime check: Pi's own AgentSession + faux provider + this extension. No network, no API spend.
// Proves the agent resumes after compaction without a human "continue".
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import selfCompact from "./index.ts";

process.env.PI_SELF_COMPACT_JEV = "false";
process.env.PI_SELF_COMPACT_STATE_DIR = mkdtempSync(join(tmpdir(), "self-compact-e2e-")); // never the real backup

async function run(name: string, reserveTokens: number, responses: any[], prompts: string | string[], onEvent?: (session: any, e: any) => void) {
  const faux = fauxProvider({ models: [{ id: "faux", contextWindow: 20000, maxTokens: 500 }] });
  faux.setResponses(responses.map((r) => (typeof r === "function" ? r : () => ({ ...r, timestamp: Date.now() }))));
  const dir = mkdtempSync(join(tmpdir(), "pi-e2e-"));
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens, keepRecentTokens: 50 } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, extensionFactories: [selfCompact], noSkills: true, noPromptTemplates: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    model: faux.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(dir),
    noTools: true,
  } as any);
  await (session as any).bindExtensions?.({});
  const events: string[] = [];
  session.subscribe((e: any) => {
    onEvent?.(session, e);
    if (["compaction_start", "compaction_end", "agent_settled"].includes(e.type)) { events.push(`${e.type}${e.reason ? ":" + e.reason : ""}`); if (e.type === "compaction_end" && process.env.E2E_DEBUG) console.log("  compaction_end", JSON.stringify({ aborted: e.aborted, err: e.errorMessage, hasResult: !!e.result })); }
  });
  for (const text of [prompts].flat()) await session.prompt(text);
  // Resume after our own compaction is asynchronous (onComplete -> sendMessage triggerTurn); wait for it.
  for (let i = 0; i < 100 && faux.getPendingResponseCount() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await (session as any).waitForIdle?.();
  const msgs = session.messages as any[];
  const roles = msgs.map((m) => (m.role === "custom" ? `custom:${m.customType}` : m.role));
  const last = msgs.at(-1);
  const lastText = Array.isArray(last?.content) ? last.content.map((c: any) => c.text ?? "").join("") : String(last?.content);
  console.log(`[${name}] events=${events.join(",")} pending=${faux.getPendingResponseCount()} roles=${roles.join(",")}`);
  session.dispose();
  return { pending: faux.getPendingResponseCount(), roles, lastText, events };
}

// A: Pi's built-in threshold compaction after the run ends (reserve 19800 of 20000 => compacts almost immediately)
const a = await run(
  "builtin-threshold",
  19800,
  [
    fauxAssistantMessage("step one done; " + "x".repeat(2000)),
    fauxAssistantMessage("## Goal\nfinish the task\n## Next\nstep two"), // compaction summary
    fauxAssistantMessage("RESUMED: step two done"),
  ],
  "do the two-step task",
);
assert.ok(a.events.some((e) => e.startsWith("compaction_end")), "built-in compaction must have run");
assert.equal(a.pending, 0, "agent must consume the post-compaction response (it resumed)");
assert.match(a.lastText, /RESUMED/);
assert.ok(a.roles.includes("custom:self_compact_continuation"), "continuation message must be in context");
console.log("✓ A: built-in threshold compaction resumes without a human 'continue'");

// B: model calls self_compact; Pi's compact() aborts the run, extension resumes via onComplete
const b = await run(
  "self_compact-tool",
  1000, // built-in threshold out of the way
  [
    fauxAssistantMessage("ack " + "z".repeat(3000)), // earlier turn = something for compaction to summarize
    fauxAssistantMessage(fauxToolCall("self_compact", { note: "Goal: ship\nNext: write RESUMED" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("## Goal\nship"), // compaction summary
    fauxAssistantMessage("RESUMED after self_compact"),
  ],
  ["background " + "context ".repeat(800), "do the task"], // prepareCompaction needs an earlier turn to cut
);
assert.ok(b.events.some((e) => e === "compaction_end:manual"), "self_compact must run a compaction");
assert.ok(b.roles.includes("compactionSummary"), "self_compact compaction must succeed, not take the failure path");
assert.equal(b.pending, 0, "agent must resume after self_compact");
assert.match(b.lastText, /RESUMED/);
console.log("✓ B: self_compact tool resumes automatically with the note");
// C: user cancels the self_compact compaction -> a cancel is a stop boundary, the agent must NOT resume
const c = await run(
  "cancelled",
  1000,
  [
    fauxAssistantMessage("ack " + "z".repeat(3000)),
    fauxAssistantMessage(fauxToolCall("self_compact", { note: "Goal: ship" }), { stopReason: "toolUse" }),
    async () => { await new Promise((r) => setTimeout(r, 800)); return fauxAssistantMessage("## summary", { timestamp: Date.now() }); },
    fauxAssistantMessage("SHOULD NOT RUN"),
  ],
  ["background " + "context ".repeat(800), "do the task"],
  (session, ev) => { if (ev.type === "compaction_start") setTimeout(() => session.abortCompaction(), 100); },
);
await new Promise((r) => setTimeout(r, 1500)); // give any (wrong) resume time to happen
assert.ok(c.events.includes("compaction_end:manual"), "compaction must have ended (cancelled)");
assert.ok(!/SHOULD NOT RUN/.test(c.lastText), "cancelled compaction must not resume the agent");
assert.ok(!c.roles.includes("custom:self_compact_continuation"), "no continuation message after a cancel");
console.log("✓ C: cancelled compaction does not resume");

// D: user stops the agent while the Jev audit is in flight -> no compaction, no resume
process.env.PI_SELF_COMPACT_JEV = "true";
process.env.TYPESAFE_API_KEY = "test-key-not-real";
const realFetch = globalThis.fetch;
globalThis.fetch = ((_url: any, opts: any) =>
  new Promise((_res, rej) => opts?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as any; // audit hangs until aborted
const dRun = await run(
  "abort-during-audit",
  1000,
  [
    fauxAssistantMessage("ack " + "z".repeat(3000)),
    fauxAssistantMessage(fauxToolCall("self_compact", { note: "Goal: ship" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("## summary"),
    fauxAssistantMessage("SHOULD NOT RUN"),
  ],
  ["background " + "context ".repeat(800), "do the task"],
  (session, ev) => { if (ev.type === "tool_execution_start" && ev.toolName === "self_compact") setTimeout(() => session.abort(), 100); },
);
await new Promise((r) => setTimeout(r, 1500));
globalThis.fetch = realFetch;
process.env.PI_SELF_COMPACT_JEV = "false";
delete process.env.TYPESAFE_API_KEY;
assert.ok(!dRun.events.some((x) => x.startsWith("compaction_start")), "stopped during audit: no compaction");
assert.ok(!/SHOULD NOT RUN/.test(dRun.lastText), "stopped during audit: no resume");
console.log("✓ D: stop during the Jev audit neither compacts nor resumes");

console.log("\nE2E PASSED");
