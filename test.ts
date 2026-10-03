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
  const pi: any = {
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
    tools, commands, handlers, sent, compacts, ctx,
    setPercent: (p: number) => (percent = p),
    setIdle: (v: boolean) => (idle = v),
    setUsage: (u: any) => (usageOverride = u),
    emit: (e: string, ev: any = {}) => handlers.get(e)!(ev, ctx),
  };
}

// 1. self_compact tool: compacts once, resumes via sendMessage(triggerTurn) carrying the note
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "Goal: X\nNext: Y" }, new AbortController().signal, () => {}, h.ctx);
  assert.equal(h.compacts.length, 1);
  assert.match(h.compacts[0].customInstructions, /Goal: X/);
  // overlap guard: second call while in flight does not compact again
  await h.tools.get("self_compact").execute("c2", { note: "again" }, undefined, () => {}, h.ctx);
  assert.equal(h.compacts.length, 1, "overlapping compaction must be refused");
  await h.emit("session_compact", { reason: "manual", willRetry: false });
  h.compacts[0].onComplete({});
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, true, "resume must trigger a new turn");
  assert.equal(h.sent[0].message.customType, CONTINUATION_CUSTOM_TYPE);
  assert.match(h.sent[0].message.content, /Goal: X/, "note must be delivered to the model");
  assert.equal(await h.emit("agent_before_settle"), undefined, "own compaction must not also resume at settle");
  await assert.rejects(h.tools.get("self_compact").execute("c3", { note: "   " }, undefined, () => {}, h.ctx));
  console.log("✓ tool: compact → onComplete → triggerTurn resume with note; overlap + empty note refused");
}

// 2. onError releases the guard, still resumes (compact() already aborted the run), and stops auto-retry loops
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  h.compacts[0].onError(new Error("boom"));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].options.triggerTurn, true, "failed compaction must still resume the aborted run");
  assert.match(h.sent[0].message.content, /NOT reduced/);
  h.setPercent(85);
  await h.emit("turn_end");
  assert.equal(h.compacts.length, 1, "no auto-compact retry loop after a failure");
  await h.emit("session_compact", { reason: "manual", willRetry: false });
  await h.emit("turn_end");
  assert.equal(h.compacts.length, 2, "auto-compact re-armed after a successful compaction");
  console.log("✓ onError: guard released, run resumed, no retry loop, re-armed on success");
}

// 2b. A failed compaction also lifts the force gate (else: no auto-compact AND every tool blocked)
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
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
  await h.emit("session_compact_failed", { aborted: true, reason: "manual" });
  h.compacts[0].onError(new Error("Compaction cancelled"));
  assert.equal(h.sent.length, 0, "cancelled compaction must not resume");
  h.setPercent(95);
  assert.equal((await h.emit("tool_call", { toolName: "bash" }))?.block, true, "cancel is not a failure: gate stays");
  console.log("✓ cancelled compaction: no resume");
}

// 2d. Session shutdown: late callbacks are no-ops even when the stale ctx throws
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h.ctx);
  await h.emit("session_shutdown");
  Object.defineProperty(h.ctx, "ui", { get() { throw new Error("stale ctx"); } });
  h.ctx.getContextUsage = () => { throw new Error("stale ctx"); };
  h.compacts[0].onComplete({});
  h.compacts[0].onError(new Error("x"));
  assert.equal(h.sent.length, 0, "no resume after shutdown");
  console.log("✓ shutdown: late onComplete/onError are safe no-ops");
}

