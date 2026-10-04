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
delete process.env.PI_CREW_KIND; // the gate is off inside pi-crew subagents; the test must not inherit that
delete process.env.PI_CREW_DEPTH;
process.env.PI_SELF_COMPACT_STATE_DIR = mkdtempSync(join(tmpdir(), "self-compact-e2e-")); // never the real backup

let extra: any[] = []; // other extensions loaded beside self-compact
let current: any;
async function run(name: string, reserveTokens: number, responses: any[], prompts: string | string[], onEvent?: (session: any, e: any) => void, opts: { window?: number; extraFirst?: boolean; afterMs?: number } = {}) {
  const faux = fauxProvider({ models: [{ id: "faux", contextWindow: opts.window ?? 20000, maxTokens: 500 }] });
  if (opts.window) {
    // the faux provider simulates prompt caching, which inflates usage; the capped-window cases need exact token counts
    for (const key of ["stream", "streamSimple"]) {
      const original = (faux.provider as any)[key];
      (faux.provider as any)[key] = (m: any, c: any, o: any) => original(m, c, { ...o, cacheRetention: "none" });
    }
  }
  faux.setResponses(responses.map((r) => (typeof r === "function" ? r : () => ({ ...r, timestamp: Date.now() }))));
  const dir = mkdtempSync(join(tmpdir(), "pi-e2e-"));
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens, keepRecentTokens: 50 } });
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, extensionFactories: opts.extraFirst ? [...extra, selfCompact] : [selfCompact, ...extra], noSkills: true, noPromptTemplates: true });
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
  current = session;
  const events: string[] = [];
  session.subscribe((e: any) => {
    onEvent?.(session, e);
    if (["compaction_start", "compaction_end", "agent_settled"].includes(e.type)) { events.push(`${e.type}${e.reason ? ":" + e.reason : ""}`); if (e.type === "compaction_end" && process.env.E2E_DEBUG) console.log("  compaction_end", JSON.stringify({ aborted: e.aborted, err: e.errorMessage, hasResult: !!e.result })); }
  });
  for (const text of [prompts].flat()) await session.prompt(text);
  // Resume after our own compaction is asynchronous (onComplete -> sendMessage triggerTurn); wait for it.
  for (let i = 0; i < 100 && faux.getPendingResponseCount() > 0; i++) await new Promise((r) => setTimeout(r, 50));
  await (session as any).waitForIdle?.();
  if (opts.afterMs) await new Promise((r) => setTimeout(r, opts.afterMs)); // let any (wrong) late compaction or resume happen
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

// B: model calls self_compact; the tool ends the turn (terminate, no extra model request), the
// compaction starts once the run has settled, and the extension resumes via onComplete
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

