import assert from "node:assert";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { resolveConfig, DEFAULT_CONFIG, CONTINUATION_CUSTOM_TYPE, noteBackupPathFor } from "./index.ts";

process.env.PI_SELF_COMPACT_JEV = "false"; // no network in tests
// Never write the real ~/.pi/state backup (Bun caches homedir() at start, so HOME can't be swapped)
const stateDir = mkdtempSync(join(tmpdir(), "sc-state-"));
process.env.PI_SELF_COMPACT_STATE_DIR = stateDir;
delete process.env.PI_CREW_KIND;
delete process.env.PI_CREW_DEPTH;

function harness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const sent: { message: any; options: any }[] = [];
  const queued: { text: string; options: any }[] = []; // Pi's settle queue: prompts sent while agent_settled handlers run
  const pi: any = {
    sendUserMessage: (text: string, options: any) => queued.push({ text, options }),
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (n: string, c: any) => commands.set(n, c),
    on: (e: string, h: Function) => handlers.set(e, h),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
  };
  register(pi);
  const compacts: any[] = [];
  let percent = 10;
  let idle = false;
  let usageOverride: any;
  const ctx: any = {
    cwd: "/work/repo-a",
    // Like Pi: right after a compaction, usage is unknown (tokens: null) until the next response
    compact: (opts: any) =>
      compacts.push({
        ...opts,
        onComplete: (r: any) => {
          const explicit = usageOverride !== undefined;
          if (!explicit) usageOverride = { tokens: null, contextWindow: 100000, percent: null };
          try { opts.onComplete(r); } finally { if (!explicit) usageOverride = undefined; }
        },
      }),
    ui: { notify: () => {} },
    isIdle: () => idle,
    getContextUsage: () => usageOverride ?? { tokens: percent * 1000, contextWindow: 100000, percent },
  };
  return {
    tools, commands, handlers, sent, compacts, ctx, queued,
    // Pi drains the settle queue after the handlers: slash commands run (and are awaited) in order
    drain: async () => {
      const was = idle;
      idle = true; // the queue drains on a settled, idle session
      for (const q of queued.splice(0)) void commands.get(q.text.slice(1))?.handler("", ctx);
      await new Promise((r) => setTimeout(r, 5));
      idle = was;
    },
    setPercent: (p: number) => (percent = p),
    setIdle: (v: boolean) => (idle = v),
    setUsage: (u: any) => (usageOverride = u),
    emit: (e: string, ev: any = {}) => handlers.get(e)!(ev, ctx),
    // a run that ends normally: Pi runs agent_before_settle, then agent_settled
    settle: async (outcome = "completed") => {
      const was = idle;
      idle = true; // a settled run is idle
      await handlers.get("agent_before_settle")!({ outcome }, ctx);
      await handlers.get("agent_settled")!({}, ctx);
      for (const q of queued.splice(0)) void commands.get(q.text.slice(1))?.handler("", ctx);
      await new Promise((r) => setTimeout(r, 5));
      idle = was;
    },
  };
}

// 1. self_compact tool: schedules, ends the turn (terminate), compacts once settled, resumes with the note
{
  const h = harness();
  const r = await h.tools.get("self_compact").execute("c1", { note: "Goal: X\nNext: Y" }, new AbortController().signal, () => {}, h.ctx);
  assert.equal(r.terminate, true, "the tool ends the turn instead of aborting it");
  assert.equal(h.compacts.length, 0, "nothing compacts while the run is still going");
  assert.equal((await h.emit("tool_call", { toolName: "bash" }))?.terminate, true, "other calls in the run end the turn");
  await h.settle();
  assert.equal(h.compacts.length, 1);
  assert.match(h.compacts[0].customInstructions, /Goal: X/);
  // overlap guard: a call while compacting does not schedule another
  await h.tools.get("self_compact").execute("c2", { note: "again" }, undefined, () => {}, h.ctx);
  await h.settle();
  assert.equal(h.compacts.length, 1, "overlapping compaction must be refused");
  await h.emit("session_compact", { reason: "manual", willRetry: false });
  h.compacts[0].onComplete({});
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, true, "resume must trigger a new turn");
  assert.equal(h.sent[0].message.customType, CONTINUATION_CUSTOM_TYPE);
  assert.match(h.sent[0].message.content, /Goal: X/, "note must be delivered to the model");
  assert.equal(await h.emit("agent_before_settle"), undefined, "own compaction must not also resume at settle");
  await assert.rejects(h.tools.get("self_compact").execute("c3", { note: "   " }, undefined, () => {}, h.ctx));
  console.log("✓ tool: schedule + terminate → compact when settled → triggerTurn resume with note; overlap + empty note refused");
}

