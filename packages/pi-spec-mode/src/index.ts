/**
 * pi-spec-mode — 终端内规格驱动开发工作流扩展
 *
 * 分工：本入口只做绑定（命令/事件/工具/UI），状态机与策略全部在
 * state.ts / artifacts.ts / policy.ts 纯函数模块中，均不依赖 pi API。
 *
 * 明确的非目标：不调用 setModel/setThinkingLevel，不启动 subagent/workflow，
 * 不自动批准（REQ-010 / REQ-006）。
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { i18n } from "./i18n.ts";
import { validateArtifact } from "./artifacts.ts";
import {
  renderSpecProgressLines,
  renderSpecProgressText,
  type SpecProgressRow,
  type SpecProgressSnapshot,
} from "./display.ts";
import {
  allowedArtifactForPhase,
  artifactFileFor,
  executeTools,
  isStateFile,
  isUnderSpecsRoot,
  parseSpecSlug,
  phaseTools,
  sameResolvedPath,
  specDirFor,
  stateFileFor,
  verificationTools,
} from "./policy.ts";
import {
  createState,
  invalidateIfStale,
  parseStatusKey,
  transition,
  type Artifact,
  type StateFile,
} from "./state.ts";

const PERSIST_KEY = "spec-mode";
const IMPLEMENTATION_PHASE = "implementation" as const;
const VERIFICATION_PHASE = "verification" as const;
const COMPLETE_PHASE = "complete" as const;
const PROGRESS_PHASES = [
  "requirements",
  "design",
  "tasks",
  IMPLEMENTATION_PHASE,
  VERIFICATION_PHASE,
] as const;
const NO_ALLOWED_FILE = "none";
const AWAITING_APPROVAL_STATUS = "awaiting_approval" as const;
const PROFILE_ACCEPTED_KIND = "accepted-by-profile" as const;
const PROGRESS_DONE: SpecProgressRow["state"] = "done";
const PROGRESS_QUEUED: SpecProgressRow["state"] = "queued";
const PROGRESS_WAITING: SpecProgressRow["state"] = "waiting";
const PROGRESS_ACTIVE: SpecProgressRow["state"] = "active";

interface SessionPersist {
  activeSlug: string | null;
  toolsBefore: string[] | null;
  lastRevision: number | null;
}

function sha256File(path: string): string {
  const raw = readFileSync(path);
  return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/** 本地最小消息类型（避免直接依赖 pi-ai / pi-agent-core 模块解析） */
interface AssistantMessageLike {
  role: "assistant";
  content: Array<{ type: string; text?: string }>;
}

interface EntryLike {
  type: string;
  customType?: string;
  message?: { role?: string; content?: unknown };
}

function isAssistantMessage(m: { role?: string; content?: unknown }): m is AssistantMessageLike {
  return m.role === "assistant" && Array.isArray(m.content);
}