// E: user stops right after the self_compact tool returns (before Pi could start any compaction).
// The old design compacted and resumed anyway; Pi skips agent_before_settle on a stop, so now nothing runs.
const eRun = await run(
  "stop-after-tool",
  1000,
  [
    fauxAssistantMessage("ack " + "z".repeat(3000)),
    fauxAssistantMessage(fauxToolCall("self_compact", { note: "Goal: ship" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("## summary"),
    fauxAssistantMessage("SHOULD NOT RUN"),
  ],
  ["background " + "context ".repeat(800), "do the task"],
  (session, ev) => { if (ev.type === "tool_execution_end" && ev.toolName === "self_compact") void session.abort(); },
);
await new Promise((r) => setTimeout(r, 1500));
assert.ok(!eRun.events.some((x) => x.startsWith("compaction_start")), "stopped after the tool: no compaction");
assert.ok(!/SHOULD NOT RUN/.test(eRun.lastText), "stopped after the tool: no resume");
assert.equal(eRun.pending, 2, "neither the summary nor the resume response was requested");
console.log("✓ E: stop right after self_compact returns neither compacts nor resumes");

// F: another extension continues the run from its (slow) agent_settled handler. Pi drains its settle queue in
// order and awaits each entry, so the compaction and the other run never overlap, whichever is queued first.
let other = false;
const overlaps: boolean[] = [];
extra = [(pi: any) => pi.on("agent_settled", async () => {
  if (other || !current.messages.some((m: any) => m.role === "toolResult" && m.toolName === "self_compact")) return;
  other = true;
  pi.sendMessage({ customType: "other", content: "do other work", display: true }, { triggerTurn: true });
  await new Promise((r) => setTimeout(r, 20));
})];
const fRun = await run(
  "other-extension-continues",
  1000,
  [
    fauxAssistantMessage("ack " + "z".repeat(3000)),
    fauxAssistantMessage(fauxToolCall("self_compact", { note: "Goal: ship" }), { stopReason: "toolUse" }),
    // both slow, in either order (summary or other run), so an overlap would be caught in flight
    async () => { await new Promise((r) => setTimeout(r, 150)); return fauxAssistantMessage("OTHER RUN DONE", { timestamp: Date.now() }); },
    async () => { await new Promise((r) => setTimeout(r, 150)); return fauxAssistantMessage("## summary", { timestamp: Date.now() }); },
    fauxAssistantMessage("RESUMED"),
  ],
  ["background " + "context ".repeat(800), "do the task"],
  (session, ev) => { if (ev.type === "compaction_start" || ev.type === "compaction_end") overlaps.push(session.isStreaming); },
);
extra = [];
assert.deepEqual(overlaps, [false, false], "no run may stream while the compaction is in flight");
assert.equal(fRun.pending, 0);
assert.match(fRun.lastText, /RESUMED/);
console.log("✓ F: a run another extension starts at settle never overlaps the compaction");

// G: mixed batch. A plain tool ran before self_compact in the same batch, so Pi makes one more model
// request (it terminates only when every result does). Compaction and resume still happen afterwards.
extra = [(pi: any) => pi.registerTool({ name: "plain", label: "plain", description: "plain", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "plain" }] }) })];
const gRun = await run(
  "mixed-batch",
  1000,
  [
    fauxAssistantMessage("ack " + "z".repeat(3000)),
    fauxAssistantMessage([fauxToolCall("plain", {}), fauxToolCall("self_compact", { note: "Goal: ship" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("plain", {}), { stopReason: "toolUse" }), // the extra request: blocked, ends the turn
    fauxAssistantMessage("## summary"),
    fauxAssistantMessage("## turn prefix"), // the cut lands inside the turn: Pi also summarises the turn prefix
    fauxAssistantMessage("RESUMED after mixed batch"),
  ],
  ["background " + "context ".repeat(800), "do the task"],
);
extra = [];
assert.ok(gRun.events.includes("compaction_end:manual"), "mixed batch still compacts");
assert.equal(gRun.pending, 0);
assert.match(gRun.lastText, /RESUMED after mixed batch/);
console.log("✓ G: mixed batch: one extra request, its tool call ends the turn, then compaction + resume");



// H: another extension's continuation starts AND finishes before any timer could look (no delay in its handler).
// The scheduled job must survive: the compaction still runs and resumes, in either queue order.
for (const extraFirst of [false, true]) {
  let queued = false;
  extra = [(pi: any) => pi.on("agent_settled", () => {
    if (queued || !current.messages.some((m: any) => m.role === "toolResult" && m.toolName === "self_compact")) return;
    queued = true;
    pi.sendMessage({ customType: "other", content: "other task", display: true }, { triggerTurn: true });
  })];
  const starts: string[] = [];
  const hRun = await run(
    `fast-continuation-${extraFirst ? "other-first" : "self-first"}`,
    1000,
    [
      fauxAssistantMessage("ack " + "z".repeat(3000)),
      fauxAssistantMessage(fauxToolCall("self_compact", { note: "ship" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("## summary or OTHER RUN DONE"),
      fauxAssistantMessage("OTHER RUN DONE or ## summary"),
      fauxAssistantMessage("RESUMED"),
    ],
    ["background " + "context ".repeat(800), "do the task"],
    (_s, ev) => { if (["compaction_start", "agent_start"].includes(ev.type)) starts.push(ev.type); },
    { extraFirst, afterMs: 700 },
  );
  extra = [];
  assert.ok(starts.includes("compaction_start"), `fast continuation (${extraFirst ? "other first" : "self first"}): the compaction must still run`);
  assert.ok(hRun.roles.includes("custom:self_compact_continuation"), "and the agent resumes");
  assert.equal(hRun.pending, 0);
}
console.log("✓ H: a continuation that starts and finishes inside the settle phase does not lose the scheduled compaction");

// I: slow agent_settled handlers (350 ms) and a slow other run: the compaction never runs under a run, nor a run under the compaction
for (const extraFirst of [false, true]) {
  let queued = false;
  extra = [(pi: any) => pi.on("agent_settled", async () => {
    if (queued || !current.messages.some((m: any) => m.role === "toolResult" && m.toolName === "self_compact")) return;
    queued = true;
    pi.sendMessage({ customType: "other", content: "OTHER WORK", display: true }, { triggerTurn: true });
    await new Promise((r) => setTimeout(r, 350));
  })];
  const slow = (ms: number, text: string) => async () => { await new Promise((r) => setTimeout(r, ms)); return fauxAssistantMessage(text, { timestamp: Date.now() }); };
  let compactingNow = false;
  const bad: string[] = [];
  await run(
    `slow-handler-${extraFirst ? "other-first" : "self-first"}`,
    1000,
    [
      fauxAssistantMessage("ack " + "z".repeat(3000)),
      fauxAssistantMessage(fauxToolCall("self_compact", { note: "ship" }), { stopReason: "toolUse" }),
      slow(500, "## summary"),
      slow(500, "RESUMED or OTHER RUN DONE"),
      slow(500, "OTHER RUN DONE or RESUMED"),
    ],
    ["background " + "context ".repeat(800), "do the task"],
    (session, ev) => {
      if (ev.type === "compaction_start") { compactingNow = true; if (session.isStreaming) bad.push("compaction started under a run"); }
      if (ev.type === "compaction_end") { compactingNow = false; if (session.isStreaming) bad.push("run streaming at compaction_end"); }
      if (ev.type === "agent_start" && compactingNow) bad.push("run started during the compaction");
    },
    { extraFirst, afterMs: 500 },
  );
  extra = [];
  assert.deepEqual(bad, [], `slow settle handler (${extraFirst ? "other first" : "self first"}): runs and compaction never overlap`);
}
console.log("✓ I: slow settle handlers cannot make a run and the compaction overlap");

// J: the user presses stop 30 ms after the run settled. The compaction is already underway (the settle
// queue starts it right after the handlers), so the stop cancels it and nothing resumes.
{
  let stopped = false;
  const jRun = await run(
    "stop-after-settle",
    1000,
    [
      fauxAssistantMessage("ack " + "z".repeat(3000)),
      fauxAssistantMessage(fauxToolCall("self_compact", { note: "ship" }), { stopReason: "toolUse" }),
      async () => { await new Promise((r) => setTimeout(r, 300)); return fauxAssistantMessage("## summary", { timestamp: Date.now() }); },
      fauxAssistantMessage("RESUMED DESPITE STOP"),
    ],
    ["background " + "context ".repeat(800), "do the task"],
    (session, ev) => {
      if (ev.type === "agent_settled" && !stopped && session.messages.some((m: any) => m.role === "toolResult" && m.toolName === "self_compact")) {
        stopped = true;
        setTimeout(() => void session.abort(), 30);
      }
    },
    { afterMs: 400 },
  );
  assert.ok(stopped);
  assert.ok(!jRun.roles.includes("custom:self_compact_continuation"), "a stop 30 ms after settle must prevent the resume");
  assert.ok(!/RESUMED DESPITE STOP/.test(jRun.lastText));
  console.log("✓ J: stop shortly after settle: no resume");
}

// K: background work is never killed by the gate or the scheduler. A detached worker launched before the
// force gate (simulating a subagent) finishes untouched; a tool still running in the same batch as
// self_compact completes before the compaction starts and is never handed an abort.
{
  let launched = 0, completed = 0, aborted = 0, slowDone = 0, slowAborted = 0;
  extra = [(pi: any) => {
    pi.registerTool({ name: "bg_launch", label: "bg", description: "background worker", parameters: { type: "object", properties: {} },
      execute: async (_id: any, _p: any, signal: any) => { launched++; signal?.addEventListener("abort", () => aborted++); setTimeout(() => completed++, 1200); return { content: [{ type: "text", text: "worker launched" }] }; } });
    pi.registerTool({ name: "slow", label: "slow", description: "tool that is still running when self_compact executes", parameters: { type: "object", properties: {} },
      execute: async (_id: any, _p: any, signal: any) => { signal?.addEventListener("abort", () => slowAborted++); await new Promise((r) => setTimeout(r, 400)); slowDone++; return { content: [{ type: "text", text: "slow done" }] }; } });
  }];
  let gate = false, slowDoneAtCompaction = -1;
  const kRun = await run(
    "background-work",
    1000,
    [
      fauxAssistantMessage(fauxToolCall("bg_launch", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("ack"),
      fauxAssistantMessage([{ type: "text", text: "x".repeat(190000) }, fauxToolCall("bg_launch", {})], { stopReason: "toolUse" }), // pushes usage over the force line (176K of the 200K working window), so this call is gated
      fauxAssistantMessage("## summary"),
      fauxAssistantMessage("## turn prefix"),
      fauxAssistantMessage("RESUMED"),
    ],
    ["x".repeat(520000), "next"],
    (_s, ev) => { if (ev.type === "tool_execution_end" && JSON.stringify(ev.result).includes("FORCE GATE")) gate = true; },
    { window: 1_000_000, afterMs: 1500 },
  );
  assert.ok(gate, "the force gate fired at >176K tokens of a 1M window");
  assert.equal(launched, 1);
  assert.equal(completed, 1, "the background worker finished");
  assert.equal(aborted, 0, "the gate and the compaction never aborted it");
  assert.equal(kRun.pending, 0);
  const mRun = await run(
    "in-flight-tool",
    1000,
    [
      fauxAssistantMessage("ack " + "z".repeat(3000)),
      fauxAssistantMessage([fauxToolCall("slow", {}), fauxToolCall("self_compact", { note: "ship" })], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }), // the extra request: blocked, ends the turn
      fauxAssistantMessage("## summary"),
      fauxAssistantMessage("## turn prefix"),
      fauxAssistantMessage("RESUMED"),
    ],
    ["background " + "context ".repeat(800), "do the task"],
    (_s, ev) => { if (ev.type === "compaction_start") slowDoneAtCompaction = slowDone; },
  );
  extra = [];
  assert.equal(slowDone, 1, "the tool that was already running completed");
  assert.equal(slowDoneAtCompaction, 1, "and the compaction started only after it");
  assert.equal(slowAborted, 0, "it was never handed an abort");
  assert.match(mRun.lastText, /RESUMED/);
  console.log("✓ K: background workers and in-flight tools survive the force gate and the scheduled compaction");
}

console.log("\nE2E PASSED");