// 1b. User stop: Pi skips agent_before_settle when an abort was requested -> no compaction, no resume
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.emit("agent_settled"); // stopped run: settled without before_settle
  assert.equal(h.compacts.length, 0, "a stopped run must not compact");
  assert.equal(h.sent.length, 0, "a stopped run must not resume");
  await h.settle();
  assert.equal(h.compacts.length, 0, "the dropped compaction does not come back later");
  assert.equal(await h.emit("tool_call", { toolName: "bash" }), undefined, "nothing left blocking tools");
  console.log("✓ user stop before the run settles: compaction dropped, no resume");
}

// 1c. Aborted/errored outcome never arms; another extension's continuation run goes first
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.settle("aborted");
  assert.equal(h.compacts.length, 0, "aborted outcome: no compaction");
  await h.tools.get("self_compact").execute("c2", { note: "n" }, undefined, () => {}, h.ctx);
  await h.settle("error");
  assert.equal(h.compacts.length, 0, "error outcome: no compaction");
  // the compaction goes through Pi's settle queue (no timers), as an expandPromptTemplates slash command
  await h.tools.get("self_compact").execute("c3", { note: "Goal: later" }, undefined, () => {}, h.ctx);
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  assert.equal(h.queued.length, 1, "job handed to Pi's settle queue");
  assert.deepEqual(h.queued[0], { text: "/self-compact-run", options: { expandPromptTemplates: true } });
  assert.equal(h.compacts.length, 0, "nothing compacts until Pi drains the queue");
  // an earlier queue entry (another extension's continuation) runs to the end first, cleanly
  await h.emit("agent_start");
  assert.equal((await h.emit("tool_call", { toolName: "bash" }))?.terminate, undefined, "that run is not ours to end");
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  await h.drain();
  assert.equal(h.compacts.length, 1, "compacts once, after that run");
  assert.match(h.compacts[0].customInstructions, /Goal: later/);
  await h.drain();
  assert.equal(h.compacts.length, 1, "a duplicate queue entry is a no-op");
  console.log("✓ aborted/error outcomes never arm; the compaction runs from Pi's settle queue after earlier runs");
}

// 1d. A run Pi drains ahead of our queued compaction is stopped by the user: stop wins, no compaction, no resume
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  await h.emit("agent_start"); // another extension's continuation
  await h.emit("agent_settled"); // stopped: Pi skipped agent_before_settle
  await h.drain();
  assert.equal(h.compacts.length, 0, "a stop in the queue cancels the job");
  assert.equal(h.sent.length, 0);
  await h.settle();
  assert.equal(h.compacts.length, 0, "and it does not come back");
  console.log("✓ stop while Pi drains the settle queue: job cancelled");
}

// 1e. The command waits for the compaction and the resume run, so nothing queued behind it overlaps
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  let done = false;
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  h.setIdle(true);
  const run = h.commands.get("self-compact-run").handler("", h.ctx).then(() => (done = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, "still waiting on the compaction");
  h.compacts[0].onComplete({});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, "still waiting for the resume run to start");
  await h.emit("agent_start");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false, "still waiting for the resume run to end");
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  await run;
  assert.equal(done, true);
  console.log("✓ settle-queue command returns only after compaction and resume run are over");
}

// 2. onError releases the guard, still resumes (the run stopped for it), and stops auto-retry loops
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.settle();
  h.compacts[0].onError(new Error("boom"));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, true, "failed compaction must still resume the run");
  assert.match(h.sent[0].message.content, /NOT reduced/);
  h.setPercent(85);
  await h.emit("turn_end");
  await h.settle();
  assert.equal(h.compacts.length, 1, "no auto-compact retry loop after a failure");
  await h.emit("session_compact", { reason: "manual", willRetry: false });
  await h.emit("turn_end");
  await h.settle();
  assert.equal(h.compacts.length, 2, "auto-compact re-armed after a successful compaction");
  console.log("✓ onError: guard released, run resumed, no retry loop, re-armed on success");
}

