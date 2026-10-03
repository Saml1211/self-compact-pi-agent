import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// Default context pressure thresholds (percentage of context window used)
// Set to trigger BEFORE Pi's default 80-85% built-in compaction threshold
export interface SelfCompactConfig {
  noticePct: number; // e.g. 65%: notify agent
  warningPct: number; // e.g. 72%: strong recommendation
  autoCompactPct: number; // e.g. 78%: autonomously triggers compaction before built-in threshold
  forcePct: number; // e.g. 85%: lock tools, force compaction
  jevEnabled: boolean; // whether to run TypeSafe Jev quality checks on continuation notes
}

const DEFAULT_CONFIG: SelfCompactConfig = {
  noticePct: 65,
  warningPct: 72,
  autoCompactPct: 78,
  forcePct: 85,
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

export default function (pi: ExtensionAPI) {
  let pendingCarryoverNote: string | null = null;
  let activeInjectedNote: string | null = null;
  let justCompacted = false;
  let lastNoticeTime = 0;
  let lastWarningTime = 0;

  const stateDir = join(homedir(), ".pi/state");
  const noteBackupPath = join(stateDir, "last-continuation-note.md");

  const notice = sanitizeThreshold(process.env.PI_SELF_COMPACT_NOTICE_PCT, DEFAULT_CONFIG.noticePct);
  const warning = sanitizeThreshold(process.env.PI_SELF_COMPACT_WARNING_PCT, DEFAULT_CONFIG.warningPct);
  const autoCompact = sanitizeThreshold(process.env.PI_SELF_COMPACT_AUTO_PCT, DEFAULT_CONFIG.autoCompactPct);
  const force = sanitizeThreshold(process.env.PI_SELF_COMPACT_FORCE_PCT, DEFAULT_CONFIG.forcePct);

  const config: SelfCompactConfig = {
    noticePct: notice,
    warningPct: warning,
    autoCompactPct: autoCompact,
    forcePct: force,
    jevEnabled: process.env.PI_SELF_COMPACT_JEV === "false" ? false : DEFAULT_CONFIG.jevEnabled,
  };

  const jevApiKey = resolveJevApiKey();

  // 1. Register self_compact tool (conforming to Pi's 5-argument execute signature)
  pi.registerTool({
    name: "self_compact",
    label: "Self-Compact Context",
    description:
      "Proactively trigger context compaction at a natural task boundary, preserving structured continuation notes (goal, completed work, remaining tasks, decisions, invariants) into the fresh post-compaction context.",
    promptSnippet:
      "Call self_compact with continuation notes at task milestones or when context exceeds 70-80% to prevent unguided auto-compaction.",
    parameters: Type.Object({
      note: Type.String({
        description:
          "Structured continuation notes to survive compaction (e.g. Current Goal, Done, In Progress, Blockers, Key Decisions, Immediate Next Steps, Critical Invariants).",
      }),
      customInstructions: Type.Optional(
        Type.String({
          description: "Optional custom instructions to guide the compaction summarizer.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const effectiveCtx: ExtensionContext | undefined = ctx || (signal && typeof (signal as any).compact === "function" ? (signal as any) : undefined);
      const effectiveSignal: AbortSignal | undefined = signal instanceof AbortSignal ? signal : effectiveCtx?.signal;

      const trimmedNote = params.note?.trim();
      if (!trimmedNote || trimmedNote.length === 0) {
        throw new Error("Continuation note cannot be empty. Please provide structured notes.");
      }
      if (trimmedNote.length > 60000) {
        throw new Error("Continuation note exceeds maximum size (60,000 characters).");
      }

      pendingCarryoverNote = trimmedNote;

      // Safe atomic backup to disk
      writeNoteBackupAtomic(noteBackupPath, pendingCarryoverNote);

      let jevReport = "";
      if (config.jevEnabled && jevApiKey) {
        const audit = await auditContinuationNoteWithJev(trimmedNote, jevApiKey, effectiveSignal);
        if (audit) {
          const qual = audit.readiness;
          const score = audit.completeness.toFixed(1);
          const act = Math.round(audit.actionable * 100);
          jevReport = `\n[Jev Audit: ${qual.toUpperCase()} (Score: ${score}/2.0, Actionable: ${act}%)]`;
          if (audit.readiness !== "ready") {
            jevReport += ` Warning: Note may lack concrete next steps. Note accepted for compaction.`;
          }
        }
      }

      // Instruct compaction engine to strictly preserve the note
      const preservePrompt = `\n\nCRITICAL CONTEXT & CONTINUATION NOTES TO PRESERVE VERBATIM:\n${pendingCarryoverNote}\n${params.customInstructions || ""}`.trim();

      // Trigger Pi's native compaction
      effectiveCtx?.compact?.({
        customInstructions: preservePrompt,
      });

      return {
        content: [
          {
            type: "text",
            text: `[self-compact] Compaction initiated successfully.${jevReport}\nContinuation note cached (${pendingCarryoverNote.length} chars) and will be restored post-compaction.`,
          },
        ],
      };
    },
  });

  // 2. Register slash command /self-compact for user manual invocation
  pi.registerCommand("self-compact", {
    description: "Trigger self-compaction with optional continuation notes",
    handler: async (args, ctx) => {
      const note = args?.trim() || "Manual user-requested compaction";
      pendingCarryoverNote = note;
      ctx.ui?.notify?.("Self-compaction initiated...", "info");
      ctx.compact?.({
        customInstructions: `CRITICAL CONTEXT & CONTINUATION NOTES TO PRESERVE:\n${note}`,
      });
    },
  });

  // 3. Tool Call Gate (Force Threshold)
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (process.env.PI_CREW_KIND === "subagent" || (process.env.PI_CREW_DEPTH && process.env.PI_CREW_DEPTH !== "0")) {
      return;
    }

    const usage = ctx.getContextUsage?.();
    if (!usage || usage.tokens === null || !usage.contextWindow) {
      return;
    }

    const percent = usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100);

    if (percent >= config.forcePct) {
      if (event.toolName !== "self_compact" && event.toolName !== "yield_control") {
        return {
          block: true,
          reason: `[self-compact: FORCE GATE] Context usage is critical at ${percent}% (threshold: ${config.forcePct}%). Non-compaction tools are locked. You MUST call 'self_compact' with your continuation notes to cleanly compact history before continuing.`,
        };
      }
    }
  });

  // 4. Turn End Watchdog (Autonomous compaction trigger & early warnings)
  pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
    if (process.env.PI_CREW_KIND === "subagent") {
      return;
    }

    const usage = ctx.getContextUsage?.();
    if (!usage || usage.tokens === null || !usage.contextWindow) {
      return;
    }

    const percent = usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100);
    const now = Date.now();

    // AUTONOMOUS COMPACTION TRIGGER: Triggers at 78% before Pi's built-in 80-85% threshold
    if (percent >= config.autoCompactPct) {
      const autoNote = `Autonomous self-compaction triggered at ${percent}% token usage to preserve state before window exhaustion.`;
      pendingCarryoverNote = pendingCarryoverNote || autoNote;
      writeNoteBackupAtomic(noteBackupPath, pendingCarryoverNote);

      ctx.ui?.notify?.(
        `[self-compact] Autonomously triggering compaction at ${percent}% context usage...`,
        "warning",
      );

      ctx.compact?.({
        customInstructions: `AUTONOMOUS CONTEXT COMPACTION (Triggered at ${percent}% token pressure):\n${pendingCarryoverNote}`,
      });
      return;
    }

    if (percent >= config.warningPct && percent < config.autoCompactPct) {
      if (now - lastWarningTime > 45000) {
        lastWarningTime = now;
        ctx.ui?.notify?.(
          `[self-compact: Warning] Context usage is at ${percent}%. Approaching limit. Call 'self_compact' with continuation notes to preserve state.`,
          "warning",
        );
      }
    } else if (percent >= config.noticePct && percent < config.warningPct) {
      if (now - lastNoticeTime > 60000) {
        lastNoticeTime = now;
        ctx.ui?.notify?.(
          `[self-compact: Notice] Context usage is at ${percent}%. Consider wrapping up the active subtask and calling 'self_compact'.`,
          "info",
        );
      }
    }
  });

  // 5. Compaction Lifecycle Hooks
  pi.on("session_before_compact", async (event) => {
    if (pendingCarryoverNote) {
      const addition = `\n\n## MANDATORY CONTINUATION NOTES (Preserve under '## Critical Context'):\n${pendingCarryoverNote}\n`;
      event.customInstructions = (event.customInstructions || "") + addition;
    }
  });

  pi.on("session_compact", async () => {
    justCompacted = true;
    if (pendingCarryoverNote) {
      activeInjectedNote = pendingCarryoverNote;
      pendingCarryoverNote = null;
    }
  });

  // 6. Post-compaction state injection into subsequent turn
  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (activeInjectedNote) {
      ctx.ui?.notify?.("[self-compact] Restored continuation notes from prior self-compaction.", "info");
      const guidelines = (event.promptGuidelines = event.promptGuidelines || []);
      guidelines.push(`[PRESERVED CONTINUATION NOTES FROM SELF-COMPACTION]:\n${activeInjectedNote}`);
      activeInjectedNote = null;
    }
  });

  // 7. Auto-Continue Boundary Hook: Automatically continues execution post-compaction
  // Eliminates the need for the user to manually send "continue" after compaction!
  pi.on("agent_before_settle", async () => {
    if (justCompacted) {
      justCompacted = false;
      return {
        continue: true,
        entries: [
          {
            type: "custom_message",
            customType: "self_compact_continuation",
            content:
              "[SYSTEM: Context compaction completed successfully. Preserved continuation state has been restored into prompt guidelines. Resume and continue executing your active task immediately without waiting for user input.]",
            display: true,
          },
        ],
      };
    }
  });
}
