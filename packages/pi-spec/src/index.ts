/**
 * pi-spec — 终端内规格驱动开发工作流扩展
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
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";
import { listSpecs, loadState, saveState, type SpecSummary } from "./storage.ts";
import {
  argumentValue,
  availableActions,
  completionValue,
  isArgumentAction,
  nextPhase,
  requiresPrepare,
  revisableArtifacts,
  type SpecAction,
} from "./actions.ts";
import { i18n } from "./i18n.ts";
import { loadProcedure, reconcileContext } from "./context.ts";
import { validateArtifact } from "./artifacts.ts";
import {
  documentDigest,
  frontmatterFor,
  frontmatterUpToDate,
  stripFrontmatter,
  withFrontmatter,
} from "./frontmatter.ts";
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
  ARTIFACTS,
  createState,
  invalidateIfStale,
  parseStatusKey,
  transition,
  type Artifact,
  type StateFile,
} from "./state.ts";

const PERSIST_KEY = "spec-mode";
const APPROVAL_REQUEST_TOOL = "spec_request_approval";
/** 本扩展自己注册的工具：只能由本扩展按当前状态增删。 */
const SPEC_OWNED_TOOLS = new Set(["spec_submit", APPROVAL_REQUEST_TOOL]);
const IMPLEMENTATION_PHASE = "implementation" as const;
const VERIFICATION_PHASE = "verification" as const;
const TASKS_ARTIFACT = "tasks" as const;
const COMPLETE_PHASE = "complete" as const;
const PROGRESS_PHASES = [
  "requirements",
  "design",
  "tasks",
  IMPLEMENTATION_PHASE,
  VERIFICATION_PHASE,
] as const;
const NO_ALLOWED_FILE = "none";
const DRAFTING_STATUS = "drafting" as const;
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

/** frontmatter 派生同步结果：重写过的文档与写失败的文档分别记录。 */
interface FrontmatterSyncResult {
  rewritten: Artifact[];
  failed: Array<{ artifact: Artifact; reason: string }>;
}

/** 文档指纹只覆盖 frontmatter 之后的正文；派生显示层变化不影响批准。 */
function sha256File(path: string): string {
  return documentDigest(readFileSync(path));
}