// 2b. A failed compaction also lifts the force gate (else: every tool call would end the turn)
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.settle();
  h.compacts[0].onError(new Error("boom"));
  h.setPercent(95);
  assert.equal(await h.emit("tool_call", { toolName: "bash" }), undefined, "gate must not deadlock after a failed compaction");
  await h.emit("session_compact", { reason: "manual", willRetry: false });
  assert.equal((await h.emit("tool_call", { toolName: "bash" }))?.block, true, "gate re-armed after a successful compaction");
  console.log("✓ failed compaction lifts the force gate until a compaction succeeds");
}

// 2c. Cancellation is a stop boundary: no resume, no failure state
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.settle();
  await h.emit("session_compact_failed", { aborted: true, reason: "manual" });
  h.compacts[0].onError(new Error("Compaction cancelled"));
  assert.equal(h.sent.length, 0, "cancelled compaction must not resume");
  h.setPercent(95);
  assert.equal((await h.emit("tool_call", { toolName: "bash" }))?.block, true, "cancel is not a failure: gate stays");
  console.log("✓ cancelled compaction: no resume");
}

// 2d. Session shutdown: late callbacks are no-ops even when the stale ctx throws; nothing scheduled survives
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.settle();
  await h.tools.get("self_compact").execute("c2", { note: "n2" }, undefined, () => {}, h.ctx); // refused: compacting
  await h.emit("session_shutdown");
  Object.defineProperty(h.ctx, "ui", { get() { throw new Error("stale ctx"); } });
  h.ctx.getContextUsage = () => { throw new Error("stale ctx"); };
  h.compacts[0].onComplete({});
  h.compacts[0].onError(new Error("x"));
  await h.settle();
  assert.equal(h.sent.length, 0, "no resume after shutdown");
  assert.equal(h.compacts.length, 1, "no compaction after shutdown");
  console.log("✓ shutdown: late onComplete/onError are safe no-ops");
}

// 2e. Loop bound: compaction that never restores headroom stops after 2 resumes
{
  const h = harness();
  h.setPercent(85);
  const resumes = () => h.sent.filter((m) => m.options.triggerTurn).length;
  for (let i = 0; i < 5; i++) {
    await h.emit("turn_end"); // still >= auto: schedules again
    await h.settle();
    h.compacts.at(-1)?.onComplete({});
  }
  assert.equal(resumes(), 2, "at most 2 consecutive compaction-driven resumes");
  h.setPercent(30);
  await h.emit("turn_end"); // headroom restored -> streak resets
  h.setPercent(85);
  await h.emit("turn_end");
  await h.settle();
  h.compacts.at(-1).onComplete({});
  assert.equal(resumes(), 3, "streak resets after a turn with headroom");
  // headroom check: known post-compaction usage still above auto -> no resume
  const h2 = harness();
  await h2.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h2.ctx);
  await h2.settle();
  h2.setUsage({ tokens: 90000, contextWindow: 100000, percent: 90 });
  h2.compacts[0].onComplete({});
  assert.equal(h2.sent.length, 0, "no resume when compaction did not free enough context");
  console.log("✓ resume loop bounded (2), resets on headroom; no resume without headroom");
}

// 2g. Repeated model self_compact calls cannot bypass the resume bound
{
  const h = harness();
  for (let i = 0; i < 5; i++) {
    await h.tools.get("self_compact").execute("c" + i, { note: "n" + i }, undefined, () => {}, h.ctx);
    await h.emit("turn_end"); // the tool-call turn ends with a compaction scheduled: no streak reset
    await h.settle();
    h.compacts.at(-1).onComplete({});
  }
  assert.equal(h.sent.filter((m) => m.options.triggerTurn).length, 2, "model-driven compactions bounded at 2 resumes");
  console.log("✓ repeated self_compact calls bounded at 2 resumes");
}

// 2h. Aborted tool (before or during the audit) neither schedules nor compacts
{
  const h = harness();
  const ac = new AbortController();
  ac.abort();
  const r = await h.tools.get("self_compact").execute("c1", { note: "n" }, ac.signal, () => {}, h.ctx);
  await h.settle();
  assert.equal(h.compacts.length, 0, "aborted before audit: no compaction");
  assert.match(r.content[0].text, /Aborted/);
  console.log("✓ aborted tool: no compaction");
}

