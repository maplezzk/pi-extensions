/**
 * SubagentWorkflowAgent — workflow backend backed by pi-interactive-subagents.
 *
 * Activated when PI_WORKFLOW_BACKEND=subagent.  Uses launchSubagent / watchSubagent
 * to run each agent() call as a separate tmux-pane subagent with real tool access.
 * Structured output is enforced via the subagent's structured_output tool (ajv validation)
 * rather than the in-memory session's structured_output mechanism.
 */

// ── defensive .jsonl validator ──
// 拦截 pollForExit 误判（fast path 命中残留 .exit 或 slow path 读到 stale
// sentinel）导致的"子 agent 根本没启动就被判定完成"。herdr-split.log 9:01 失败批次
// 模式：pane run 6ms 后 close，subagentSessionFile.jsonl 永远不存在。
import { existsSync, statSync } from "node:fs";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

/** 校验子 agent 的 .jsonl 会话文件是否真实存在且非空，防止 pollForExit 误判。 */
function sessionFileLooksValid(jsonlPath: string): { ok: boolean; reason: string; size: number } {
  if (!existsSync(jsonlPath)) return { ok: false, reason: "missing", size: 0 };
  try {
    const size = statSync(jsonlPath).size;
    if (size === 0) return { ok: false, reason: "empty", size: 0 };
    return { ok: true, reason: "ok", size };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `stat_failed:${msg}`, size: 0 };
  }
}

// ── types lifted from pi-interactive-subagents ──
interface SubagentCtx {
  sessionManager: {
    getSessionFile(): string | null;
    getSessionId(): string;
    getSessionDir(): string;
  };
  cwd: string;
  model?: unknown;
  modelRegistry?: unknown;
  ui?: { notify?(message: string, level: "info" | "warning" | "error"): void };
  [key: string]: unknown;
}

/** Mirror of pi-interactive-subagents' RunningSubagent (subset we care about). */
interface RunningSubagent {
  id: string;
  name: string;
  surface: string;
  sessionFile: string;
  startTime: number;
}

/** Mirror of pi-interactive-subagents' SubagentResult. */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  structuredOutput?: unknown;
}

// ── subagent API (lazily resolved from globalThis) ──
interface SubagentApi {
  launchSubagent(
    params: Record<string, unknown>,
    ctx: SubagentCtx,
    options?: { surface?: string },
  ): Promise<RunningSubagent>;
  watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
}

function getSubagentApi(): SubagentApi {
  const api = (globalThis as any).__pi_subagents;
  if (!api) {
    throw new Error(i18n.t("subagentRequired"));
  }
  return api as SubagentApi;
}

// ── options ──
export interface SubagentWorkflowAgentOptions {
  cwd?: string;
  /** Pi extension context (passed from workflow-tool execute callback). */
  launchCtx: SubagentCtx;
  /** Model override for subagent sessions (string id, not Model object). */
  model?: string;
  /** Extra instructions prepended to every agent() prompt. */
  instructions?: string;
}

export interface AgentRunOptions {
  label?: string;
  schema?: unknown;
  signal?: AbortSignal;
  instructions?: string;
  /** 覆盖 subagent 的模型，不传则走默认 fallback */
  model?: string;
}

export type AgentRunResult = unknown;

// ── agent ──
export class SubagentWorkflowAgent {
  private readonly cwd: string;
  private readonly launchCtx: SubagentCtx;
  private readonly model?: string;
  private readonly instructions?: string;

  constructor(options: SubagentWorkflowAgentOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.launchCtx = options.launchCtx;
    this.model = options.model;
    this.instructions = options.instructions;
  }

  async run(prompt: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    const api = getSubagentApi();

    const taskParts = [
      this.instructions,
      options.instructions,
      options.label ? `Task label: ${options.label}` : undefined,
      prompt,
    ].filter(Boolean);
    const task = taskParts.join("\n\n");

    const launchedAt = Date.now();
    const running = await api.launchSubagent(
      {
        name: options.label ?? "workflow-agent",
        task,
        model: options.model ?? this.model,
        cwd: this.cwd,
        ...(options.schema ? { structuredOutputSchema: options.schema } : {}),
      },
      this.launchCtx,
    );
    this.launchCtx.ui?.notify?.(`[workflow] "${options.label ?? "workflow-agent"}" launched (${Date.now() - launchedAt}ms)`, "info");

    // Create abort signal that combines caller's signal with module-level abort
    const abortController = new AbortController();
    let removeAbort: (() => void) | undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        throw new Error("Subagent was aborted");
      }
      const onAbort = () => abortController.abort();
      options.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }

    try {
      const watchStartedAt = Date.now();
      const result = await api.watchSubagent(running, abortController.signal);
      const watchTookMs = Date.now() - watchStartedAt;
      this.launchCtx.ui?.notify?.(
        `[workflow] "${options.label ?? "workflow-agent"}" done (${watchTookMs}ms) → ` +
          `exitCode=${result.exitCode} hasOutput=${result.structuredOutput !== undefined}`,
        "info",
      );

      if (options.signal?.aborted) throw new Error("Subagent was aborted");

      // 防御性校验：pollForExit 任何 reason (done / structured_output / ping / sentinel)
      // 都要求 .jsonl 实际存在 + 非空。如果 .jsonl 不存在/为空，说明子 pi 根本没启动
      // （典型场景：pane run 6ms 内 close、herdr 静默失败、stale .exit 残留命中 fast path）。
      // 这种"假成功"比"明确失败"更危险——workflow 会把空数据当成结果继续往下走。
      const jsonlCheck = sessionFileLooksValid(running.sessionFile);
      if (!jsonlCheck.ok) {
        this.launchCtx.ui?.notify?.(
          `[workflow] "${options.label ?? "workflow-agent"}" SESSION FILE ${jsonlCheck.reason} ` +
            `(${watchTookMs}ms, session ${running.sessionFile}) — ` +
            `subagent never actually started, likely pollForExit false positive`,
          "error",
        );
        throw new Error(
          `Subagent pollForExit returned in ${watchTookMs}ms but session file is ` +
            `${jsonlCheck.reason} (${running.sessionFile}). ` +
            `This indicates the subagent never actually started — ` +
            `likely a false positive from pollForExit (herdr workspace state issue). ` +
            `Try restarting the herdr workspace or check for stale .exit sidecar files.`,
        );
      }

      if (options.schema) {
        if (result.structuredOutput === undefined) {
          this.launchCtx.ui?.notify?.(
            `[workflow] "${options.label ?? "workflow-agent"}" ${watchTookMs}ms exitCode=${result.exitCode} ` +
              `— finished without calling structured_output`,
            "warning",
          );
          throw new Error("Subagent finished without calling structured_output");
        }
        return result.structuredOutput as AgentRunResult;
      }

      return result.summary as AgentRunResult;
    } finally {
      removeAbort?.();
    }
  }
}