/** 本地最小消息类型（避免直接依赖 pi-ai / pi-agent-core 模块解析） */
interface AssistantMessageLike {
  role: "assistant";
  content: Array<{ type: string; text?: string }>;
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

function taskIdsFromTasksMd(cwd: string, slug: string): string[] {
  const path = artifactFileFor(cwd, slug, "tasks");
  if (!existsSync(path)) return [];
  const text = stripFrontmatter(readFileSync(path, "utf8"));
  const ids: string[] = [];
  const re = /^#{2,4}\s+(TASK-[A-Za-z0-9_-]+)\b/gm;
  for (const m of text.matchAll(re)) ids.push(m[1]);
  return ids;
}

export default function (pi: ExtensionAPI): void {
  let activeSlug: string | null = null;
  let state: StateFile | null = null;
  let toolsBefore: string[] | null = null;
  let activationEpoch = 0;
  /** 补全回调没有 ctx，只能记住最近一次事件的项目目录。 */
  let lastCwd: string | null = null;
  let executionRun: { slug: string; revision: number; epoch: number } | null = null;
  let blockedReason: string | null = null;
  let removedTools = new Set<string>();
  let addedTools = new Set<string>();

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

  /**
   * 把 state.json 的派生视图同步进四份文档：缺失的文档不新建，已一致的不重写。
   * 进度只属于 tasks.md，且尚未写任务时不写进度（0/0 是无意义噪声）。
   * 写失败逐条记录并上报，避免正文与状态悄悄分叉。
   */
  function syncFrontmatter(
    cwd: string,
    slug: string,
    current: StateFile,
  ): FrontmatterSyncResult {
    const taskIds = taskIdsFromTasksMd(cwd, slug);
    const done = new Set(current.completedTasks);
    const result: FrontmatterSyncResult = { rewritten: [], failed: [] };
    for (const artifact of ARTIFACTS) {
      const path = artifactFileFor(cwd, slug, artifact);
      if (!existsSync(path)) continue;
      const fields = frontmatterFor({
        state: current,
        artifact,
        taskProgress: artifact === TASKS_ARTIFACT && taskIds.length > 0
          ? { done: taskIds.filter((id) => done.has(id)).length, total: taskIds.length }
          : null,
        notice: i18n.t("frontmatter.notice"),
      });
      const text = readFileSync(path, "utf8");
      if (frontmatterUpToDate(text, fields)) continue;
      try {
        writeFileSync(path, withFrontmatter(text, fields), "utf8");
        result.rewritten.push(artifact);
      } catch (error) {
        result.failed.push({
          artifact,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /** 同步失败必须可见；缺文档属于正常状态，由各流程按需报告。 */
  function reportFrontmatterIssues(
    ctx: ExtensionContext,
    result: FrontmatterSyncResult,
  ): void {
    if (result.failed.length === 0) return;
    ctx.ui.notify(
      i18n.t("errors.frontmatterSyncFailed", {
        files: result.failed
          .map(({ artifact, reason }) => `${artifact}.md: ${reason}`)
          .join("; "),
      }),
      "warning",
    );
  }

  /**
   * 激活/恢复时校准派生显示层：旧规格补写 frontmatter、手工改动回正，
   * 一律以 state.json 为准；这就是「两份不一致时以状态为准」的落地入口。
   */
  function repairFrontmatter(
    ctx: ExtensionContext,
    slug: string,
    current: StateFile,
  ): void {
    const result = syncFrontmatter(ctx.cwd, slug, current);
    if (result.rewritten.length > 0) {
      ctx.ui.notify(
        i18n.t("ui.frontmatterRepaired", {
          files: result.rewritten.map((artifact) => `${artifact}.md`).join(", "),
        }),
        "info",
      );
    }
    reportFrontmatterIssues(ctx, result);
  }

  /**
   * 状态落盘的唯一入口：先写 state.json，再刷新派生显示层，最后同步 UI 与会话快照。
   * frontmatter 只是显示层，写失败不影响状态与授权（下次同步会补齐）。
   */
  function commitState(
    ctx: ExtensionContext,
    next: StateFile,
    expectedRevision?: number,
  ): void {
    if (!activeSlug) throw new Error(i18n.t("errors.noActiveSpec"));
    saveState({ cwd: ctx.cwd, slug: activeSlug, state: next, expectedRevision });
    state = next;
    reportFrontmatterIssues(ctx, syncFrontmatter(ctx.cwd, activeSlug, next));
    applyToolsForState();
    updateUi(ctx);
    persistSession();
  }

  /** 仅撤销本扩展上次的工具差量，保留其他扩展可观察到的增删。 */
  function unrestrictedTools(): string[] {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const current = pi.getActiveTools().filter((tool) => !addedTools.has(tool));
    return [...new Set([...current, ...removedTools])]
      .filter((tool) => tool !== "spec_submit" && registered.has(tool));
  }

  /** 每次基于当前工具计算差量，不恢复整份历史快照。 */
  function applyToolsForState(): void {
    const base = unrestrictedTools();
    toolsBefore = base;
    let next = base;
    if (state) {
      next = state.phase === IMPLEMENTATION_PHASE || state.phase === COMPLETE_PHASE
        ? executeTools(base)
        : state.phase === VERIFICATION_PHASE ? verificationTools(base) : phaseTools(base);
      // 每个自有工具只在对应用途下暴露
      if (state.status !== DRAFTING_STATUS) next = next.filter((tool) => tool !== "spec_submit");
      if (state.status === AWAITING_APPROVAL_STATUS) next = [...next, APPROVAL_REQUEST_TOOL];
    }
    if (blockedReason) next = [];
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    next = next.filter((tool) => registered.has(tool) && (SPEC_OWNED_TOOLS.has(tool) || base.includes(tool)));
    removedTools = new Set(base.filter((tool) => !next.includes(tool)));
    addedTools = new Set(next.filter((tool) => !base.includes(tool)));
    pi.setActiveTools(next);
  }

  /** 恢复失败不沿用旧业务状态，也不静默退回普通执行模式。 */
  function blockMode(ctx: ExtensionContext, reason: string): void {
    activationEpoch += 1;
    activeSlug = null;
    state = null;
    blockedReason = i18n.t("errors.restoreBlocked", { reason });
    applyToolsForState();
    ctx.ui.setStatus("spec-mode", blockedReason);
    ctx.ui.setWidget("spec-mode", [blockedReason]);
    ctx.ui.notify(blockedReason, "error");
  }

  function enterMode(ctx: ExtensionContext, slug: string): void {
    const candidate = loadState(ctx.cwd, slug);
    activationEpoch += 1;
    activeSlug = slug;
    state = candidate;
    blockedReason = null;
    repairFrontmatter(ctx, slug, candidate);
    prepareOperation(ctx);
    applyToolsForState();
    updateUi(ctx);
    persistSession();
  }

  function exitMode(ctx: ExtensionContext, persist = true): void {
    activationEpoch += 1;
    activeSlug = null;
    state = null;
    blockedReason = null;
    applyToolsForState();
    toolsBefore = null;
    ctx.ui.setStatus("spec-mode", undefined);
    ctx.ui.setWidget("spec-mode", undefined);
    if (persist) persistSession();
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
    const doneTasks = new Set(s.completedTasks);
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

  function checkStaleAndInvalidate(ctx: ExtensionContext): boolean {
    if (!activeSlug || !state) return false;
    const s = state;
    let sha: Record<Artifact, string | null> = {
      requirements: null,
      design: null,
      tasks: null,
      verification: null,
    };
    for (const artifact of ["requirements", "design", "tasks", "verification"] as Artifact[]) {
      const path = artifactFileFor(ctx.cwd, activeSlug, artifact);
      if (existsSync(path) && s.artifacts[artifact].approvedSha256) {
        sha[artifact] = sha256File(path);
      }
    }
    const invalidated = invalidateIfStale(s, sha);
    if (invalidated) {
      commitState(ctx, invalidated);
      const artifact = invalidated.phase as Artifact;
      ctx.ui.notify(
        i18n.t("errors.hashMismatch", {
          artifact: i18n.t(`status.widgetSteps.${artifact}` as never),
        }),
        "warning",
      );
      return true;
    }
    return false;
  }

  /** 关键操作先读取磁盘并检查指纹；漂移时只更新状态，不执行原操作。 */
  function prepareOperation(ctx: ExtensionContext): boolean {
    lastCwd = ctx.cwd;
    if (blockedReason) throw new Error(blockedReason);
    if (!activeSlug || !state) return true;
    const previousRevision = state.revision;
    try {
      refreshState(ctx);
    } catch (error) {
      blockMode(ctx, String(error));
      throw error;
    }
    if (checkStaleAndInvalidate(ctx)) return false;
    if (state.status === AWAITING_APPROVAL_STATUS) {
      const artifact = state.phase as Artifact;
      const path = artifactFileFor(ctx.cwd, activeSlug, artifact);
      if (!existsSync(path) || sha256File(path) !== state.artifacts[artifact].sha256) {
        const result = transition(state, { type: "revise", artifact });
        if (!result.ok) throw new Error(result.error);
        commitState(ctx, result.state);
        ctx.ui.notify(i18n.t("errors.hashMismatch", { artifact: stageLabel(artifact) }), "warning");
        return false;
      }
    }
    if (state.revision !== previousRevision) {
      applyToolsForState();
      updateUi(ctx);
      persistSession();
      ctx.ui.notify(i18n.t("ui.diskRevisionChanged", { from: previousRevision, to: state.revision }), "warning");
      return false;
    }
    return true;
  }

  // ── 命令 ────────────────────────────────────────────────────────────

  // ── 动作菜单与补全 ───────────────────────────────────────────

  /** 当前状态下合法的动作；规格清单不可读时按没有规格处理。 */
  function currentActions(): SpecAction[] {
    return availableActions({
      blocked: blockedReason !== null,
      active: state && activeSlug ? { phase: state.phase, status: state.status } : null,
      hasSpecs: lastCwd !== null && listSpecs(lastCwd).length > 0,
    });
  }

  /** 动作在菜单与补全里的名称；approve 带上当前阶段和下一阶段。 */
  function actionLabel(action: SpecAction): string {
    const params: Record<string, string> = {};
    if (state) {
      params.stage = stageLabel(state.phase);
      params.next = stageLabel(nextPhase(state.phase) ?? state.phase);
    }
    return i18n.t(`actions.${action.kind}.label` as never, params);
  }

  /** 动作在菜单与补全里的一句话说明。 */
  function actionDescription(action: SpecAction): string {
    return i18n.t(`actions.${action.kind}.description` as never);
  }

  /** 规格在菜单和补全里的显示文本；损坏条目显示原因而不是隐藏。 */
  function specLabel(summary: SpecSummary): string {
    if (summary.error !== null) {
      return `${summary.slug} · ${i18n.t("menu.specUnreadable", { reason: summary.error })}`;
    }
    return `${summary.slug} · ${summary.title} · ${i18n.t("menu.specSummary", {
      stage: stageLabel(summary.phase),
      status: statusLabel(summary.status),
    })}`;
  }

  /** 二级补全：磁盘上的规格名，损坏条目也列出并给出原因。 */
  function completeSpecNames(partial: string): AutocompleteItem[] | null {
    if (!lastCwd) return null;
    const matches = listSpecs(lastCwd).filter((summary) => summary.slug.startsWith(partial));
    if (matches.length === 0) return null;
    return matches.map((summary) => ({
      value: argumentValue("use", summary.slug),
      label: summary.slug,
      description: summary.error !== null
        ? i18n.t("menu.specUnreadable", { reason: summary.error })
        : summary.title,
    }));
  }

  /** 二级补全：已开始、因而可以回退重开的阶段。 */
  function completeStageNames(partial: string): AutocompleteItem[] | null {
    if (!state) return null;
    const matches = revisableArtifacts(state.phase)
      .filter((artifact) => artifact.startsWith(partial));
    if (matches.length === 0) return null;
    return matches.map((artifact) => ({
      value: argumentValue("revise", artifact),
      label: artifact,
      description: stageLabel(artifact),
    }));
  }

  /**
   * /spec 的参数补全。prefix 是命令名之后的完整参数串：
   * 无空格时给一级动作，有空格时按动作给二级参数（规格名或阶段名）。
   */
  function completeSpecArguments(prefix: string): AutocompleteItem[] | null {
    if (!prefix.includes(" ")) {
      const matches = currentActions().filter((action) => action.args.startsWith(prefix));
      if (matches.length === 0) return null;
      return matches.map((action) => ({
        value: completionValue(action.kind),
        label: actionLabel(action),
        description: actionDescription(action),
      }));
    }

    const separator = prefix.indexOf(" ");
    const kind = prefix.slice(0, separator);
    const partial = prefix.slice(separator + 1).trim();
    if (!isArgumentAction(kind)) return null;
    return kind === "use" ? completeSpecNames(partial) : completeStageNames(partial);
  }

  pi.registerCommand("spec", {
    description: i18n.t("commands.spec"),
    getArgumentCompletions: completeSpecArguments,
    handler: async (args, ctx) => {
      lastCwd = ctx.cwd;
      const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
      try {
        // 无参数：打开当前状态的动作菜单，不让用户记忆参数
        if (!sub) return await cmdMenu(ctx);
        if (requiresPrepare(sub) && !prepareOperation(ctx)) return;
        switch (sub) {
          case "new":
            return await cmdNew(rest.join(" "), ctx);
          case "use":
            return await cmdUse(rest.join(" "), ctx);
          case "status":
            return await cmdStatus(ctx);
          case "approve":
            // 批准结果已由 performApproval 自己通知，此处不需要返回值
            await performApproval(ctx);
            return;
          case "revise":
            return await cmdRevise(rest.join(" "), ctx);
          case "continue":
            return await cmdContinue(ctx);
          case "stop":
            return cmdStop(ctx);
          default:
            ctx.ui.notify(i18n.t("errors.unknownSubcommand", { sub }), "warning");
            return await cmdMenu(ctx);
        }
      } catch (error) {
        ctx.ui.notify(i18n.t("errors.operationFailed", { reason: String(error) }), "error");
      }
    },
  });

  /** 无参数入口与未知子命令的入口：按当前状态给出可选动作。 */
  async function cmdMenu(ctx: ExtensionContext): Promise<void> {
    const actions = currentActions();
    const lines = actions.map((action) => `  /spec ${action.args.padEnd(10)} ${actionDescription(action)}`);
    if (!ctx.hasUI) {
      ctx.ui.notify([i18n.t("menu.usageHeader"), ...lines].join("\n"), "info");
      return;
    }
    const title = blockedReason !== null
      ? i18n.t("menu.titleBlocked")
      : activeSlug && state
        ? i18n.t("menu.title", {
            slug: activeSlug,
            stage: stageLabel(state.phase),
            status: statusLabel(state.status),
          })
        : i18n.t("menu.titleInactive");
    const choices = actions.map(actionLabel);
    const selected = await ctx.ui.select(title, choices);
    if (selected === undefined) {
      ctx.ui.notify(i18n.t("menu.cancelled"), "info");
      return;
    }
    const index = choices.indexOf(selected);
    if (index < 0) return;
    await runAction(actions[index], ctx);
  }

  /**
   * 菜单选中后执行动作，与快捷子命令共用同一套实现。
   * 需要前置校验的动作先核对磁盘状态，漂移时不执行原动作。
   */
  async function runAction(action: SpecAction, ctx: ExtensionContext): Promise<void> {
    if (requiresPrepare(action.kind) && !prepareOperation(ctx)) return;
    switch (action.kind) {
      case "new":
        return await cmdNew("", ctx);
      case "use":
        return await cmdUse("", ctx);
      case "status":
        return cmdStatus(ctx);
      case "approve":
        await performApproval(ctx);
        return;
      case "revise":
        return await cmdRevise("", ctx);
      case "continue":
        return await cmdContinue(ctx);
      case "stop":
        return cmdStop(ctx);
      default:
        // 新增动作却忘了分支时明确报错，不静默无操作
        throw new Error(`Unhandled spec action: ${String(action.kind satisfies never)}`);
    }
  }

  /** 退出规格模式；未激活时只说明状态，不假装执行过。 */
  function cmdStop(ctx: ExtensionContext): void {
    if (!activeSlug && !blockedReason) {
      ctx.ui.notify(i18n.t("errors.notActiveNow"), "info");
      return;
    }
    exitMode(ctx);
    ctx.ui.notify(i18n.t("ui.stopped"), "info");
  }

  /**
   * 创建规格：名称可用位置参数给出，缺失时提示输入；标题默认取名称，
   * 输入框预填名称所以回车即可接受。旧的 --title 仍被接受，但不再出现在帮助里。
   */
  async function cmdNew(args: string, ctx: ExtensionContext): Promise<void> {
    let slugRaw = args.match(/^(\S+)/)?.[1] ?? "";
    if (!slugRaw) {
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("errors.noSlug"), "error");
        return;
      }
      const entered = await ctx.ui.input(i18n.t("new.slugPrompt"), i18n.t("new.slugPlaceholder"));
      slugRaw = (entered ?? "").trim();
      if (!slugRaw) {
        ctx.ui.notify(i18n.t("menu.cancelled"), "info");
        return;
      }
    }
    const slug = parseSpecSlug(slugRaw);
    if (!slug) {
      ctx.ui.notify(i18n.t("errors.slugInvalid", { slug: slugRaw }), "error");
      return;
    }
    const dir = specDirFor(ctx.cwd, slug);
    if (existsSync(dir)) {
      ctx.ui.notify(i18n.t("errors.specExists", { slug }), "warning");
      return;
    }
    const scriptedTitle = args.match(/--title\s+"([^"]+)"|--title\s+(\S+)/);
    let title = scriptedTitle?.[1] ?? scriptedTitle?.[2] ?? slug;
    if (!scriptedTitle && ctx.hasUI) {
      const entered = await ctx.ui.input(i18n.t("new.titlePrompt"), slug);
      if (entered === undefined) {
        ctx.ui.notify(i18n.t("menu.cancelled"), "info");
        return;
      }
      if (entered.trim()) title = entered.trim();
    }

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
    // 先写模板，再复用同一套派生逻辑补上文档头：创建与后续同步不会产生两套格式
    for (const artifact of ARTIFACTS) {
      writeFileSync(
        artifactFileFor(ctx.cwd, slug, artifact),
        i18n.t(`template.${artifact}` as never, { title }),
        "utf8",
      );
    }
    reportFrontmatterIssues(ctx, syncFrontmatter(ctx.cwd, slug, state_));
    enterMode(ctx, slug);
    ctx.ui.notify(i18n.t("ui.created", { slug, profile }), "info");
  }

  /** 激活规格：给出名称直接激活，否则列出磁盘上的规格供选择。 */
  async function cmdUse(args: string, ctx: ExtensionContext): Promise<void> {
    const requested = args.trim();
    if (!requested) {
      const specs = listSpecs(ctx.cwd);
      if (specs.length === 0) {
        ctx.ui.notify(i18n.t("errors.noSpecsFound"), "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("errors.useNeedsSlug"), "warning");
        return;
      }
      const choices = specs.map(specLabel);
      const selected = await ctx.ui.select(i18n.t("menu.pickSpec"), choices);
      if (selected === undefined) {
        ctx.ui.notify(i18n.t("menu.cancelled"), "info");
        return;
      }
      const index = choices.indexOf(selected);
      if (index < 0) return;
      return await cmdUse(specs[index].slug, ctx);
    }
    const slug = parseSpecSlug(requested);
    if (!slug) {
      ctx.ui.notify(i18n.t("errors.specMissing", { slug: requested }), "error");
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
      blockMode(ctx, String(err));
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

  /** 批准结果：detail 是可直接展示给用户和模型的结果说明。 */
  interface ApprovalOutcome {
    approved: boolean;
    detail: string;
  }

  /**
   * 唯一的批准实现：/spec approve、菜单和 spec_request_approval 工具共用。
   * 对话框返回后重新核对规格身份、revision 与文档指纹；未落盘不产生批准。
   * 用户不按键、无可批文档或无 UI 时一律不批准，也不虚报成功。
   */
  async function performApproval(ctx: ExtensionContext): Promise<ApprovalOutcome> {
    if (!activeSlug || !state) {
      const detail = i18n.t("errors.noActiveSpec");
      ctx.ui.notify(detail, "error");
      return { approved: false, detail };
    }
    if (state.status !== AWAITING_APPROVAL_STATUS) {
      const detail = i18n.t("errors.nothingToApprove", { status: parseStatusKey(state) });
      ctx.ui.notify(detail, "warning");
      return { approved: false, detail };
    }
    const artifact = state.phase as Artifact;
    const path = artifactFileFor(ctx.cwd, activeSlug, artifact);
    if (!ctx.hasUI) {
      const detail = i18n.t("approve.headlessHint");
      ctx.ui.notify(detail, "warning");
      return { approved: false, detail };
    }
    const confirmation = { slug: activeSlug, phase: state.phase, revision: state.revision, sha256: state.artifacts[artifact].sha256, epoch: activationEpoch };
    const ok = await ctx.ui.confirm(
      i18n.t("approve.confirmTitle", { stage: stageLabel(state.phase) }),
      i18n.t("approve.confirmBody", { path }),
    );
    if (!ok) {
      const detail = i18n.t("approve.cancelled");
      ctx.ui.notify(detail, "warning");
      return { approved: false, detail };
    }
    if (activeSlug !== confirmation.slug || activationEpoch !== confirmation.epoch) {
      const detail = i18n.t("errors.confirmationChanged");
      ctx.ui.notify(detail, "warning");
      return { approved: false, detail };
    }
    if (!prepareOperation(ctx)) {
      return { approved: false, detail: i18n.t("errors.confirmationChanged") };
    }
    if (!state || state.phase !== confirmation.phase || state.revision !== confirmation.revision ||
        state.status !== AWAITING_APPROVAL_STATUS || state.artifacts[artifact].sha256 !== confirmation.sha256) {
      const detail = i18n.t("errors.confirmationChanged");
      ctx.ui.notify(detail, "warning");
      return { approved: false, detail };
    }

    const approvedPhase = state.phase;
    const result = transition(state, { type: "approve" });
    if (!result.ok) {
      const detail = i18n.t("errors.illegalTransition", {
        from: parseStatusKey(state),
        to: "approve",
        reason: result.error,
      });
      ctx.ui.notify(detail, "error");
      return { approved: false, detail };
    }
    commitState(ctx, result.state);
    const detail = i18n.t("approve.approved", {
      stage: stageLabel(approvedPhase),
      next: stageLabel(state.phase),
    });
    ctx.ui.notify(detail, "info");
    return { approved: true, detail };
  }
  /** 回退阶段：给出阶段名直接回退，否则列出已开始、可回退的阶段供选择。 */
  async function cmdRevise(args: string, ctx: ExtensionContext): Promise<void> {
    if (!activeSlug || !state) {
      ctx.ui.notify(i18n.t("errors.noActiveSpec"), "error");
      return;
    }
    let artifact = args.trim() as Artifact;
    if (!artifact) {
      const candidates = revisableArtifacts(state.phase);
      if (candidates.length === 0) {
        // 阶段合法时至少能回退 requirements；绝不向用户展示空列表
        ctx.ui.notify(i18n.t("errors.reviseNeedsStage"), "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("errors.reviseNeedsStage"), "warning");
        return;
      }
      const choices = candidates.map((candidate) => stageLabel(candidate));
      const selected = await ctx.ui.select(i18n.t("menu.pickStage"), choices);
      if (selected === undefined) {
        ctx.ui.notify(i18n.t("menu.cancelled"), "info");
        return;
      }
      const index = choices.indexOf(selected);
      if (index < 0) return;
      artifact = candidates[index];
    }
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
    commitState(ctx, result.state);
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
      lastCwd = ctx.cwd;
      if (!prepareOperation(ctx)) {
        return { content: [{ type: "text", text: i18n.t("errors.confirmationChanged") }], details: { submitted: false } };
      }
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
      // 先把派生显示层对齐 state.json，再取正文指纹：frontmatter 不进指纹
      reportFrontmatterIssues(ctx, syncFrontmatter(ctx.cwd, activeSlug, state));
      const document = readFileSync(path);
      const md = stripFrontmatter(document.toString("utf8"));
      const reqMd = artifact === "requirements"
        ? md
        : stripFrontmatter(readFileSync(artifactFileFor(ctx.cwd, activeSlug, "requirements"), "utf8"));
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

      const sha256 = documentDigest(document);
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
      commitState(ctx, result.state);
      // 用落盘后的状态值生成回执，不依赖被 commitState 改写的闭包变量
      const submitted = result.state;

      const warningText =
        validation.warnings.length > 0
          ? `\n\n${i18n.t("submit.warningHeader")}:\n${validation.warnings.map((w) => `- ${w}`).join("\n")}`
          : "";
      const nextHint =
        submitted.status === AWAITING_APPROVAL_STATUS
          ? i18n.t("submit.awaiting")
          : i18n.t("submit.advanced", {
              stage: stageLabel(submitted.phase),
            });
      return {
        content: [
          {
            type: "text",
            text: i18n.t("submit.success", {
              artifact,
              status: parseStatusKey(submitted),
              warnings: warningText,
              next: nextHint,
            }),
          },
        ],
        details: { submitted: true, warnings: validation.warnings },
      };
    },
  });

  // ── 审批请求工具 ──────────────────────────────────────────────────

  /**
   * 让模型主动请用户确认待批文档，省掉用户手敲 /spec approve。
   * 它只负责弹对话框：没有人工按键、没有 UI 或状态不对时一律不产生批准，
   * 也不推进阶段，因此不能用来绕过人工审批。
   */
  pi.registerTool({
    name: APPROVAL_REQUEST_TOOL,
    label: "Request Spec Approval",
    description: i18n.t("approvalRequest.description"),
    promptSnippet: i18n.t("approvalRequest.snippet"),
    promptGuidelines: [i18n.t("approvalRequest.guidelines")],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      lastCwd = ctx.cwd;
      if (!prepareOperation(ctx)) {
        return {
          content: [{ type: "text", text: i18n.t("errors.confirmationChanged") }],
          details: { approved: false },
        };
      }
      if (!activeSlug || !state) {
        return {
          content: [{ type: "text", text: i18n.t("errors.submitNoActive") }],
          details: { approved: false },
        };
      }
      if (state.status !== AWAITING_APPROVAL_STATUS) {
        return {
          content: [{
            type: "text",
            text: i18n.t("errors.approvalNotPending", { status: parseStatusKey(state) }),
          }],
          details: { approved: false },
        };
      }
      try {
        const outcome = await performApproval(ctx);
        const text = outcome.approved
          ? i18n.t("approvalRequest.approved", { detail: outcome.detail })
          : i18n.t("approvalRequest.rejected", { detail: outcome.detail });
        return { content: [{ type: "text", text }], details: { approved: outcome.approved } };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: i18n.t("errors.operationFailed", { reason: String(error) }),
          }],
          details: { approved: false },
        };
      }
    },
  });

  // ── 工具守卫 ────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (blockedReason) return { block: true, reason: blockedReason };
    if (!activeSlug || !state) return;

    try {
      if (!prepareOperation(ctx)) return { block: true, reason: i18n.t("errors.confirmationChanged") };
    } catch (error) {
      return { block: true, reason: i18n.t("errors.operationFailed", { reason: String(error) }) };
    }

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

    // 实现阶段放行源码写入，但任务定义和所有规格目录仍受保护。
    if (state.phase === IMPLEMENTATION_PHASE) {
      if (!isUnderSpecsRoot(ctx.cwd, abs)) return;
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

  /** 生命周期和每次模型请求都验证资源，坏状态不能继续沿用旧方法。 */
  function currentGuidance(ctx: ExtensionContext): { status: string | null; procedure: string | null } {
    if (blockedReason) return { status: blockedReason, procedure: null };
    if (!activeSlug || !state) return { status: null, procedure: null };
    try {
      prepareOperation(ctx);
      const procedure = loadProcedure(state);
      const status = [i18n.t("context.current", {
        slug: activeSlug, phase: state.phase, status: state.status,
        profile: state.profile, revision: state.revision,
        directory: specDirFor(ctx.cwd, activeSlug),
      })];
      if (state.status === AWAITING_APPROVAL_STATUS) {
        status.push(i18n.t("context.waiting", { phase: state.phase }));
      } else if (state.phase === COMPLETE_PHASE) {
        status.push(i18n.t("context.complete"));
      } else if (state.phase === IMPLEMENTATION_PHASE) {
        const done = new Set(state.completedTasks);
        const remaining = taskIdsFromTasksMd(ctx.cwd, activeSlug).filter((id) => !done.has(id));
        status.push(i18n.t("context.remaining", { remaining: JSON.stringify(remaining) }));
      } else {
        status.push(i18n.t("context.draft", { path: artifactFileFor(ctx.cwd, activeSlug, state.phase) }));
      }
      return { status: status.join("\n"), procedure };
    } catch (error) {
      if (!blockedReason) blockMode(ctx, i18n.t("errors.procedure", { reason: String(error) }));
      return { status: blockedReason, procedure: null };
    }
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    executionRun = null;
    currentGuidance(ctx);
    if (!blockedReason && activeSlug && state?.phase === IMPLEMENTATION_PHASE) {
      executionRun = { slug: activeSlug, revision: state.revision, epoch: activationEpoch };
    }
  });

  pi.on("context", async (event, ctx) => {
    const guidance = currentGuidance(ctx);
    return { messages: reconcileContext(event.messages, guidance.status, guidance.procedure) };
  });

  // ── 任务完成跟踪 ───────────────────────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    if (!activeSlug || !state || !executionRun || blockedReason) return;
    if (executionRun.slug !== activeSlug || executionRun.epoch !== activationEpoch ||
        executionRun.revision !== state.revision) return;
    if (state.phase !== IMPLEMENTATION_PHASE || state.status !== "in_progress") return;
    if (!isAssistantMessage(event.message)) return;
    const tags = [...assistantText(event.message).matchAll(/\[DONE:(TASK-[A-Za-z0-9_-]+)\]/g)].map((m) => m[1]);
    if (tags.length === 0) return;
    try {
      if (!prepareOperation(ctx)) return;
      const total = taskIdsFromTasksMd(ctx.cwd, activeSlug);
      const expectedRevision = state.revision;
      let candidate = state;
      for (const tag of new Set(tags)) {
        if (!total.includes(tag)) {
          ctx.ui.notify(i18n.t("errors.unknownTask", { task: tag }), "warning");
          continue;
        }
        if (candidate.completedTasks.includes(tag)) continue;
        const result = transition(candidate, { type: "task_done", taskId: tag });
        if (!result.ok) throw new Error(result.error);
        candidate = result.state;
      }
      if (candidate === state) return;
      const allDone = total.length > 0 && total.every((id) => candidate.completedTasks.includes(id));
      if (allDone) {
        const result = transition(candidate, { type: "all_tasks_done" });
        if (!result.ok) throw new Error(result.error);
        candidate = result.state;
      }
      commitState(ctx, candidate, expectedRevision);
      executionRun.revision = candidate.revision;
      if (allDone) ctx.ui.notify(i18n.t("ui.allTasksDone", { total: total.length }), "info");
    } catch (error) {
      ctx.ui.notify(i18n.t("errors.operationFailed", { reason: String(error) }), "error");
    }
  });

