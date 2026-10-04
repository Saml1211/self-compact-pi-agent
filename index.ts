import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// Context pressure thresholds (% of context window). Pi's own auto-compaction fires at
// contextWindow - reserveTokens (default 16384): ~92% on 200K, ~94% on 272K, ~98% on 1M.
// Everything here fires before that, so the model gets to write its own continuation notes.
export interface SelfCompactConfig {
  nudgePct: number; // model-visible steer message asking for self_compact
  autoCompactPct: number; // compact autonomously with a generic note if the model ignored the nudge
  forcePct: number; // stop the run immediately (block + terminate) and compact with a generic note
  jevEnabled: boolean; // audit continuation notes with TypeSafe Jev
  workingWindowTokens: number; // thresholds are % of min(contextWindow, this); 0 = the model's whole window
}

export const DEFAULT_CONFIG: SelfCompactConfig = {
  nudgePct: 70,
  autoCompactPct: 80,
  forcePct: 88,
  jevEnabled: true,
  // On a 1M-token model, 70/80/88% of the whole window is ~734K/839K/922K: past where quality drops,
  // and Pi's own compaction (window - 16384) fires first. Cap the working window instead.
  workingWindowTokens: 200_000,
};

function sanitizeThreshold(val: any, fallback: number, min = 10, max = 99): number {
  const n = Number(val);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.round(n);
}

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

function resolveJevApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }
  try {
    const configPath = join(homedir(), ".pi/agent/pi-jev.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
      if (cfg.apiKeyFile) {
        const keyFilePath = cfg.apiKeyFile.replace(/^~(?=$|\/)/, homedir());
        if (existsSync(keyFilePath)) {
          return readFileSync(keyFilePath, "utf8").trim();
        }
      }
    }
  } catch {}
  return undefined;
}

export interface JevAuditResult {
  readiness: "ready" | "needs_work" | "rejected";
  completeness: number; // 0 to 2 rubric
  actionable: number; // 0 to 1 probability
}