// 2f. Backups are per-workspace and the real home is never written
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "repo A secret plan" }, undefined, () => {}, h.ctx);
  await h.settle();
  const a = noteBackupPathFor("/work/repo-a"), b = noteBackupPathFor("/work/repo-b");
  assert.notEqual(a, b);
  assert.ok(a.startsWith(stateDir), "backup must honour PI_SELF_COMPACT_STATE_DIR");
  assert.match(readFileSync(a, "utf8"), /cwd: "\/work\/repo-a"[\s\S]*repo A secret plan/);
  assert.ok(!existsSync(b));
  console.log("✓ note backup scoped per workspace with cwd header, sandboxed in tests");
}

// 3. turn_end: nudge once at 70–79%; at >=80% ask for notes once, then any other tool ends the turn
{
  const h = harness();
  h.setPercent(75);
  await h.emit("turn_end");
  await h.emit("turn_end");
  assert.equal(h.sent.length, 1, "nudge exactly once");
  assert.equal(h.sent[0].options.deliverAs, "steer");
  h.setPercent(82);
  await h.emit("turn_end");
  await h.emit("turn_end");
  assert.equal(h.sent.length, 2, "one auto-compact steer, not repeated");
  assert.match(h.sent[1].message.content, /Call self_compact NOW/);
  assert.equal(h.compacts.length, 0, "never compacts mid-run");
  const blocked = await h.emit("tool_call", { toolName: "bash" });
  assert.equal(blocked?.block, true);
  assert.equal(blocked?.terminate, true, "ignoring the request ends the turn");
  await h.settle();
  assert.equal(h.compacts.length, 1);
  assert.match(h.compacts[0].customInstructions, /Autonomous self-compaction at 82%/);
  h.compacts[0].onComplete({});
  assert.equal(h.sent.at(-1)!.options.triggerTurn, true);
  // the model answering the request with its own notes replaces the generic note
  const h2 = harness();
  h2.setPercent(82);
  await h2.emit("turn_end");
  await h2.tools.get("self_compact").execute("c1", { note: "Goal: model-written" }, undefined, () => {}, h2.ctx);
  await h2.settle();
  assert.match(h2.compacts[0].customInstructions, /model-written/);
  console.log("✓ turn_end: steer nudge once; at 80% the model gets one chance to write notes, else generic; never mid-run");
}

// 4. Pi built-in threshold compaction after agent_end → resume at settle exactly once
{
  const h = harness();
  await h.emit("session_compact", { reason: "threshold", willRetry: false });
  const r = await h.emit("agent_before_settle");
  assert.equal(r.continue, true);
  assert.equal(r.entries[0].type, "custom_message");
  assert.equal(await h.emit("agent_before_settle"), undefined, "resume once only");
  // Pi's own compaction supersedes a scheduled one, and the resume carries the model's note
  const h2 = harness();
  await h2.tools.get("self_compact").execute("c1", { note: "Goal: carried" }, undefined, () => {}, h2.ctx);
  await h2.emit("session_compact", { reason: "threshold", willRetry: false });
  const r2 = await h2.emit("agent_before_settle");
  await h2.emit("agent_settled");
  assert.equal(h2.compacts.length, 0, "no second compaction after Pi's own");
  assert.match(r2.entries[0].content, /Goal: carried/);
  console.log("✓ built-in post-run compaction resumes at agent_before_settle (and supersedes a scheduled one)");
}

// 5. Cases that must NOT resume
{
  const h = harness();
  // pre-request compaction mid-run: a turn ends afterwards, agent already working
  await h.emit("session_compact", { reason: "threshold", willRetry: false });
  await h.emit("turn_end");
  assert.equal(await h.emit("agent_before_settle"), undefined, "mid-run compaction must not force continue");
  await h.emit("session_compact", { reason: "overflow", willRetry: true });
  assert.equal(await h.emit("agent_before_settle"), undefined, "overflow retry already continues");
  await h.emit("session_compact", { reason: "manual", willRetry: false });
  assert.equal(await h.emit("agent_before_settle"), undefined, "user /compact must not resume");
  h.setIdle(true);
  await h.commands.get("self-compact").handler("note", h.ctx);
  h.compacts[0].onComplete({});
  assert.equal(h.sent.length, 0, "/self-compact on an idle session stays idle");
  console.log("✓ no resume: mid-run, overflow-retry, user /compact, idle /self-compact");
}

