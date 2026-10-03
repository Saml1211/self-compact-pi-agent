import assert from "node:assert";
import register, { resolveConfig, DEFAULT_CONFIG, CONTINUATION_CUSTOM_TYPE } from "./index.ts";

process.env.PI_SELF_COMPACT_JEV = "false"; // no network in tests
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
  const ctx: any = {
    compact: (opts: any) => compacts.push(opts),
    ui: { notify: () => {} },
    isIdle: () => idle,
    getContextUsage: () => ({ tokens: percent * 1000, contextWindow: 100000, percent }),
  };
  return {
    tools, commands, handlers, sent, compacts, ctx,
    setPercent: (p: number) => (percent = p),
    setIdle: (v: boolean) => (idle = v),
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