function assistantText(m: AssistantMessageLike): string {
  return m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function loadState(cwd: string, slug: string): StateFile {
  const path = stateFileFor(cwd, slug);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as StateFile;
  if (parsed.schema !== "pi-spec-mode/v1") {
    throw new Error(`unknown schema: ${parsed.schema}`);
  }
  if (!Array.isArray(parsed.completedTasks)) parsed.completedTasks = [];
  return parsed;
}

/** 原子持久化状态，并校验预期 revision，检测跨会话并发覆盖。 */
function saveState({
  cwd,
  slug,
  state,
  expectedRevision = state.revision - 1,
}: {
  cwd: string;
  slug: string;
  state: StateFile;
  expectedRevision?: number;
}): void {
  const path = stateFileFor(cwd, slug);
  if (existsSync(path)) {
    const current = loadState(cwd, slug);
    if (current.revision !== expectedRevision) {
      throw new Error(
        `state revision conflict: disk=${current.revision}, expected=${expectedRevision}, next=${state.revision}`,
      );
    }
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function doneTagsInMessages(entries: EntryLike[]): Set<string> {
  const done = new Set<string>();
  for (const entry of entries) {
    const msg = entry.message;
    if (!msg || msg.role !== "assistant") continue;
    if (!isAssistantMessage(msg as { role?: string; content?: unknown })) continue;
    for (const m of assistantText(msg as AssistantMessageLike).matchAll(/\[DONE:(TASK-[A-Za-z0-9_-]+)\]/g)) {
      done.add(m[1]);
    }
  }
  return done;
}

function taskIdsFromTasksMd(cwd: string, slug: string): string[] {
  const path = artifactFileFor(cwd, slug, "tasks");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const ids: string[] = [];
  const re = /^#{2,4}\s+(TASK-[A-Za-z0-9_-]+)\b/gm;
  for (const m of text.matchAll(re)) ids.push(m[1]);
  return ids;
}

export default function (pi: ExtensionAPI): void {
  let activeSlug: string | null = null;
  let state: StateFile | null = null;
  let toolsBefore: string[] | null = null;

  // ── 内部辅助 ────────────────────────────────────────────────────────

  function persistSession(): void {
    pi.appendEntry(PERSIST_KEY, {
      activeSlug,
      toolsBefore,
      lastRevision: state?.revision ?? null,
    } satisfies SessionPersist);
  }

  function refreshState(ctx: ExtensionContext): void {
    if (!activeSlug) return;
    state = loadState(ctx.cwd, activeSlug);
  }

  function applyToolsForState(base: string[]): void {
    if (!state) return;
    const next =
      state.phase === IMPLEMENTATION_PHASE || state.phase === COMPLETE_PHASE
        ? executeTools(base)
        : state.phase === VERIFICATION_PHASE
          ? verificationTools(base)
          : phaseTools(base);
    pi.setActiveTools(next);
  }

  function enterMode(ctx: ExtensionContext, slug: string): void {
    activeSlug = slug;
    if (!toolsBefore) toolsBefore = pi.getActiveTools();
    refreshState(ctx);
    applyToolsForState(toolsBefore);
    updateUi(ctx);
    persistSession();
  }

  function exitMode(ctx: ExtensionContext): void {
    if (toolsBefore) pi.setActiveTools(toolsBefore);
    activeSlug = null;
    state = null;
    toolsBefore = null;
    ctx.ui.setStatus("spec-mode", undefined);
    ctx.ui.setWidget("spec-mode", undefined);
    persistSession();
  }

  function stageLabel(phase: string): string {
    return i18n.t(`status.stageNames.${phase}` as never);
  }

  function statusLabel(status: string): string {
    return i18n.t(`status.statusNames.${status}` as never);
  }

  /** 构建当前进度快照，供常驻 Widget 和 /spec status 共用。 */
  function progressSnapshot(ctx: ExtensionContext): SpecProgressSnapshot | null {
    if (!activeSlug || !state) return null;
    const s = state;
    const taskIds = taskIdsFromTasksMd(ctx.cwd, activeSlug);
    const doneTasks = doneTagsInMessages(
      ctx.sessionManager.getBranch() as EntryLike[],
    );
    for (const taskId of s.completedTasks ?? []) doneTasks.add(taskId);
    const completedTaskCount = taskIds.filter((id) => doneTasks.has(id)).length;
    const currentIndex = PROGRESS_PHASES.indexOf(
      s.phase as (typeof PROGRESS_PHASES)[number],
    );

    const rows: SpecProgressRow[] = PROGRESS_PHASES.map((phase, index) => {
      const label = i18n.t(`status.widgetSteps.${phase}` as never);
      if (s.phase === COMPLETE_PHASE || index < currentIndex) {
        const artifact = s.artifacts[phase as Artifact];
        const detail = artifact?.approvalKind === PROFILE_ACCEPTED_KIND
          ? i18n.t("ui.artifactProfileAccepted")
          : i18n.t("ui.phaseDone");
        return { label, state: PROGRESS_DONE, detail };
      }
      if (index > currentIndex) return { label, state: PROGRESS_QUEUED };

      const rowState = s.status === AWAITING_APPROVAL_STATUS
        ? PROGRESS_WAITING
        : PROGRESS_ACTIVE;
      const detail = phase === IMPLEMENTATION_PHASE
        ? i18n.t("ui.taskProgress", {
            done: completedTaskCount,
            total: taskIds.length,
          })
        : statusLabel(s.status);
      return { label, state: rowState, detail };
    });

    const nextTask = s.phase === IMPLEMENTATION_PHASE
      ? taskIds.find((id) => !doneTasks.has(id))
      : undefined;
    return {
      name: activeSlug,
      profile: s.profile,
      status: i18n.t("ui.statusMachine", { status: parseStatusKey(s) }),
      rows,
      currentTask: nextTask
        ? i18n.t("ui.nextTask", { task: nextTask })
        : undefined,
    };
  }

  /** 更新 footer 和 Workflow 风格的常驻进度 Widget。 */
  function updateUi(
    ctx: ExtensionContext,
    snapshot = progressSnapshot(ctx),
  ): void {
    if (!activeSlug || !state || !snapshot) {
      ctx.ui.setStatus("spec-mode", undefined);
      ctx.ui.setWidget("spec-mode", undefined);
      return;
    }
    const s = state;
    const label = i18n.t("status.label", {
      spec: activeSlug,
      stage: stageLabel(s.phase),
      status: statusLabel(s.status),
    });
    ctx.ui.setStatus("spec-mode", ctx.ui.theme.fg("accent", label));

    if (ctx.mode === "tui") {
      ctx.ui.setWidget(
        "spec-mode",
        (_tui, theme) => ({
          // 每次 TUI 刷新时按实际可用宽度重新渲染进度框。
          render(width: number) {
            return renderSpecProgressLines(snapshot, theme, width);
          },
          // 组件不缓存主题化文本，因此失效时无需额外清理。
          invalidate(): void {},
        }),
        { placement: "aboveEditor" },
      );
      return;
    }
    ctx.ui.setWidget("spec-mode", renderSpecProgressText(snapshot), {
      placement: "aboveEditor",
    });
  }

  function checkStaleAndInvalidate(ctx: ExtensionContext): void {
    if (!activeSlug || !state) return;
    const s = state;
    let sha: Record<Artifact, string | null> = {
      requirements: null,
      design: null,
      tasks: null,
      verification: null,
    };
    for (const artifact of ["requirements", "design", "tasks"] as Artifact[]) {
      const path = artifactFileFor(ctx.cwd, activeSlug, artifact);
      if (existsSync(path) && s.artifacts[artifact].approvedSha256) {
        sha[artifact] = sha256File(path);
      }
    }
    const invalidated = invalidateIfStale(s, sha);
    if (invalidated) {
      state = invalidated;
      saveState({ cwd: ctx.cwd, slug: activeSlug, state });
      const artifact = state.phase as Artifact;
      ctx.ui.notify(
        i18n.t("errors.hashMismatch", {
          artifact: i18n.t(`status.widgetSteps.${artifact}` as never),
        }),
        "warning",
      );
      applyToolsForState(toolsBefore ?? pi.getActiveTools());
      updateUi(ctx);
      persistSession();
    }
  }

  // ── 命令 ────────────────────────────────────────────────────────────

  pi.registerCommand("spec", {
    description: i18n.t("commands.spec"),
    handler: async (args, ctx) => {
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
      switch (sub) {
        case "new":
          return await cmdNew(rest.join(" "), ctx);
        case "use":
          return await cmdUse(rest.join(" "), ctx);
        case "status":
          return await cmdStatus(ctx);
        case "approve":
          return await cmdApprove(ctx);
        case "revise":
          return await cmdRevise(rest.join(" "), ctx);
        case "continue":
          return await cmdContinue(ctx);
        case "stop":
          if (!activeSlug) {
            ctx.ui.notify(i18n.t("errors.notActiveNow"), "info");
            return;
          }
          exitMode(ctx);
          ctx.ui.notify(i18n.t("ui.stopped"), "info");
          return;
        default:
          ctx.ui.notify(
            `${i18n.t("commands.spec")}\n/spec new <slug> | use <slug> | status | approve | revise <a> | continue | stop`,
            "info",
          );
      }
    },
  });

  async function cmdNew(args: string, ctx: ExtensionContext): Promise<void> {
    const slugMatch = args.match(/^(\S+)/);
    const slugRaw = slugMatch?.[1] ?? "";
    const slug = parseSpecSlug(slugRaw);
    if (!slug) {
      ctx.ui.notify(i18n.t("errors.noSlug"), "error");
      return;
    }
    const dir = specDirFor(ctx.cwd, slug);
    if (existsSync(dir)) {
      ctx.ui.notify(i18n.t("errors.specExists", { slug }), "warning");
      return;
    }
    const titleMatch = args.match(/--title\s+"([^"]+)"|--title\s+(\S+)/);
    const title = titleMatch?.[1] ?? titleMatch?.[2] ?? slug;

    let profile: "strict" | "quick" = "strict";
    if (ctx.hasUI) {
      const strictOption = i18n.t("ui.profileStrict");
      const quickOption = i18n.t("ui.profileQuick");
      const choice = await ctx.ui.select(i18n.t("ui.profileTitle"), [
        strictOption,
        quickOption,
      ]);
      if (choice === quickOption) profile = "quick";
    }

    mkdirSync(dir, { recursive: true });
    const state_ = createState(slug, title, profile);
    saveState({ cwd: ctx.cwd, slug, state: state_ });
    writeFileSync(
      artifactFileFor(ctx.cwd, slug, "requirements"),
      i18n.t("template.requirements", { title }),
      "utf8",
    );
    writeFileSync(
      artifactFileFor(ctx.cwd, slug, "design"),
      i18n.t("template.design", { title }),
      "utf8",
    );
    writeFileSync(
      artifactFileFor(ctx.cwd, slug, "tasks"),
      i18n.t("template.tasks", { title }),
      "utf8",
    );
    writeFileSync(
      artifactFileFor(ctx.cwd, slug, VERIFICATION_PHASE),
      i18n.t("template.verification", { title }),
      "utf8",
    );
    enterMode(ctx, slug);
    ctx.ui.notify(i18n.t("ui.created", { slug, profile }), "info");
  }

  async function cmdUse(args: string, ctx: ExtensionContext): Promise<void> {
    const slug = parseSpecSlug(args);
    if (!slug) {
      ctx.ui.notify(i18n.t("errors.specMissing", { slug: args }), "error");
      return;
    }
    const dir = specDirFor(ctx.cwd, slug);
    if (!existsSync(dir)) {
      ctx.ui.notify(i18n.t("errors.specMissing", { slug }), "error");
      return;
    }
    try {
      enterMode(ctx, slug);
      ctx.ui.notify(i18n.t("ui.activated", { slug }), "info");
    } catch (err) {
      ctx.ui.notify(
        i18n.t("errors.stateCorrupt", {
          path: stateFileFor(ctx.cwd, slug),
          reason: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
    }
  }

  function cmdStatus(ctx: ExtensionContext): void {
    const snapshot = progressSnapshot(ctx);
    if (!snapshot) {
      ctx.ui.notify(i18n.t("errors.noActiveSpec"), "info");
      return;
    }
    updateUi(ctx, snapshot);
    ctx.ui.notify(renderSpecProgressText(snapshot).join("\n"), "info");
  }

  async function cmdApprove(ctx: ExtensionContext): Promise<void> {
    if (!activeSlug || !state) {
      ctx.ui.notify(i18n.t("errors.noActiveSpec"), "error");
      return;
    }
    if (state.status !== AWAITING_APPROVAL_STATUS) {
      ctx.ui.notify(
        i18n.t("errors.nothingToApprove", { status: parseStatusKey(state) }),
        "warning",
      );
      return;
    }
    const artifact = state.phase as Artifact;
    const path = artifactFileFor(ctx.cwd, activeSlug, artifact);
    if (!existsSync(path) || sha256File(path) !== state.artifacts[artifact].sha256) {
      const reopened = transition(state, { type: "revise", artifact });
      if (reopened.ok) {
        state = reopened.state;
        saveState({ cwd: ctx.cwd, slug: activeSlug, state });
        applyToolsForState(toolsBefore ?? pi.getActiveTools());
        updateUi(ctx);
        persistSession();
      }
      ctx.ui.notify(
        i18n.t("errors.hashMismatch", {
          artifact: stageLabel(artifact),
        }),
        "warning",
      );
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(i18n.t("approve.headlessHint"), "warning");
      return;
    }
    const ok = await ctx.ui.confirm(
      i18n.t("approve.confirmTitle", { stage: stageLabel(state.phase) }),
      i18n.t("approve.confirmBody", { path }),
    );
    if (!ok) return;

    const approvedPhase = state.phase;
    const result = transition(state, { type: "approve" });
    if (!result.ok) {
      ctx.ui.notify(
        i18n.t("errors.illegalTransition", {
          from: parseStatusKey(state),
          to: "approve",
          reason: result.error,
        }),
        "error",
      );
      return;
    }
    state = result.state;
    saveState({ cwd: ctx.cwd, slug: activeSlug, state });
    applyToolsForState(toolsBefore ?? pi.getActiveTools());
    updateUi(ctx);
    persistSession();
    ctx.ui.notify(
      i18n.t("approve.approved", {
        stage: stageLabel(approvedPhase),
        next: stageLabel(state.phase),
      }),
      "info",
    );
  }

  function cmdRevise(args: string, ctx: ExtensionContext): void {
    if (!activeSlug || !state) {
      ctx.ui.notify(i18n.t("errors.noActiveSpec"), "error");
      return;
    }
    const artifact = args.trim() as Artifact;
    if (!["requirements", "design", "tasks", VERIFICATION_PHASE].includes(artifact)) {
      ctx.ui.notify(i18n.t("errors.reviseInvalidArtifact", { artifact: args }), "error");
      return;
    }
    const result = transition(state, { type: "revise", artifact });
    if (!result.ok) {
      ctx.ui.notify(
        i18n.t("errors.illegalTransition", {
          from: parseStatusKey(state),
          to: "revise",
          reason: result.error,
        }),
        "error",
      );
      return;
    }
    state = result.state;
    saveState({ cwd: ctx.cwd, slug: activeSlug, state });
    applyToolsForState(toolsBefore ?? pi.getActiveTools());
    updateUi(ctx);
    persistSession();
    ctx.ui.notify(i18n.t("approve.revised", { artifact }), "info");
  }

  async function cmdContinue(ctx: ExtensionContext): Promise<void> {
    if (!activeSlug || !state) {
      ctx.ui.notify(i18n.t("errors.noActiveSpec"), "error");
      return;
    }
    if (state.phase !== IMPLEMENTATION_PHASE || state.status !== "in_progress") {
      ctx.ui.notify(
        i18n.t("errors.notApprovedForExecute", { status: parseStatusKey(state) }),
        "warning",
      );
      return;
    }
    pi.sendUserMessage(i18n.t("ui.continueExecution"), {
      deliverAs: "followUp",
    });
  }

  // ── spec_submit 工具 ────────────────────────────────────────────────

  pi.registerTool({
    name: "spec_submit",
    label: "Submit Spec",
    description: i18n.t("submit.description"),
    promptSnippet: i18n.t("submit.snippet"),
    promptGuidelines: [i18n.t("submit.guidelines")],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!activeSlug || !state) {
        return {
          content: [
            {
              type: "text",
              text: i18n.t("errors.submitNoActive"),
            },
          ],
          details: { submitted: false },
        };
      }
      const artifact = state.phase as Artifact;
      if (state.status !== "drafting") {
        return {
          content: [
            {
              type: "text",
              text: i18n.t("errors.submitNotDrafting", {
                status: parseStatusKey(state),
              }),
            },
          ],
          details: { submitted: false },
        };
      }
      const path = artifactFileFor(ctx.cwd, activeSlug, artifact);
      if (!existsSync(path)) {
        return {
          content: [
            {
              type: "text",
              text: i18n.t("errors.artifactMissing", { path }),
            },
          ],
          details: { submitted: false },
        };
      }
      const md = readFileSync(path, "utf8");
      const reqMd =
        artifact === "requirements"
          ? md
          : artifactFileFor(ctx.cwd, activeSlug, "requirements")
            ? readFileSync(
                artifactFileFor(ctx.cwd, activeSlug, "requirements"),
                "utf8",
              )
            : "";
      const validation = validateArtifact(artifact, md, reqMd);

      if (validation.errors.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: i18n.t("errors.validationRejected", {
                errors: validation.errors.map((e) => `- ${e}`).join("\n"),
              }),
            },
          ],
          details: { submitted: false, errors: validation.errors },
        };
      }

      const sha256 = sha256File(path);
      const result = transition(state, { type: "submit", sha256 });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: i18n.t("errors.submitTransition", {
                status: parseStatusKey(state),
                reason: result.error,
              }),
            },
          ],
          details: { submitted: false },
        };
      }
      state = result.state;
      saveState({ cwd: ctx.cwd, slug: activeSlug, state });
      applyToolsForState(toolsBefore ?? pi.getActiveTools());
      updateUi(ctx);
      persistSession();

      const warningText =
        validation.warnings.length > 0
          ? `\n\n${i18n.t("submit.warningHeader")}:\n${validation.warnings.map((w) => `- ${w}`).join("\n")}`
          : "";
      const nextHint =
        state.status === AWAITING_APPROVAL_STATUS
          ? i18n.t("submit.awaiting")
          : i18n.t("submit.advanced", {
              stage: stageLabel(state.phase),
            });
      return {
        content: [
          {
            type: "text",
            text: i18n.t("submit.success", {
              artifact,
              status: parseStatusKey(state),
              warnings: warningText,
              next: nextHint,
            }),
          },
        ],
        details: { submitted: true, warnings: validation.warnings },
      };
    },
  });

  // ── 工具守卫 ────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (!activeSlug || !state) return;

    if (event.toolName === "bash") {
      if (state.phase !== IMPLEMENTATION_PHASE && state.phase !== VERIFICATION_PHASE) {
        return {
          block: true,
          reason: i18n.t("guards.bashBlocked", {
            stage: parseStatusKey(state),
          }),
        };
      }
      return;
    }

    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const inputPath = String((event.input as { path?: string })?.path ?? "");
    const abs = resolve(ctx.cwd, inputPath);

    if (isStateFile(abs) && isUnderSpecsRoot(ctx.cwd, abs)) {
      return { block: true, reason: i18n.t("guards.stateProtected") };
    }

    // 实现阶段放行源码写入，但所有规格目录仍受保护；只允许更新当前 tasks.md。
    if (state.phase === IMPLEMENTATION_PHASE) {
      if (!isUnderSpecsRoot(ctx.cwd, abs)) return;
      const tasksPath = artifactFileFor(ctx.cwd, activeSlug, "tasks");
      if (sameResolvedPath(tasksPath, abs)) return;
      return {
        block: true,
        reason: i18n.t("guards.specDirProtected", { path: abs }),
      };
    }

    const allowed = allowedArtifactForPhase(state, ctx.cwd);
    if (allowed && sameResolvedPath(allowed.file, abs)) return;

    return {
      block: true,
      reason: i18n.t("guards.writeDenied", {
        allowed: allowed?.file ?? NO_ALLOWED_FILE,
        path: abs,
      }),
    };
  });

  // ── 阶段上下文注入 ─────────────────────────────────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!activeSlug || !state) return;
    checkStaleAndInvalidate(ctx);
    if (!activeSlug || !state) return;

    if (state.phase === IMPLEMENTATION_PHASE) {
      const entries = ctx.sessionManager.getBranch() as EntryLike[];
      const done = doneTagsInMessages(entries);
      for (const taskId of state.completedTasks ?? []) done.add(taskId);
      const total = taskIdsFromTasksMd(ctx.cwd, activeSlug);
      const remaining = total.filter((id) => !done.has(id));
      if (remaining.length === 0) return;
      return {
        message: {
          customType: "spec-mode-context",
          content: i18n.t("context.execute", {
            remaining: remaining.map((r) => `- ${r}`).join("\n"),
          }),
          display: false,
        },
      };
    }

    if (state.phase === VERIFICATION_PHASE) {
      return {
        message: {
          customType: "spec-mode-context",
          content: i18n.t("context.verify"),
          display: false,
        },
      };
    }

    const artifact = state.phase as Artifact;
    const path = artifactFileFor(ctx.cwd, activeSlug, artifact);
    return {
      message: {
        customType: "spec-mode-context",
        content: i18n.t("context.planStage", {
          stage: stageLabel(state.phase),
          status: statusLabel(state.status),
          path,
        }),
        display: false,
      },
    };
  });

  // ── 任务完成跟踪 ───────────────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    if (!activeSlug || !state) return;
    if (state.phase !== IMPLEMENTATION_PHASE || state.status !== "in_progress") return;
    if (!isAssistantMessage(event.message)) return;

    const text = assistantText(event.message);
    const tags = [...text.matchAll(/\[DONE:(TASK-[A-Za-z0-9_-]+)\]/g)].map((m) => m[1]);
    if (tags.length === 0) return;

    const total = taskIdsFromTasksMd(ctx.cwd, activeSlug);
    const totalSet = new Set(total);
    const expectedRevision = state.revision;
    let updated = false;
    for (const tag of tags) {
      if (!totalSet.has(tag)) continue;
      const result = transition(state, { type: "task_done", taskId: tag });
      if (!result.ok) continue;
      state = result.state;
      updated = true;
    }
    if (!updated) return;
    saveState({ cwd: ctx.cwd, slug: activeSlug, state, expectedRevision });

    const entries = ctx.sessionManager.getBranch() as EntryLike[];
    const done = doneTagsInMessages(entries);
    for (const taskId of state.completedTasks) done.add(taskId);
    for (const taskId of tags) done.add(taskId);
    const remaining = total.filter((id) => !done.has(id));
    updateUi(ctx);
    persistSession();

    if (remaining.length === 0 && total.length > 0) {
      const result = transition(state, { type: "all_tasks_done" });
      if (result.ok) {
        state = result.state;
        saveState({ cwd: ctx.cwd, slug: activeSlug, state });
        applyToolsForState(toolsBefore ?? pi.getActiveTools());
        updateUi(ctx);
        persistSession();
        ctx.ui.notify(
          i18n.t("ui.allTasksDone", { total: total.length }),
          "info",
        );
      }
    }
  });

  // ── 会话恢复 ────────────────────────────────────────────────────────

  function restoreSession(ctx: ExtensionContext): void {
    const persist = ctx.sessionManager
      .getBranch()
      .filter(
        (e) => e.type === "custom" && e.customType === PERSIST_KEY,
      )
      .pop() as { data?: SessionPersist } | undefined;

    const slug = persist?.data?.activeSlug ?? null;
    if (!slug) {
      if (activeSlug && toolsBefore) pi.setActiveTools(toolsBefore);
      activeSlug = null;
      state = null;
      toolsBefore = null;
      ctx.ui.setStatus("spec-mode", undefined);
      ctx.ui.setWidget("spec-mode", undefined);
      return;
    }
    toolsBefore = persist?.data?.toolsBefore ?? toolsBefore;

    const dir = specDirFor(ctx.cwd, slug);
    if (!existsSync(dir)) return;

    try {
      state = loadState(ctx.cwd, slug);
    } catch (err) {
      ctx.ui.notify(
        i18n.t("errors.stateCorrupt", {
          path: stateFileFor(ctx.cwd, slug),
          reason: err instanceof Error ? err.message : String(err),
        }),
        "error",
      );
      return;
    }
    activeSlug = slug;

    if (
      persist?.data?.lastRevision !== null &&
      persist?.data?.lastRevision !== undefined &&
      persist.data.lastRevision !== state.revision
    ) {
      ctx.ui.notify(
        i18n.t("ui.diskRevisionChanged", {
          from: persist.data.lastRevision,
          to: state.revision,
        }),
        "warning",
      );
    }
    applyToolsForState(toolsBefore ?? pi.getActiveTools());
    updateUi(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreSession(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreSession(ctx);
  });
}
