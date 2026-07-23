import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import type { WorkflowMeta } from "./workflow.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  resultFile?: string;
  startedAt?: number;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  maxLogs?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases.map((p) => p.title),
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  const render = (snapshot: WorkflowSnapshot, completed = false) => {
    if (!ctx.hasUI) return;
    if (showStatus) ctx.ui.setStatus(key, statusLine(snapshot, completed));
    ctx.ui.setWidget(key, renderWorkflowLines(snapshot, options), { placement });
  };

  return {
    update(snapshot) {
      render(snapshot, false);
    },
    complete(snapshot) {
      render(snapshot, true);
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed, options) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
  };

  return {
    update(snapshot) {
      emit(snapshot, false);
    },
    complete(snapshot) {
      emit(snapshot, true);
    },
    clear() {
      widget?.clear();
    },
  };
}

export function renderWorkflowLines(snapshot: WorkflowSnapshot, options: WorkflowDisplayOptions = {}): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const maxLogs = options.maxLogs ?? 2;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  const lines = [`◆ Workflow: ${snapshot.name} (${snapshot.doneCount}/${snapshot.agentCount} done${state})`];

  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      `  ${marker} ${phase} ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
    );

    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      const err = agent.status === "error" && agent.error ? ` [${shorten(agent.error, 80)}]` : "";
      lines.push(`    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}${err}`);
    }
    if (agents.length > visibleAgents.length)
      lines.push(`    … ${agents.length - visibleAgents.length} earlier agents`);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push("  Unphased");
    for (const agent of unphased.slice(-maxAgents)) {
      const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
      const err = agent.status === "error" && agent.error ? ` [${shorten(agent.error, 80)}]` : "";
      lines.push(`    #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}${err}`);
    }
  }

  const visibleLogs = snapshot.logs.slice(-maxLogs);
  if (visibleLogs.length) {
    if (lines.length > 1) lines.push("");
    for (const log of visibleLogs) lines.push(`  log: ${log}`);
  }

  // 附加最终结果文件路径
  if (snapshot.resultFile && snapshot.runningCount === 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`  ${i18n.t("totalResult", { path: snapshot.resultFile })}`);
  }

  return lines;
}

export function renderWorkflowText(
  snapshot: WorkflowSnapshot,
  completed = false,
  options: WorkflowDisplayOptions = {},
): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot, options)].join("\n");
}

// 仿 pi-interactive-subagents 的 formatStatusLine：
// 每行一个 agent 状态，格式：`{label} {state detail} {elapsed}.`
export function formatAgentStatusLine(agent: WorkflowAgentSnapshot, now = Date.now()): string {
  const label = shorten(agent.label, 64);
  const elapsed = agent.startedAt ? ((agent.finishedAt ?? now) - agent.startedAt) / 1000 : 0;
  const elapsedText = `${elapsed.toFixed(1)}s`;
  if (agent.status === "running") {
    return `${label} running ${elapsedText}, active.`;
  }
  if (agent.status === "done") {
    return `${label} finished in ${elapsedText}.`;
  }
  if (agent.status === "error") {
    return `${label} failed after ${elapsedText}${agent.error ? ` (${shorten(agent.error, 60)})` : ""}.`;
  }
  if (agent.status === "skipped") {
    return `${label} skipped.`;
  }
  return `${label} queued.`;
}

// 汇总所有 active agent（queued + running），其他只输出当前 phase 的进行中 agent
export function formatWorkflowStatusAggregate(
  snapshot: WorkflowSnapshot,
  lineLimit = 4,
  now = Date.now(),
): { lines: string[]; overflow: number } {
  const running = snapshot.agents.filter((a) => a.status === "running");
  const queued = snapshot.agents.filter((a) => a.status === "queued");
  const recent = [...running, ...queued].slice(0, lineLimit);
  const lines = recent.map((a) => formatAgentStatusLine(a, now));
  const overflow = Math.max(0, running.length + queued.length - recent.length);
  return { lines, overflow };
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * CJK 双宽字符检测：返回字符的终端可见宽度（1 或 2）。
 */
function cjkCharWidth(code: number): number {
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  )
    return 2;
  return 1;
}

/**
 * 计算字符串的终端可见宽度（考虑 CJK 双宽字符）。
 */
function visibleStrWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    w += cjkCharWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

/**
 * 按可见宽度截断字符串，超出部分用省略号「…」替代。
 * 用于 TUI widget 行内容截断，防止超出终端宽度导致 pi-tui 崩溃。
 */
function truncateVisible(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const w = visibleStrWidth(str);
  if (w <= maxWidth) return str;
  const target = maxWidth - 1; // 留给「…」
  let result = "";
  let currentWidth = 0;
  for (const ch of str) {
    const cw = cjkCharWidth(ch.codePointAt(0) ?? 0);
    if (currentWidth + cw > target) break;
    result += ch;
    currentWidth += cw;
  }
  return `${result}…`;
}

export function preview(value: unknown, max = 200): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1s";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

export interface WorkflowTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

export function renderWorkflowThemed(
  snapshot: WorkflowSnapshot,
  theme: WorkflowTheme,
  options: WorkflowDisplayOptions = {},
): string {
  const showResultPreviews = options.showResultPreviews ?? false;
  const maxAgents = options.maxAgents ?? 8;

  const elapsed = snapshot.durationMs ? formatElapsed(snapshot.durationMs) : "";
  const agentSummary = `${snapshot.agentCount} agents`;
  const durationPart = elapsed ? ` · ${elapsed}` : "";

  const lines: string[] = [];

  // Header: ▸ {name} — {agentCount} agents · {duration}
  lines.push(
    `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold(snapshot.name))} ${theme.fg("dim", `— ${agentSummary}${durationPart}`)}`,
  );
  lines.push("");

  // Group agents by phase
  const agentPhaseNames = snapshot.agents
    .map((agent) => agent.phase)
    .filter((phase): phase is string => Boolean(phase));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    if (agents.length === 0 && snapshot.currentPhase !== phase) continue;
    for (const agent of agents) rendered.add(agent);

    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running").length;
    const errors = agents.filter((a) => a.status === "error").length;
    const skipped = agents.filter((a) => a.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;

    // Phase icon
    let phaseIcon: string;
    if (complete) {
      phaseIcon = theme.fg("success", "✓");
    } else if (running > 0 || snapshot.currentPhase === phase) {
      phaseIcon = theme.fg("accent", "▶");
    } else {
      phaseIcon = theme.fg("dim", "○");
    }

    // Phase duration: first agent startedAt → last agent finishedAt
    const phaseElapsed = computePhaseDuration(agents);
    const phaseDurationText = phaseElapsed ? theme.fg("dim", formatElapsed(phaseElapsed)) : "";

    lines.push(`  ${phaseIcon} ${phase}${phaseDurationText ? `  ${phaseDurationText}` : ""}`);

    // Agents in this phase
    const visibleAgents = agents.slice(-maxAgents);
    for (const agent of visibleAgents) {
      const order = `#${agent.id}`;
      const icon = themedStatusIcon(agent.status, theme);
      const label = theme.fg("toolOutput", shorten(agent.label, 48));
      const agentElapsed = computeAgentDuration(agent);
      const agentDurationText = agentElapsed ? `  ${theme.fg("dim", formatElapsed(agentElapsed))}` : "";
      const err =
        agent.status === "error" && agent.error ? ` ${theme.fg("error", `[${shorten(agent.error, 60)}]`)}` : "";
      lines.push(`    ${order} ${icon} ${label}${agentDurationText}${err}`);

      // Result preview (file path)
      if (showResultPreviews && agent.resultPreview) {
        lines.push(`         ${theme.fg("muted", agent.resultPreview)}`);
      }
    }
    if (agents.length > visibleAgents.length) {
      lines.push(`    ${theme.fg("dim", `… ${agents.length - visibleAgents.length} earlier agents`)}`);
    }
  }

  // Unphased agents
  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    lines.push(`  ${theme.fg("dim", "Unphased")}`);
    for (const agent of unphased.slice(-maxAgents)) {
      const icon = themedStatusIcon(agent.status, theme);
      const label = theme.fg("toolOutput", shorten(agent.label, 48));
      const agentElapsed = computeAgentDuration(agent);
      const agentDurationText = agentElapsed ? `  ${theme.fg("dim", formatElapsed(agentElapsed))}` : "";
      const err =
        agent.status === "error" && agent.error ? ` ${theme.fg("error", `[${shorten(agent.error, 60)}]`)}` : "";
      lines.push(`    #${agent.id} ${icon} ${label}${agentDurationText}${err}`);
      if (showResultPreviews && agent.resultPreview) {
        lines.push(`         ${theme.fg("muted", agent.resultPreview)}`);
      }
    }
  }

  // Result file
  if (snapshot.resultFile) {
    lines.push("");
    lines.push(`  ${theme.fg("muted", `📄 ${snapshot.resultFile}`)}`);
  }

  return lines.join("\n");
}