// 2e. Loop bound: compaction that never restores headroom stops after 2 resumes
{
  const h = harness();
  h.setPercent(85);
  for (let i = 0; i < 5; i++) {
    await h.emit("turn_end"); // still >= auto: compacts again
    h.compacts.at(-1)?.onComplete({});
  }
  assert.equal(h.sent.filter((m) => m.options.triggerTurn).length, 2, "at most 2 consecutive compaction-driven resumes");
  h.setPercent(30);
  await h.emit("turn_end"); // headroom restored -> streak resets
  h.setPercent(85);
  await h.emit("turn_end");
  h.compacts.at(-1).onComplete({});
  assert.equal(h.sent.filter((m) => m.options.triggerTurn).length, 3, "streak resets after a turn with headroom");
  // headroom check: known post-compaction usage still above auto -> no resume
  const h2 = harness();
  await h2.tools.get("self_compact").execute("c1", { note: "n" }, undefined, () => {}, h2.ctx);
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
    await h.emit("turn_end"); // the tool-call turn ends while compacting: no streak reset
    h.compacts.at(-1).onComplete({});
  }
  assert.equal(h.sent.filter((m) => m.options.triggerTurn).length, 2, "model-driven compactions bounded at 2 resumes");
  console.log("✓ repeated self_compact calls bounded at 2 resumes");
}

// 2h. Aborted tool (before or during the audit) neither compacts nor resumes
{
  const h = harness();
  const ac = new AbortController();
  ac.abort();
  const r = await h.tools.get("self_compact").execute("c1", { note: "n" }, ac.signal, () => {}, h.ctx);
  assert.equal(h.compacts.length, 0, "aborted before audit: no compaction");
  assert.match(r.content[0].text, /Aborted/);
  console.log("✓ aborted tool: no compaction");
}

// 2f. Backups are per-workspace and the real home is never written
{
  const h = harness();
  await h.tools.get("self_compact").execute("c1", { note: "repo A secret plan" }, undefined, () => {}, h.ctx);
  const a = noteBackupPathFor("/work/repo-a"), b = noteBackupPathFor("/work/repo-b");
  assert.notEqual(a, b);
  assert.ok(a.startsWith(stateDir), "backup must honour PI_SELF_COMPACT_STATE_DIR");
  assert.match(readFileSync(a, "utf8"), /cwd: "\/work\/repo-a"[\s\S]*repo A secret plan/);
  assert.ok(!existsSync(b));
  console.log("✓ note backup scoped per workspace with cwd header, sandboxed in tests");
}

// 3. turn_end: nudge once at 70–79% (model-visible steer), auto-compact at >=80%
{
  const h = harness();
  h.setPercent(75);
  await h.emit("turn_end");
  await h.emit("turn_end");
  assert.equal(h.sent.length, 1, "nudge exactly once");
  assert.equal(h.sent[0].options.deliverAs, "steer");
  assert.equal(h.compacts.length, 0);
  h.setPercent(82);
  await h.emit("turn_end");
  await h.emit("turn_end");
  assert.equal(h.compacts.length, 1, "auto-compact once while in flight");
  h.compacts[0].onComplete({});
  assert.equal(h.sent.at(-1)!.options.triggerTurn, true);
  console.log("✓ turn_end: single steer nudge, single auto-compact, resumes");
}

// 4. Pi built-in threshold compaction after agent_end → resume at settle exactly once
{
  const h = harness();
  await h.emit("session_compact", { reason: "threshold", willRetry: false });
  const r = await h.emit("agent_before_settle");
  assert.equal(r.continue, true);
  assert.equal(r.entries[0].type, "custom_message");
  assert.equal(await h.emit("agent_before_settle"), undefined, "resume once only");
  console.log("✓ built-in post-run compaction resumes at agent_before_settle");
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
  assert.equal((await h.emit("tool_call", { toolName: "bash" }))?.block, true);
  assert.equal(await h.emit("tool_call", { toolName: "self_compact" }), undefined);
  assert.deepEqual(resolveConfig({ PI_SELF_COMPACT_AUTO_PCT: "95" } as any), { ...DEFAULT_CONFIG }, "misordered → defaults");
  assert.equal(resolveConfig({ PI_SELF_COMPACT_AUTO_PCT: "85", PI_SELF_COMPACT_FORCE_PCT: "90" } as any).autoCompactPct, 85);
  console.log("✓ force gate + threshold ordering");
}

console.log("\nALL TESTS PASSED");