  pi.on("agent_end", async () => { executionRun = null; });

  // ── 会话恢复 ────────────────────────────────────────────────────────

  function restoreSession(ctx: ExtensionContext): void {
    lastCwd = ctx.cwd;
    const persist = ctx.sessionManager
      .getBranch()
      .filter(
        (e) => e.type === "custom" && e.customType === PERSIST_KEY,
      )
      .pop() as { data?: SessionPersist } | undefined;

    const slug = persist?.data?.activeSlug;
    if (slug === null || (!persist && slug === undefined)) {
      exitMode(ctx, false);
      return;
    }
    try {
      if (typeof slug !== "string" || parseSpecSlug(slug) !== slug) {
        throw new Error(i18n.t("errors.stateSchema"));
      }
      const candidate = loadState(ctx.cwd, slug);
      activationEpoch += 1;
      activeSlug = slug;
      state = candidate;
      blockedReason = null;
      repairFrontmatter(ctx, slug, candidate);
      if (persist?.data?.lastRevision != null && persist.data.lastRevision !== state.revision) {
        ctx.ui.notify(i18n.t("ui.diskRevisionChanged", {
          from: persist.data.lastRevision, to: state.revision,
        }), "warning");
      }
      prepareOperation(ctx);
      applyToolsForState();
      updateUi(ctx);
    } catch (error) {
      blockMode(ctx, String(error));
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreSession(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreSession(ctx);
  });
}
