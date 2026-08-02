import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/fallback-renderer.json", import.meta.url)));
import type { DistillRenderConfig } from "./summary-utils.ts";

export const DISTILL_AUDIT_ENTRY_TYPE = "pi-distill-audit";

type DistillAuditEntry = {
  toolName: string;
  details: Record<string, unknown>;
  render: DistillRenderConfig;
};

type AuditTone = "success" | "muted" | "dim" | "warning" | "error";

type DistillAuditView = {
  lines: string[];
  /** 状态图标同时承担品牌位（替换原 ◇），是语言无关符号，不走 locale。 */
  statusIcon: string;
  /** 状态文字；summarized 等自解释状态为空。 */
  statusText: string;
  statusTone: AuditTone;
};

type RenderTheme = {
  fg(color: "accent" | "toolTitle" | "success" | "muted" | "dim" | "warning" | "error" | "text", text: string): string;
  bold(text: string): string;
};

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

const MIN_TOOL_DURATION_DISPLAY_MS = 50;

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function appendSection(
  lines: string[],
  branch: "├─" | "└─",
  label: string,
  text: string,
): void {
  const visible = text.replace(/\r/g, "").trim();
  if (!visible) return;
  const [first = "", ...rest] = visible.split("\n");
  lines.push(`${branch} ${label}  ${first}`);
  const continuation = branch === "├─" ? "│       " : "        ";
  lines.push(...rest.map((line) => `${continuation}${line}`));
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCompactCount(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(rounded);
}

function renderDistillAuditLine(audit: DistillAuditView, line: string, index: number, theme: RenderTheme): string {
  if (index === 0) {
    const title = `${theme.fg(audit.statusTone, theme.bold(audit.statusIcon))}${theme.fg("accent", theme.bold(" Distill"))}`;
    const afterTitle = line.slice(`${audit.statusIcon} Distill`.length);
    const statusPrefix = audit.statusText ? `  ${audit.statusText}` : "";
    if (statusPrefix && afterTitle.startsWith(statusPrefix)) {
      return `${title}${theme.fg(audit.statusTone, statusPrefix)}${theme.fg("muted", afterTitle.slice(statusPrefix.length))}`;
    }
    return `${title}${theme.fg("muted", afterTitle)}`;
  }

  const section = line.match(/^([├└]─ )([^ ]+)(  )(.*)$/);
  if (section) {
    const [, branch, label, gap, content] = section;
    const labelTone = label === "Summary" ? "success" : label === "Error" ? "error" : label === "Warning" ? "warning" : "accent";
    return `${theme.fg("dim", branch ?? "")}${theme.fg(labelTone, label ?? "")}${gap ?? ""}${content ?? ""}`;
  }

  const continuation = line.match(/^(│       |        )(.*)$/);
  if (continuation) {
    return `${theme.fg("dim", continuation[1] ?? "")}${continuation[2] ?? ""}`;
  }
  return theme.fg("muted", line);
}

export function renderDistillAuditText(audit: DistillAuditView, theme: RenderTheme): string {
  return audit.lines.map((line, index) => renderDistillAuditLine(audit, line, index, theme)).join("\n");
}

function padLine(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function wrapDistillAuditLine(
  audit: DistillAuditView,
  line: string,
  index: number,
  theme: RenderTheme,
  width: number,
): string[] {
  const section = index > 0 ? line.match(/^([├└]─ )([^ ]+)(  )(.*)$/) : undefined;
  if (section) {
    const [, branch = "", label = "", gap = "  ", content = ""] = section;
    const labelTone = label === "Summary" ? "success" : label === "Error" ? "error" : label === "Warning" ? "warning" : "accent";
    const renderedPrefix = `${theme.fg("dim", branch)}${theme.fg(labelTone, label)}${gap}`;
    const renderedContinuation = theme.fg("dim", branch.startsWith("├") ? "│       " : "        ");
    const contentWidth = Math.max(1, width - visibleWidth(renderedPrefix));
    const wrappedContent = wrapTextWithAnsi(content, contentWidth);
    return wrappedContent.map((part, partIndex) => padLine(
      `${partIndex === 0 ? renderedPrefix : renderedContinuation}${part}`,
      width,
    ));
  }

  const continuation = index > 0 ? line.match(/^(│       |        )(.*)$/) : undefined;
  if (continuation) {
    const [, prefix = "", content = ""] = continuation;
    const renderedPrefix = theme.fg("dim", prefix);
    const contentWidth = Math.max(1, width - visibleWidth(renderedPrefix));
    const wrappedContent = wrapTextWithAnsi(content, contentWidth);
    return wrappedContent.map((part) => padLine(`${renderedPrefix}${part}`, width));
  }

  return wrapTextWithAnsi(renderDistillAuditLine(audit, line, index, theme), Math.max(1, width))
    .map((part) => padLine(part, width));
}

class DistillAuditComponent implements Component {
  constructor(
    private readonly audit: DistillAuditView,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    return [
      "",
      ...this.audit.lines.flatMap((line, index) =>
        wrapDistillAuditLine(this.audit, line, index, this.theme, renderWidth),
      ),
    ];
  }

  invalidate(): void {}
}

export function createDistillAuditComponent(audit: DistillAuditView, theme: RenderTheme): Component {
  return new DistillAuditComponent(audit, theme);
}

export function resolveDistillRenderConfig(
  details: Record<string, unknown>,
  fallback: DistillRenderConfig,
): DistillRenderConfig {
  const embedded = details.outputSummaryRender;
  if (!embedded || typeof embedded !== "object" || Array.isArray(embedded)) {
    return { ...fallback };
  }
  const source = embedded as Record<string, unknown>;
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : fallback.enabled,
    showPrompt: typeof source.showPrompt === "boolean" ? source.showPrompt : fallback.showPrompt,
    showResult: typeof source.showResult === "boolean" ? source.showResult : fallback.showResult,
  };
}

export function buildDistillAuditLines(
  toolName: string,
  details: Record<string, unknown>,
  expanded: boolean,
  render: DistillRenderConfig = { enabled: true, showPrompt: true, showResult: true },
): DistillAuditView | undefined {
  if (!render.enabled) return undefined;
  const status = getString(details.outputSummaryStatus);
  if (!status) return undefined;

  const statusViews: Record<string, { icon: string; textKey?: string; tone: AuditTone }> = {
    summarized: { icon: "✓", tone: "success" },
    "summary-fallback": { icon: "↺", textKey: "summaryFallback", tone: "warning" },
    disabled: { icon: "○", textKey: "disabled", tone: "dim" },
    "disabled-by-config": { icon: "○", textKey: "off", tone: "dim" },
    "not-requested": { icon: "○", textKey: "original", tone: "muted" },
    "full-output": { icon: "↺", textKey: "raw", tone: "warning" },
    "below-threshold": { icon: "–", textKey: "belowThreshold", tone: "dim" },
    "non-text-output": { icon: "○", textKey: "nonTextOutput", tone: "muted" },
    "diagnostic-failed": { icon: "!", textKey: "readFailed", tone: "warning" },
    "summary-failed": { icon: "✕", textKey: "summaryFailed", tone: "error" },
  };
  const anomalies = Array.isArray(details.outputSummaryAnomalies)
    ? details.outputSummaryAnomalies.filter((value): value is string => typeof value === "string")
    : [];
  const advice = getString(details.outputSummaryAdvice);
  const error = getString(details.outputSummaryError);
  const originalChars = getFiniteNumber(details.originalOutputChars);
  const summaryChars = getFiniteNumber(details.summaryChars);
  const estimatedOriginalTokens = getFiniteNumber(details.estimatedOriginalOutputTokens);
  const estimatedSummaryTokens = getFiniteNumber(details.estimatedSummaryTokens);
  const estimatedTokensSaved = getFiniteNumber(details.estimatedTokensSaved);
  const summaryTotalTokens = getFiniteNumber(details.summaryTotalTokens);
  const compressionSavedPercent = getFiniteNumber(details.compressionSavedPercent);
  const toolExecutionMs = getFiniteNumber(details.toolExecutionMs);
  const summaryDurationMs = getFiniteNumber(details.summaryDurationMs);
  const fullOutputPath = getString(details.fullOutputPath);
  const outputRequest = getString(details.outputSummaryPrompt);
  const summaryText = getString(details.summaryText);
  const statusView = statusViews[status] ?? { icon: "○", tone: "muted" as const };
  const statusText = statusView.textKey ? i18n.t(statusView.textKey) : status in statusViews ? "" : status;

  let mainMetric = "";
  if (estimatedOriginalTokens !== undefined && estimatedSummaryTokens !== undefined) {
    mainMetric = `${formatCompactCount(estimatedOriginalTokens)} → ${formatCompactCount(estimatedSummaryTokens)} ${i18n.t("tokens")}`;
    if (estimatedTokensSaved !== undefined && estimatedTokensSaved > 0 && compressionSavedPercent !== undefined) {
      mainMetric += ` ↓${compressionSavedPercent.toFixed(1)}%`;
    }
  } else if (originalChars !== undefined && summaryChars !== undefined) {
    mainMetric = `${formatCount(originalChars)} → ${formatCount(summaryChars)} ${i18n.t("chars")}`;
    if (compressionSavedPercent !== undefined) {
      mainMetric += ` ↓${compressionSavedPercent.toFixed(1)}%`;
    }
  } else if (originalChars !== undefined) {
    mainMetric = `${formatCount(originalChars)} ${i18n.t("chars")}`;
  }

  const secondaryMetrics: string[] = [];
  if (summaryTotalTokens !== undefined && summaryTotalTokens > 0) {
    secondaryMetrics.push(`${i18n.t("compressionTokens")} ${formatCompactCount(summaryTotalTokens)}`);
  }
  if (toolExecutionMs !== undefined && toolExecutionMs >= MIN_TOOL_DURATION_DISPLAY_MS) {
    secondaryMetrics.push(`${i18n.t("tool")} ${formatDuration(toolExecutionMs)}`);
  }
  if (summaryDurationMs !== undefined) secondaryMetrics.push(`${i18n.t("distill")} ${formatDuration(summaryDurationMs)}`);

  const expandHint = expanded ? "" : i18n.t("expand");
  const metricParts = [mainMetric, ...secondaryMetrics].filter((part) => part.length > 0);
  const headerSegments = [`${statusView.icon} Distill`];
  if (statusText) headerSegments.push(statusText);
  if (metricParts.length > 0) headerSegments.push(metricParts.join(" · "));
  const lines = [`${headerSegments.join("  ")}${expandHint}`];
  if (expanded) {
    const sections: Array<{ label: string; text: string }> = [];
    if (render.showPrompt && outputRequest) sections.push({ label: i18n.t("outputRequest"), text: outputRequest });
    if (render.showResult && summaryText) sections.push({ label: i18n.t("summary"), text: summaryText });
    if (fullOutputPath) sections.push({ label: i18n.t("file"), text: fullOutputPath });
    if (anomalies.length > 0) sections.push({ label: i18n.t("warning"), text: anomalies.join(", ") });
    if (advice) sections.push({ label: i18n.t("warning"), text: advice });
    if (error) sections.push({ label: i18n.t("error"), text: error });
    sections.forEach((section, index) => {
      appendSection(
        lines,
        index === sections.length - 1 ? "└─" : "├─",
        section.label,
        section.text,
      );
    });
  }

  if (anomalies.length > 0) {
    statusView.tone = "error";
  }

  return {
    lines,
    statusIcon: statusView.icon,
    statusText,
    statusTone: statusView.tone,
  };
}

export function registerDistillFallbackRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<DistillAuditEntry>(
    DISTILL_AUDIT_ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      const audit = buildDistillAuditLines(data.toolName, data.details, expanded, data.render);
      if (!audit) return undefined;
      return createDistillAuditComponent(audit, theme);
    },
  );
}

export function appendDistillFallbackAudit(
  pi: Pick<ExtensionAPI, "appendEntry">,
  toolName: string,
  details: unknown,
  render: DistillRenderConfig,
): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const record = details as Record<string, unknown>;
  const effectiveRender = resolveDistillRenderConfig(record, render);
  if (!effectiveRender.enabled) return false;
  if (!getString(record.outputSummaryStatus)) return false;
  pi.appendEntry<DistillAuditEntry>(DISTILL_AUDIT_ENTRY_TYPE, {
    toolName,
    details: record,
    render: effectiveRender,
  });
  return true;
}
