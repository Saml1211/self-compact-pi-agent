import { homedir } from "node:os";
import { join } from "node:path";
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
  forcePct: number; // block every tool except self_compact / yield_control
  jevEnabled: boolean; // audit continuation notes with TypeSafe Jev
}

export const DEFAULT_CONFIG: SelfCompactConfig = {
  nudgePct: 70,
  autoCompactPct: 80,
  forcePct: 88,
  jevEnabled: true,
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
  };
  // Mis-ordered overrides would make a later stage fire first; fall back wholesale.
  if (!(cfg.nudgePct < cfg.autoCompactPct && cfg.autoCompactPct < cfg.forcePct)) {
    return { ...DEFAULT_CONFIG, jevEnabled: cfg.jevEnabled };
  }
  return cfg;
}

export const CONTINUATION_CUSTOM_TYPE = "self_compact_continuation";

export function continuationContent(note: string | null): string {
  const head =
    "[self-compact] Context was just compacted. Resume the active task now — do not wait for user input and do not redo finished work.";
  return note ? `${head}\n\nContinuation notes written before compaction:\n${note}` : head;
}

function isSubagent(): boolean {
  return process.env.PI_CREW_KIND === "subagent" || Boolean(process.env.PI_CREW_DEPTH && process.env.PI_CREW_DEPTH !== "0");
}

function usagePercent(ctx: ExtensionContext): number | null {
  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null || !usage.contextWindow) return null;
  return usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100);
}

export default function (pi: ExtensionAPI) {
  const config = resolveConfig();
  const jevApiKey = resolveJevApiKey();
  const noteBackupPath = join(homedir(), ".pi/state/last-continuation-note.md");

  let compacting = false; // one of our own ctx.compact() calls is in flight
  let resumeAtSettle = false; // Pi's built-in compaction ran after the run ended
  let nudged = false; // nudge sent since the last compaction
  // ponytail: after a failed auto-compact, stop auto-retrying until some compaction succeeds;
  // otherwise every turn_end above the threshold would abort the run and fail again.
  let autoCompactFailed = false;
  let lastNote: string | null = null;

  // ctx.compact() aborts the running agent (AgentSession.compact -> abort()), so the
  // agent_before_settle boundary never fires for it. Resume from onComplete instead.
  function startCompaction(ctx: ExtensionContext, note: string, resume: boolean, extra = ""): boolean {
    if (compacting) return false;
    compacting = true;
    lastNote = note;
    writeNoteBackupAtomic(noteBackupPath, note);
    ctx.compact({
      customInstructions: `Preserve these continuation notes verbatim under '## Critical Context':\n${note}\n${extra}`.trim(),
      onComplete: () => {
        compacting = false;
        nudged = false;
        if (resume) {
          pi.sendMessage(
            { customType: CONTINUATION_CUSTOM_TYPE, content: continuationContent(note), display: true },
            { triggerTurn: true },
          );
        }
      },
      onError: (error) => {
        compacting = false;
        autoCompactFailed = true;
        ctx.ui?.notify?.(`[self-compact] Compaction failed: ${error.message}`, "error");
        // compact() already aborted the run; resume anyway so a failed compaction never strands the agent.
        if (resume) {
          pi.sendMessage(
            {
              customType: CONTINUATION_CUSTOM_TYPE,
              content: `[self-compact] Compaction failed (${error.message}); context was NOT reduced. Continue the active task.`,
              display: true,
            },
            { triggerTurn: true },
          );
        }
      },
    });
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

      let jevReport = "";
      if (config.jevEnabled && jevApiKey) {
        const audit = await auditContinuationNoteWithJev(note, jevApiKey, signal);
        if (audit) {
          jevReport = `\n[Jev Audit: ${audit.readiness.toUpperCase()} (Score: ${audit.completeness.toFixed(1)}/2.0, Actionable: ${Math.round(audit.actionable * 100)}%)]`;
          if (audit.readiness !== "ready") jevReport += " Warning: note may lack concrete next steps.";
        }
      }

      startCompaction(ctx, note, true, params.customInstructions ?? "");
      return {
        content: [
          {
            type: "text",
            text: `[self-compact] Compaction started. The agent resumes automatically with your note (${note.length} chars).${jevReport}`,
          },
        ],
      };
    },
  });

  pi.registerCommand("self-compact", {
    description: "Compact now, preserving optional continuation notes; resumes the agent if it was working",
    handler: async (args, ctx) => {
      const note = args?.trim().slice(0, 60000) || "Manual user-requested compaction.";
      // Only resume a run the user interrupted; an idle session stays idle.
      if (!startCompaction(ctx, note, ctx.isIdle?.() === false)) {
        ctx.ui?.notify?.("[self-compact] A compaction is already in progress.", "warning");
      }
    },
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (isSubagent()) return;
    const percent = usagePercent(ctx);
    if (percent === null || percent < config.forcePct) return;
    if (event.toolName === "self_compact" || event.toolName === "yield_control") return;
    return {
      block: true,
      reason: `[self-compact: FORCE GATE] Context usage is ${percent}% (threshold ${config.forcePct}%). Call 'self_compact' with continuation notes before any other tool.`,
    };
  });

  pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
    // A turn finished after a built-in compaction, so the agent is already running again.
    resumeAtSettle = false;
    if (isSubagent() || compacting) return;
    const percent = usagePercent(ctx);
    if (percent === null) return;

    if (percent >= config.autoCompactPct && !autoCompactFailed) {
      ctx.ui?.notify?.(`[self-compact] Auto-compacting at ${percent}% context usage.`, "warning");
      startCompaction(
        ctx,
        `Autonomous self-compaction at ${percent}% context usage; the model did not call self_compact. Reconstruct the active task from the summary.`,
        true,
      );
    } else if (percent >= config.nudgePct && !nudged) {
      nudged = true;
      // Steer reaches the model's next request; a ui.notify toast never does.
      pi.sendMessage(
        {
          customType: "self_compact_nudge",
          content: `[self-compact] Context is at ${percent}%. At the next natural boundary, call self_compact with structured continuation notes (goal, done, in progress, decisions, next steps). Auto-compaction with a generic note happens at ${config.autoCompactPct}%.`,
          display: true,
        },
        { deliverAs: "steer" },
      );
    }
  });

  pi.on("session_compact", async (event) => {
    nudged = false;
    autoCompactFailed = false;
    // Built-in threshold compaction after agent_end leaves nothing queued, so Pi settles and waits
    // for the user. Overflow recovery with willRetry already continues; manual compactions are ours or the user's.
    if (!compacting && event.reason === "threshold" && !event.willRetry) resumeAtSettle = true;
  });

  pi.on("agent_before_settle", async () => {
    if (!resumeAtSettle) return;
    resumeAtSettle = false;
    const note = lastNote;
    lastNote = null;
    return {
      continue: true,
      entries: [{ type: "custom_message", customType: CONTINUATION_CUSTOM_TYPE, content: continuationContent(note), display: true }],
    };
  });
}