export async function auditContinuationNoteWithJev(
  note: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<JevAuditResult | null> {
  const body = {
    state: `Continuation Note:\n${note.slice(0, 3000)}`,
    model: JEV_MODEL,
    questions: {
      completeness: {
        type: "score",
        instructions:
          "Does this continuation note capture current goal, work done, blockers, key decisions, and concrete next steps?",
        levels: {
          "0": "Missing critical sections or too vague to resume work without amnesia",
          "1": "Covers high-level status but lacks specific file names or immediate next action",
          "2": "Complete, structured continuation notes with concrete actionable next steps and invariant state",
        },
      },
      readiness: {
        type: "choice",
        instructions: "Is this note ready to serve as the sole memory anchor after total conversation history wipe?",
        criteria: {
          ready: "High clarity, comprehensive summary with immediate next steps",
          needs_work: "Understandable but missing specific file references or context",
          rejected: "Empty, nonsensical, or completely inadequate",
        },
      },
      actionable: {
        type: "noul",
        instructions: "Can an engineer resume execution immediately from this note alone?",
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
    });

    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const answers = json?.answers;
    if (!answers) return null;

    const completenessRaw = answers.completeness?.score;
    const completeness = typeof completenessRaw === "number" && Number.isFinite(completenessRaw) ? completenessRaw : 1.5;

    const readinessRaw = answers.readiness?.choice;
    const readiness = ["ready", "needs_work", "rejected"].includes(readinessRaw) ? readinessRaw : "ready";

    const actionableRaw = answers.actionable?.noul;
    const actionable = typeof actionableRaw === "number" && Number.isFinite(actionableRaw) ? actionableRaw : 0.8;

    return { completeness, readiness, actionable };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function writeNoteBackupAtomic(backupPath: string, content: string): boolean {
  try {
    const dir = join(backupPath, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    if (existsSync(backupPath)) {
      try {
        const stat = lstatSync(backupPath);
        if (stat.isSymbolicLink()) {
          unlinkSync(backupPath);
        }
      } catch {}
    }

    const tempFile = join(dir, `.tmp_compact_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    writeFileSync(tempFile, content, { encoding: "utf8", mode: 0o600 });
    renameSync(tempFile, backupPath);
    return true;
  } catch {
    return false;
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): SelfCompactConfig {
  const cfg: SelfCompactConfig = {
    nudgePct: sanitizeThreshold(env.PI_SELF_COMPACT_WARNING_PCT, DEFAULT_CONFIG.nudgePct),
    autoCompactPct: sanitizeThreshold(env.PI_SELF_COMPACT_AUTO_PCT, DEFAULT_CONFIG.autoCompactPct),
    forcePct: sanitizeThreshold(env.PI_SELF_COMPACT_FORCE_PCT, DEFAULT_CONFIG.forcePct),
    jevEnabled: env.PI_SELF_COMPACT_JEV !== "false",
    workingWindowTokens: /^\d+$/.test(env.PI_SELF_COMPACT_WORKING_WINDOW ?? "")
      ? Number(env.PI_SELF_COMPACT_WORKING_WINDOW)
      : DEFAULT_CONFIG.workingWindowTokens,
  };
  // Mis-ordered overrides would make a later stage fire first; fall back wholesale.
  if (!(cfg.nudgePct < cfg.autoCompactPct && cfg.autoCompactPct < cfg.forcePct)) {
    return { ...DEFAULT_CONFIG, jevEnabled: cfg.jevEnabled, workingWindowTokens: cfg.workingWindowTokens };
  }
  return cfg;
}

const QUIET_MS = 100; // after settling, how long no other run may start before we compact
export const CONTINUATION_CUSTOM_TYPE = "self_compact_continuation";

export function continuationContent(note: string | null): string {
  const head =
    "[self-compact] Context was just compacted. Resume the active task now — do not wait for user input and do not redo finished work.";
  return note ? `${head}\n\nContinuation notes written before compaction:\n${note}` : head;
}

function isSubagent(): boolean {
  return process.env.PI_CREW_KIND === "subagent" || Boolean(process.env.PI_CREW_DEPTH && process.env.PI_CREW_DEPTH !== "0");
}

export function usagePercent(ctx: ExtensionContext, workingWindow = 0): number | null {
  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null || !usage.contextWindow) return null;
  const window = workingWindow > 0 ? Math.min(workingWindow, usage.contextWindow) : usage.contextWindow;
  if (window === usage.contextWindow && usage.percent != null) return usage.percent;
  return Math.round((usage.tokens / window) * 100);
}

// Per-workspace backup so one repo's note is never replayed into another (pi-prime reads this
// path too; keep both in sync). PI_SELF_COMPACT_STATE_DIR exists so tests never touch the real file.
export function noteBackupPathFor(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.PI_SELF_COMPACT_STATE_DIR || join(homedir(), ".pi/state/continuation-notes");
  return join(root, `${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.md`);
}

export function formatNoteBackup(cwd: string, note: string): string {
  return `<!-- self-compact cwd: ${JSON.stringify(cwd)} saved: ${new Date().toISOString()} -->\n${note}\n`;
}

// ponytail: at most this many compaction-driven resumes in a row without a turn that ends below
// the auto threshold. Stops compact -> resume -> compact loops when summaries are too big to help.
const MAX_CONSECUTIVE_RESUMES = 2;

export default function (pi: ExtensionAPI) {
  const config = resolveConfig();
  const jevApiKey = resolveJevApiKey();

  let compacting = false; // one of our own ctx.compact() calls is in flight
  // Our compactions never abort a running agent. They are scheduled (pending), the turn ends cleanly
  // (tool result / blocked call with terminate), and they start once the run has settled. Pi skips
  // agent_before_settle when anyone requested an abort, so "armed" there means the user did not stop;
  // a stopped run drops the pending compaction instead of compacting and resuming against the stop.
  let pending: { note: string; extra: string } | null = null;
  let armed = false;
  let runs = 0; // agent_start count: shows whether a run began after we settled
  let cancelled = false; // the in-flight compaction was aborted (user/extension cancel): never resume
  let disposed = false; // session shut down: callbacks must not touch the stale ctx
  let resumeAtSettle = false; // Pi's built-in compaction ran after the run ended
  let supersededNote: string | null = null; // a scheduled note Pi's own compaction overtook
  let resumeStreak = 0;
  let nudged = false; // nudge sent since the last compaction
  // After a failed compaction: no auto-retry and no force gate until some compaction succeeds;
  // otherwise every turn_end would abort and fail again, or the gate would block all work.
  let compactionFailed = false;

  // Resume only when it can help: session alive, loop bound not hit, headroom actually restored.
  function mayResume(ctx: ExtensionContext): boolean {
    if (disposed) return false;
    if (resumeStreak >= MAX_CONSECUTIVE_RESUMES) {
      safeNotify(ctx, `[self-compact] Stopped auto-resume after ${resumeStreak} compactions in a row; context is not shrinking enough. Continue manually.`, "warning");
      return false;
    }
    const after = safeUsage(ctx, config.workingWindowTokens);
    if (after !== null && after >= config.autoCompactPct) {
      safeNotify(ctx, `[self-compact] Compaction left context at ${after}%; not auto-resuming.`, "warning");
      return false;
    }
    resumeStreak++;
    return true;
  }

  function schedule(ctx: ExtensionContext, note: string, extra = "", steer?: string) {
    pending = { note, extra };
    armed = false;
    if (steer) {
      try {
        pi.sendMessage({ customType: "self_compact_nudge", content: steer, display: true }, { deliverAs: "steer" });
      } catch {}
    }
  }

  function genericNote(percent: number) {
    return `Autonomous self-compaction at ${percent}% context usage; the model did not call self_compact. Reconstruct the active task from the summary.`;
  }

  function resume(content: string) {
    try {
      pi.sendMessage({ customType: CONTINUATION_CUSTOM_TYPE, content, display: true }, { triggerTurn: true });
    } catch {} // stale runtime after shutdown/session switch
  }

  // Only ever called on a settled run (agent_settled) or by the user's /self-compact, so the
  // abort() inside AgentSession.compact() never cuts work short. Resume from onComplete/onError.
  function startCompaction(ctx: ExtensionContext, note: string, wantResume: boolean, extra = ""): boolean {
    if (compacting || disposed) return false;
    compacting = true;
    cancelled = false;
    const cwd = ctx.cwd || process.cwd();
    writeNoteBackupAtomic(noteBackupPathFor(cwd), formatNoteBackup(cwd, note));
    try {
      ctx.compact({
        customInstructions: `Preserve these continuation notes verbatim under '## Critical Context':\n${note}\n${extra}`.trim(),
        onComplete: () => {
          compacting = false;
          nudged = false;
          if (wantResume && mayResume(ctx)) resume(continuationContent(note));
        },
        onError: (error) => {
          compacting = false;
          if (disposed) return;
          if (cancelled) return; // a cancel is a stop boundary, not a failure to recover from
          compactionFailed = true;
          safeNotify(ctx, `[self-compact] Compaction failed: ${error.message}`, "error");
          // The run stopped for this compaction; resume so a failed compaction never strands the agent.
          if (wantResume && !disposed && resumeStreak < MAX_CONSECUTIVE_RESUMES) {
            resumeStreak++;
            resume(`[self-compact] Compaction failed (${error.message}); context was NOT reduced. Continue the active task; auto-compaction and the tool gate are paused until a compaction succeeds.`);
          }
        },
      });
    } catch {
      compacting = false;
      return false;
    }
    return true;
  }

  pi.registerTool({
    name: "self_compact",
    label: "Self-Compact Context",
    description:
      "Proactively trigger context compaction at a natural task boundary, preserving structured continuation notes (goal, completed work, remaining tasks, decisions, invariants) into the fresh post-compaction context. The agent resumes automatically afterwards.",
    promptSnippet:
      "Call self_compact with continuation notes at task milestones or when asked to by a [self-compact] message.",
    parameters: Type.Object({
      note: Type.String({
        description:
          "Structured continuation notes to survive compaction (e.g. Current Goal, Done, In Progress, Blockers, Key Decisions, Immediate Next Steps, Critical Invariants).",
      }),
      customInstructions: Type.Optional(
        Type.String({ description: "Optional custom instructions to guide the compaction summarizer." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const note = params.note?.trim();
      if (!note) throw new Error("Continuation note cannot be empty. Please provide structured notes.");
      if (note.length > 60000) throw new Error("Continuation note exceeds maximum size (60,000 characters).");
      if (compacting) {
        return { content: [{ type: "text", text: "[self-compact] A compaction is already in progress." }] };
      }

      // A stopped tool must neither compact nor resume: check before and after the (network) audit.
      const stopped = { content: [{ type: "text" as const, text: "[self-compact] Aborted; no compaction started." }] };
      if (signal?.aborted) return stopped;

      let jevReport = "";
      if (config.jevEnabled && jevApiKey) {
        const audit = await auditContinuationNoteWithJev(note, jevApiKey, signal);
        if (signal?.aborted || disposed) return stopped;
        if (audit) {
          jevReport = `\n[Jev Audit: ${audit.readiness.toUpperCase()} (Score: ${audit.completeness.toFixed(1)}/2.0, Actionable: ${Math.round(audit.actionable * 100)}%)]`;
          if (audit.readiness !== "ready") jevReport += " Warning: note may lack concrete next steps.";
        }
      }

      // No resumeStreak reset here: repeated model calls must not bypass the resume bound.
      // It resets only on measured headroom (turn_end) or an explicit /self-compact.
      schedule(ctx, note, params.customInstructions ?? "");
      return {
        content: [
          {
            type: "text",
            text: `[self-compact] Compaction scheduled: this turn ends now, context is compacted, and the agent resumes with your note (${note.length} chars).${jevReport}`,
          },
        ],
        details: undefined,
        terminate: true, // end the turn without another model request; compaction starts once settled
      };
    },
  });

  pi.registerCommand("self-compact", {
    description: "Compact now, preserving optional continuation notes; resumes the agent if it was working",
    handler: async (args, ctx) => {
      const note = args?.trim().slice(0, 60000) || "Manual user-requested compaction.";
      resumeStreak = 0;
      pending = null; // the user's compaction replaces any scheduled one
      armed = false;
      // Only resume a run the user interrupted; an idle session stays idle.
      if (!startCompaction(ctx, note, ctx.isIdle?.() === false)) {
        safeNotify(ctx, "[self-compact] A compaction is already in progress.", "warning");
      }
    },
  });

  // A scheduled compaction ends the turn: other tool calls are blocked with terminate, so the loop
  // stops after this batch without an abort. At forcePct the run stops even with nothing scheduled.
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName === "self_compact" || event.toolName === "yield_control") return;
    if (pending) {
      return {
        block: true,
        terminate: true,
        reason: "[self-compact] A compaction is scheduled, so this turn is ending; the agent resumes automatically afterwards. Redo this call then if it is still needed.",
      };
    }
    if (isSubagent() || compactionFailed) return;
    const percent = safeUsage(ctx, config.workingWindowTokens);
    if (percent === null || percent < config.forcePct) return;
    schedule(ctx, genericNote(percent));
    safeNotify(ctx, `[self-compact] Context at ${percent}%: stopping this turn to compact.`, "warning");
    return {
      block: true,
      terminate: true,
      reason: `[self-compact: FORCE GATE] Context usage is ${percent}% (threshold ${config.forcePct}%). This turn is ending to compact; the agent resumes automatically afterwards.`,
    };
  });

  pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
    // A turn finished after a built-in compaction, so the agent is already running again.
    resumeAtSettle = false;
    supersededNote = null;
    if (isSubagent() || compacting || pending) return;
    const percent = safeUsage(ctx, config.workingWindowTokens);
    if (percent === null) return;
    if (percent < config.autoCompactPct) resumeStreak = 0; // real progress with headroom

    if (percent >= config.autoCompactPct && !compactionFailed) {
      // Give the model one chance to write its own notes; any other tool call ends the turn (tool_call).
      safeNotify(ctx, `[self-compact] Context at ${percent}%: compacting at the end of this turn.`, "warning");
      schedule(
        ctx,
        genericNote(percent),
        "",
        `[self-compact] Context is at ${percent}%. Call self_compact NOW with structured continuation notes (goal, done, in progress, decisions, next steps). Any other tool call ends this turn and compacts with a generic note.`,
      );
    } else if (percent >= config.nudgePct && percent < config.autoCompactPct && !nudged) {
      nudged = true;
      // Steer reaches the model's next request; a ui.notify toast never does.
      try {
        pi.sendMessage(
          {
            customType: "self_compact_nudge",
            content: `[self-compact] Context is at ${percent}%. At the next natural boundary, call self_compact with structured continuation notes (goal, done, in progress, decisions, next steps). Auto-compaction with a generic note happens at ${config.autoCompactPct}%.`,
            display: true,
          },
          { deliverAs: "steer" },
        );
      } catch {}
    }
  });

  pi.on("session_compact_failed", async (event: any) => {
    if (compacting && event?.aborted) cancelled = true; // emitted before onError
  });

  pi.on("session_compact", async (event) => {
    nudged = false;
    compactionFailed = false;
    const superseded = !compacting ? pending : null; // Pi compacted on its own: ours is redundant
    if (superseded) {
      pending = null;
      armed = false;
      supersededNote = superseded.note;
    }
    // Built-in threshold compaction after agent_end leaves nothing queued, so Pi settles and waits
    // for the user. Overflow recovery with willRetry already continues; manual compactions are ours or the user's.
    if (!compacting && event.reason === "threshold" && !event.willRetry) resumeAtSettle = true;
  });

  pi.on("agent_start", async () => {
    runs++;
  });

  pi.on("agent_before_settle", async (event: any, ctx: ExtensionContext) => {
    // Pi only gets here when no abort was requested before the boundary; an aborted or failed run never arms.
    if (pending && event?.outcome !== "aborted" && event?.outcome !== "error") armed = true;
    if (!resumeAtSettle) return;
    resumeAtSettle = false;
    const note = supersededNote;
    supersededNote = null;
    if (!mayResume(ctx)) return;
    return {
      continue: true,
      entries: [{ type: "custom_message", customType: CONTINUATION_CUSTOM_TYPE, content: continuationContent(note), display: true }],
    };
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    const job = pending;
    const go = armed;
    pending = null;
    armed = false;
    if (!job || disposed) return;
    if (!go) {
      safeNotify(ctx, "[self-compact] The run was stopped, so the scheduled compaction was skipped.", "info");
      return;
    }
    // Wait out a short quiet period after the settle handlers: a continuation another extension queued
    // there (Pi runs it right after them) goes first, and this compaction waits for that run to end.
    // ponytail: Pi 1.0.0 shows extensions neither a stop pressed after agent_before_settle nor the end of
    // other extensions' settle handlers. A stop in that window (handlers + QUIET_MS) is missed, and a
    // handler slower than QUIET_MS can still overlap. A stop once compaction has started cancels it, and
    // a cancelled compaction never resumes. Upgrade path: a Pi hook that runs after deferred settle actions.
    const gen = runs;
    let waited = 0;
    const check = () => {
      if (disposed || compacting) return;
      let idle = false;
      try { idle = ctx.isIdle(); } catch { return; }
      if (runs !== gen || !idle) {
        pending ??= job; // compact when that run settles
        return;
      }
      if (waited < QUIET_MS) {
        waited += 10;
        setTimeout(check, 10);
        return;
      }
      startCompaction(ctx, job.note, true, job.extra);
    };
    setTimeout(check, 0);
  });

  pi.on("session_shutdown", async () => {
    disposed = true;
    resumeAtSettle = false;
    pending = null;
    armed = false;
  });
}

function safeNotify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") {
  try {
    ctx.ui?.notify?.(msg, level);
  } catch {} // ctx is invalidated after shutdown and throws on access
}

function safeUsage(ctx: ExtensionContext, workingWindow: number): number | null {
  try {
    return usagePercent(ctx, workingWindow);
  } catch {
    return null;
  }
}