function themedStatusIcon(status: WorkflowAgentStatus, theme: WorkflowTheme): string {
  switch (status) {
    case "done":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "running":
      return theme.fg("accent", "●");
    case "queued":
      return theme.fg("dim", "○");
    case "skipped":
      return theme.fg("dim", "-");
  }
}

/**
 * 渲染带边框的 Widget 状态栏行（用于 aboveEditor widget）。
 * 使用 box-drawing 字符和硬编码 ANSI 色彩。
 */
export function renderWorkflowWidgetLines(snapshot: WorkflowSnapshot, width: number): string[] {
  const ACCENT = "\x1b[38;2;77;163;255m";
  const RST = "\x1b[0m";
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[90m";

  const MAX_VISIBLE_AGENTS = 6;
  // boxWidth 必须严格不超过终端实际宽度，否则 pi-tui 会因行超出终端宽度而崩溃。
  // 原先 Math.max(50, width) 在窄终端（如 43 列分屏）下强制设为 50，导致渲染行
  // visible width=50 > 终端宽度 43，pi-tui 抛出 uncaughtException 退出。
  // 修复：去掉 50 上限，让 widget 跟随终端实际宽度自适应填满。
  // 最小 20 是为了保证极窄终端下 innerWidth=18 有足够空间显示基本内容。
  const boxWidth = Math.max(20, width);
  const innerWidth = boxWidth - 2; // exclude │ on each side

  // 可见宽度辅助函数（考虑 CJK 双宽字符），已抽离为模块级 visibleStrWidth
  const strWidth = visibleStrWidth;

  // Helper: pad content line to fit inside box.
  // 不变式：调用方保证 rawLen <= innerWidth，padLine 只补右侧空白到 innerWidth。
  const padLine = (content: string, rawLen: number): string => {
    const padding = Math.max(0, innerWidth - rawLen);
    return `${ACCENT}│${RST}${content}${" ".repeat(padding)}${ACCENT}│${RST}`;
  };

  // Title line: ╭─ Workflow: {name} ──── {done}/{total} done ─╮
  // 标题结构：╭ + ─ + titleText + ─*fill + statsText + ─ + ╮
  // 总可见宽度 = 1(╭) + 1(─) + titleTextW + fillLen + statsTextW + 1(─) + 1(╮)
  //           = 4 + titleTextW + fillLen + statsTextW
  // fillLen 至少 1。极窄终端下逐步压缩 titlePrefix/statsText。
  let titlePrefix = ` Workflow: `;
  let statsText = ` ${snapshot.doneCount}/${snapshot.agentCount} done `;
  // 判断在最小 fill(1) 下能否装下：4 + prefixW + 1(name至少1) + 1(fill) + statsW + 1(尾部空格) <= boxWidth
  const tryFit = (prefix: string, stats: string): boolean =>
    4 + strWidth(prefix) + 1 + 1 + strWidth(stats) + 1 <= boxWidth;
  if (!tryFit(titlePrefix, statsText)) {
    statsText = ` ${snapshot.doneCount}/${snapshot.agentCount} `;
  }
  if (!tryFit(titlePrefix, statsText)) {
    titlePrefix = ` `;
    statsText = `${snapshot.doneCount}/${snapshot.agentCount}`;
  }
  if (!tryFit(titlePrefix, statsText)) {
    // 极窄：只显示 name + 边框
    titlePrefix = ``;
    statsText = ``;
  }
  // 固定占用 4（╭ ─ ─ ╮，不含 titleText/statsText/fill）
  const fixedOverhead = 4;
  // titleText = titlePrefix + name + " "（尾部空格）
  const maxNameWidth = Math.max(1, boxWidth - fixedOverhead - strWidth(titlePrefix) - strWidth(statsText) - 2); // -1 尾空格 -1 fill
  const truncatedName = truncateVisible(snapshot.name, maxNameWidth);
  const titleText = `${titlePrefix}${truncatedName} `;
  const fillLen = Math.max(1, boxWidth - fixedOverhead - strWidth(titleText) - strWidth(statsText));
  const topLine = `${ACCENT}╭─${titleText}${"─".repeat(fillLen)}${statsText}─╮${RST}`;

  // Bottom line: ╰ + ─*(boxWidth-2) + ╯
  const bottomLine = `${ACCENT}╰${"─".repeat(boxWidth - 2)}╯${RST}`;

  const lines: string[] = [topLine];

  // Group agents by phase
  const agentPhaseNames = snapshot.agents.map((a) => a.phase).filter((p): p is string => Boolean(p));
  const phaseNames = unique([
    ...snapshot.phases,
    ...(snapshot.currentPhase ? [snapshot.currentPhase] : []),
    ...agentPhaseNames,
  ]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  /** 渲染单个 agent 行。返回 padLine 后的字符串。 */
  const renderAgentLine = (agent: WorkflowAgentSnapshot): string => {
    const order = `#${agent.id}`;
    const { icon } = widgetStatusIcon(agent.status);
    const agentElapsed = computeAgentDuration(agent);
    const elapsedText = agentElapsed ? formatElapsed(agentElapsed) : "";

    const statusLabel =
      agent.status === "done"
        ? "done"
        : agent.status === "running"
          ? "running"
          : agent.status === "error"
            ? "error"
            : "";
    let rightText = elapsedText ? `${statusLabel} ${elapsedText}` : statusLabel;
    let rightRawLen = rightText.length;
    const statusColor =
      agent.status === "done" ? GREEN : agent.status === "running" ? CYAN : agent.status === "error" ? RED : DIM;
    let rightPart = rightText ? `${statusColor}${rightText}${RST}` : "";

    // 布局："    " + order + " " + icon + " " + label + gap + rightText
    // 左侧固定部分宽度（不含 label）：4(空格) + orderW + 1(空格) + 1(icon) + 1(空格)
    const leftFixedWidth = 4 + order.length + 1 + 1 + 1;
    // 如果有 rightText，需留至少 1 个 gap + rightRawLen
    let minRightWidth = rightRawLen > 0 ? 1 + rightRawLen : 0;
    // 极窄终端下 leftFixedWidth + minRightWidth 可能已超过 innerWidth。
    // 此时逐步压缩：先去掉耗时，只留状态；再去掉状态，只留 label；最后连 label 也截断。
    if (leftFixedWidth + minRightWidth > innerWidth) {
      // 阶段 1：只留状态标签（去掉耗时）
      rightText = statusLabel;
      rightRawLen = rightText.length;
      minRightWidth = rightRawLen > 0 ? 1 + rightRawLen : 0;
    }
    if (leftFixedWidth + minRightWidth > innerWidth) {
      // 阶段 2：去掉右侧状态，只留左侧 label
      rightText = "";
      rightRawLen = 0;
      rightPart = "";
      minRightWidth = 0;
    }
    const labelMaxWidth = Math.max(1, innerWidth - leftFixedWidth - minRightWidth);
    const label = truncateVisible(agent.label.replace(/\s+/g, " ").trim(), labelMaxWidth);

    const leftPart = `    ${order} ${icon} ${label}`;
    const leftRawLen = leftFixedWidth + strWidth(label);

    // gap 填充剩余空间；如果没有 rightText，gap 可以是 0（label 占满）
    const gapLen = Math.max(rightRawLen > 0 ? 1 : 0, innerWidth - leftRawLen - rightRawLen);
    const agentLine = `${leftPart}${" ".repeat(gapLen)}${rightPart}`;
    const agentRawLen = leftRawLen + gapLen + rightRawLen;
    return padLine(agentLine, agentRawLen);
  };

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((a) => a.phase === phase);
    for (const a of agents) rendered.add(a);

    const done = agents.filter((a) => a.status === "done").length;
    const running = agents.filter((a) => a.status === "running").length;
    const errors = agents.filter((a) => a.status === "error").length;
    const skipped = agents.filter((a) => a.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;

    // Phase icon
    let phaseIcon: string;
    if (complete) {
      phaseIcon = `${GREEN}✓${RST}`;
    } else if (running > 0 || snapshot.currentPhase === phase) {
      phaseIcon = `${CYAN}▶${RST}`;
    } else {
      phaseIcon = `${DIM}○${RST}`;
    }

    // Phase 行：按可见宽度截断 phase 名称，防止超出 innerWidth
    // 布局："  " + icon(1) + " " + phaseName，总共占 2+1+1+nameW = 4+nameW
    const phaseNameMaxWidth = Math.max(1, innerWidth - 4);
    const truncatedPhase = truncateVisible(phase, phaseNameMaxWidth);
    const phaseContent = `  ${phaseIcon} ${truncatedPhase}`;
    const phaseRawLen = 2 + 1 + 1 + strWidth(truncatedPhase); // "  " + icon + " " + name
    lines.push(padLine(phaseContent, phaseRawLen));

    // Agents in this phase
    const visibleAgents = agents.slice(-MAX_VISIBLE_AGENTS);
    for (const agent of visibleAgents) {
      lines.push(renderAgentLine(agent));
    }
    if (agents.length > visibleAgents.length) {
      const moreText = `    … ${agents.length - visibleAgents.length} earlier`;
      const moreRawLen = 2 + moreText.length;
      // 极窄终端下 moreText 可能超过 innerWidth，截断保护
      if (moreRawLen > innerWidth) {
        const truncated = truncateVisible(`  ${moreText}`, innerWidth);
        lines.push(padLine(`${DIM}${truncated}${RST}`, strWidth(truncated)));
      } else {
        lines.push(padLine(`  ${DIM}${moreText}${RST}`, moreRawLen));
      }
    }
  }

  // Unphased agents
  const unphased = snapshot.agents.filter((a) => !rendered.has(a));
  if (unphased.length) {
    const visibleAgents = unphased.slice(-MAX_VISIBLE_AGENTS);
    for (const agent of visibleAgents) {
      lines.push(renderAgentLine(agent));
    }
    if (unphased.length > visibleAgents.length) {
      const moreText = `    … ${unphased.length - visibleAgents.length} earlier`;
      const moreRawLen = 2 + moreText.length;
      if (moreRawLen > innerWidth) {
        const truncated = truncateVisible(`  ${moreText}`, innerWidth);
        lines.push(padLine(`${DIM}${truncated}${RST}`, strWidth(truncated)));
      } else {
        lines.push(padLine(`  ${DIM}${moreText}${RST}`, moreRawLen));
      }
    }
  }

  lines.push(bottomLine);
  return lines;
}

function widgetStatusIcon(status: WorkflowAgentStatus): { icon: string; iconRaw: string } {
  const GREEN = "\x1b[32m";
  const CYAN = "\x1b[36m";
  const RED = "\x1b[31m";
  const DIM = "\x1b[90m";
  const RST = "\x1b[0m";
  switch (status) {
    case "done":
      return { icon: `${GREEN}✓${RST}`, iconRaw: "✓" };
    case "running":
      return { icon: `${CYAN}●${RST}`, iconRaw: "●" };
    case "error":
      return { icon: `${RED}✗${RST}`, iconRaw: "✗" };
    case "queued":
      return { icon: `${DIM}○${RST}`, iconRaw: "○" };
    case "skipped":
      return { icon: `${DIM}-${RST}`, iconRaw: "-" };
  }
}

function computePhaseDuration(agents: WorkflowAgentSnapshot[]): number | undefined {
  const starts = agents.map((a) => a.startedAt).filter((t): t is number => t != null);
  const ends = agents.map((a) => a.finishedAt).filter((t): t is number => t != null);
  if (starts.length === 0 || ends.length === 0) return undefined;
  const duration = Math.max(...ends) - Math.min(...starts);
  return duration > 0 ? duration : undefined;
}

function computeAgentDuration(agent: WorkflowAgentSnapshot): number | undefined {
  if (!agent.startedAt) return undefined;
  const end = agent.finishedAt ?? Date.now();
  const duration = end - agent.startedAt;
  return duration > 0 ? duration : undefined;
}