// 6. Force gate and config validation
{
  const h = harness();
  h.setPercent(90);
  const g = await h.emit("tool_call", { toolName: "bash" });
  assert.equal(g?.block, true);
  assert.equal(g?.terminate, true, "force gate ends the turn and schedules a compaction");
  assert.equal(await h.emit("tool_call", { toolName: "self_compact" }), undefined);
  await h.settle();
  assert.equal(h.compacts.length, 1);
  h.setPercent(82);
  const h2 = harness();
  h2.setPercent(82);
  assert.equal(await h2.emit("tool_call", { toolName: "bash" }), undefined, "below force: tool calls run");
  assert.deepEqual(resolveConfig({ PI_SELF_COMPACT_AUTO_PCT: "95" } as any), { ...DEFAULT_CONFIG }, "misordered → defaults");
  assert.equal(resolveConfig({ PI_SELF_COMPACT_AUTO_PCT: "85", PI_SELF_COMPACT_FORCE_PCT: "90" } as any).autoCompactPct, 85);
  console.log("✓ force gate + threshold ordering");
}

console.log("\nALL TESTS PASSED");

// Working-window cap: on a 1M-token model the thresholds are % of 200K, not of 1M
{
  const { usagePercent } = await import("./index.ts");
  const ctxOf = (u: any) => ({ getContextUsage: () => u }) as any;
  const big = { tokens: 160_000, contextWindow: 1_048_576, percent: 23 };
  assert.equal(usagePercent(ctxOf(big), DEFAULT_CONFIG.workingWindowTokens), 80, "160K of a 200K working window = 80%");
  assert.equal(usagePercent(ctxOf(big), 0), 23, "0 disables the cap: Pi's own percent");
  assert.equal(usagePercent(ctxOf({ tokens: 150_000, contextWindow: 200_000, percent: 75 }), 300_000), 75, "small windows unchanged");
  assert.equal(resolveConfig({ PI_SELF_COMPACT_WORKING_WINDOW: "0" } as any).workingWindowTokens, 0);
  assert.equal(resolveConfig({ PI_SELF_COMPACT_WORKING_WINDOW: "x" } as any).workingWindowTokens, 200_000, "invalid → default");
  console.log("✓ working-window cap: 1M models compact at 80% of 200K, small windows unchanged, env override");
}

// Non-finite usage numbers are "unknown": NaN compares false against every threshold, so it must never gate
{
  const { usagePercent } = await import("./index.ts");
  const p = (u: any, cap = 200_000) => usagePercent({ getContextUsage: () => u } as any, cap);
  assert.equal(p({ tokens: 50_000, contextWindow: 128_000, percent: NaN }), 39, "NaN percent: recompute from tokens/window");
  assert.equal(p({ tokens: 140_000, contextWindow: 1_000_000, percent: NaN }), 70, "NaN percent on a capped window");
  assert.equal(p({ tokens: 140_000, contextWindow: 1_000_000, percent: null }), 70);
  assert.equal(p({ tokens: NaN, contextWindow: 128_000, percent: 5 }), null, "NaN tokens: unknown");
  assert.equal(p({ tokens: undefined, contextWindow: 128_000, percent: undefined }), null, "missing tokens: unknown");
  assert.equal(p({ tokens: null, contextWindow: 1_000_000, percent: 96 }), null, "post-compaction null tokens: unknown");
  assert.equal(p({ tokens: 10, contextWindow: 0, percent: 0 }), null);
  assert.equal(p({ tokens: 10, contextWindow: NaN, percent: 1 }), null);
  const h = harness();
  h.setUsage({ tokens: 1000, contextWindow: 128_000, percent: NaN });
  assert.equal(await h.emit("tool_call", { toolName: "bash" }), undefined, "a 1,000-token context is never force-gated");
  h.setUsage({ tokens: 1000, contextWindow: NaN, percent: 99 });
  assert.equal(await h.emit("tool_call", { toolName: "bash" }), undefined, "unknown window never gates");
  console.log("✓ non-finite usage: recomputed or unknown, never gates");
}

// PI_SELF_COMPACT_WORKING_WINDOW: digits only AND a safe integer (400 digits parse to Infinity and would disable the cap)
{
  const w = (v: string) => resolveConfig({ PI_SELF_COMPACT_WORKING_WINDOW: v } as any).workingWindowTokens;
  for (const bad of ["9".repeat(400), "9007199254740993", "-1", "1e5", " 0", "0x10", "1.5", ""]) assert.equal(w(bad), 200_000, `${bad.slice(0, 20)} → default`);
  assert.equal(w("0"), 0, "0 = the whole window");
  assert.equal(w("9007199254740991"), 9007199254740991, "largest safe integer is accepted");
  assert.equal(w("300000"), 300_000);
  console.log("✓ working window env: finite safe integers only");
}
