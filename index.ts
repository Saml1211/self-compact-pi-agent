import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ponytail: minimal Typesafe Jev client inline to ensure zero dependency hazards
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

interface JevNoteAudit {
  actionable: number; // 0..1
  completeness: number; // 0..2
  readiness: string; // "ready" | "needs_detail" | "insufficient"
  confidence: number;
}

interface SelfCompactConfig {
  noticePct: number;
  warningPct: number;
  forcePct: number;
  jevEnabled: boolean;
}

const DEFAULT_CONFIG: SelfCompactConfig = {
  noticePct: 70,
  warningPct: 80,
  forcePct: 90,
  jevEnabled: true,
};

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

async function auditContinuationNoteWithJev(
  note: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<JevNoteAudit | null> {
  const body = {
    state: note,
    model: JEV_MODEL,
    questions: {
      actionable: {
        type: "noul",
        instructions:
          "Does this continuation note clearly specify the next concrete steps, files to touch, or actions to take?",
      },
      completeness: {
        type: "score",
        instructions:
          "How completely does this continuation note capture critical task state (completed work, in-progress items, key decisions, file paths)?",
        criteria: [
          "Minimal or vague; missing context and next steps",
          "Partial; mentions tasks or progress but lacks specific files, invariants, or next actions",
          "Complete and decision-ready; contains explicit progress, files, decisions, and clear next steps",
        ],
      },
      readiness: {
        type: "choice",
        instructions:
          "Is this note ready to guide an agent immediately post-compaction without re-investigating?",
        criteria: {
          ready: "Contains sufficient guidance and context to continue work immediately",
          needs_detail: "Lacks key specifics about files, commands, or pending errors",
          insufficient: "Generic text without actionable project state",
        },
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

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

    return {
      actionable: answers.actionable?.noul ?? 0.5,
      completeness: answers.completeness?.score ?? 1.0,
      readiness: answers.readiness?.choice ?? "ready",
      confidence: answers.readiness?.confidence ?? 0.5,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function evaluateCheckpointWithJev(
  stateSummary: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ timingAdvice: string; isSafeMilestone: number } | null> {
  const body = {
    state: stateSummary,
    model: JEV_MODEL,
    questions: {
      is_safe_milestone: {
        type: "noul",
        instructions:
          "Is the agent at a clean stopping point or task milestone where compaction will not disrupt an unfinished in-flight operation (like an unverified edit or incomplete command)?",
      },
      timing_advice: {
        type: "choice",
        instructions: "How should compaction be timed given the current task status?",
        criteria: {
          compact_now: "Current subtask is finished; ideal moment to compact before starting new work",
          finish_step_first: "In the middle of an edit, test, or debugging step; finish this step before compacting",
          urgent_compact: "Context is overflowing; must compact immediately regardless of task state",
        },
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

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

    return {
      isSafeMilestone: answers.is_safe_milestone?.noul ?? 0.5,
      timingAdvice: answers.timing_advice?.choice ?? "finish_step_first",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default function (pi: ExtensionAPI) {
  let pendingCarryoverNote: string | null = null;
  let activeInjectedNote: string | null = null;
  let lastNoticeTime = 0;
  let lastWarningTime = 0;

  const stateDir = join(homedir(), ".pi/state");
  const noteBackupPath = join(stateDir, "self-compact-last-note.md");

  // Load configuration
  const config: SelfCompactConfig = {
    noticePct: Number(process.env.PI_SELF_COMPACT_NOTICE_PCT) || DEFAULT_CONFIG.noticePct,
    warningPct: Number(process.env.PI_SELF_COMPACT_WARNING_PCT) || DEFAULT_CONFIG.warningPct,
    forcePct: Number(process.env.PI_SELF_COMPACT_FORCE_PCT) || DEFAULT_CONFIG.forcePct,
    jevEnabled: process.env.PI_SELF_COMPACT_JEV === "false" ? false : DEFAULT_CONFIG.jevEnabled,
  };

  const jevApiKey = resolveJevApiKey();

  // 1. Register the self_compact tool for autonomous agent compaction
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
    async execute(_toolCallId, params, ctx: ExtensionContext) {
      pendingCarryoverNote = params.note.trim();

      // Persist backup to disk
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(noteBackupPath, pendingCarryoverNote, "utf8");
      } catch {}

      let jevReport = "";
      if (config.jevEnabled && jevApiKey) {
        const audit = await auditContinuationNoteWithJev(params.note, jevApiKey, ctx.signal);
        if (audit) {
          const qual = audit.readiness;
          const score = audit.completeness.toFixed(1);
          const act = Math.round(audit.actionable * 100);
          jevReport = `\n[Jev Audit: ${qual.toUpperCase()} (Score: ${score}/2.0, Actionable: ${act}%)]`;
          if (audit.readiness !== "ready") {
            jevReport += ` Warning: Note may lack concrete next steps or specific files. Note accepted for compaction.`;
          }
        }
      }

      // Instruct compaction engine to strictly preserve the note
      const preservePrompt = `\n\nCRITICAL CONTEXT & CONTINUATION NOTES TO PRESERVE VERBATIM:\n${pendingCarryoverNote}\n${params.customInstructions || ""}`.trim();

      // Trigger Pi's native compaction
      ctx.compact({
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
      ctx.compact({
        customInstructions: `CRITICAL CONTEXT & CONTINUATION NOTES TO PRESERVE:\n${note}`,
      });
    },
  });

  // 3. Tool Call Gate (Force Threshold)
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    // Child workers running isolated subtasks don't manage estate-level root compaction
    if (process.env.PI_CREW_KIND === "subagent" || (process.env.PI_CREW_DEPTH && process.env.PI_CREW_DEPTH !== "0")) {
      return;
    }

    const usage = ctx.getContextUsage?.();
    if (!usage || usage.tokens === null || !usage.contextWindow) {
      return;
    }

    const percent = usage.percent ?? Math.round((usage.tokens / usage.contextWindow) * 100);

    // If context is above force threshold, lock all non-compaction tools
    if (percent >= config.forcePct) {
      if (event.toolName !== "self_compact" && event.toolName !== "yield_control") {
        return {
          block: true,
          reason: `[self-compact: FORCE GATE] Context usage is critical at ${percent}% (threshold: ${config.forcePct}%). Non-compaction tools are locked. You MUST call 'self_compact' with your continuation notes to cleanly compact history before continuing.`,
        };
      }
    }
  });

  // 4. Turn End Watchdog (Notice & Warning Thresholds + Jev Checkpoint Evaluation)
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

    if (percent >= config.warningPct && percent < config.forcePct) {
      if (now - lastWarningTime > 45000) {
        lastWarningTime = now;
        let jevNote = "";
        if (config.jevEnabled && jevApiKey) {
          const evalRes = await evaluateCheckpointWithJev(`Context tokens: ${usage.tokens}/${usage.contextWindow} (${percent}%)`, jevApiKey, ctx.signal);
          if (evalRes) {
            jevNote = ` | Jev: ${evalRes.timingAdvice} (safe milestone: ${Math.round(evalRes.isSafeMilestone * 100)}%)`;
          }
        }
        ctx.ui?.notify?.(
          `[self-compact: Warning] Context usage is at ${percent}%. Approaching limit${jevNote}. Call 'self_compact' with continuation notes to preserve state.`,
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
    // If we have a pending carryover note from self_compact, inject it into the summarizer prompt
    if (pendingCarryoverNote) {
      const addition = `\n\n## MANDATORY CONTINUATION NOTES (Preserve under '## Critical Context'):\n${pendingCarryoverNote}\n`;
      event.customInstructions = (event.customInstructions || "") + addition;
      activeInjectedNote = pendingCarryoverNote;
    }
  });

  pi.on("session_compact", async () => {
    // After compaction successfully completes, mark that the note should be displayed/injected
    if (pendingCarryoverNote) {
      activeInjectedNote = pendingCarryoverNote;
      pendingCarryoverNote = null;
    }
  });

  // 6. Post-compaction state injection into subsequent turn
  pi.on("before_agent_start", async (_event, ctx: ExtensionContext) => {
    if (activeInjectedNote) {
      ctx.ui?.notify?.("[self-compact] Restored continuation notes from prior self-compaction.", "info");
      // Add guidelines into active session so the model immediately sees its working memory
      _event.systemPromptOptions = _event.systemPromptOptions || {};
      _event.systemPromptOptions.guidelines = _event.systemPromptOptions.guidelines || [];
      _event.systemPromptOptions.guidelines.push(
        `[PRESERVED CONTINUATION NOTES FROM SELF-COMPACTION]:\n${activeInjectedNote}`,
      );
      activeInjectedNote = null;
    }
  });
}
