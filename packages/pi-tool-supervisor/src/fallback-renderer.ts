import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";

const i18n = createTranslator(loadCatalog(new URL("../locales/fallback-renderer.json", import.meta.url)));

export const SUPERVISOR_AUDIT_ENTRY_TYPE = "pi-tool-supervisor-audit";

type ReviewerAudit = {
  name?: string;
  status?: string;
  summary?: string;
  error?: string;
  durationMs?: number;
};

type SupervisorAudit = {
  status?: string;
  filePath?: string;
  durationMs?: number;
  warnings?: string[];
  reviewers?: ReviewerAudit[];
};

type SupervisorAuditEntry = {
  toolName: string;
  audit: SupervisorAudit;
};

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function buildSupervisorAuditLines(
  toolName: string,
  audit: SupervisorAudit,
  expanded: boolean,
): { lines: string[]; tone: "muted" | "warning" | "error" } | undefined {
  if (!audit.status) return undefined;
  const reviewers = Array.isArray(audit.reviewers) ? audit.reviewers : [];
  const warnings = Array.isArray(audit.warnings)
    ? audit.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  const statusLabels: Record<string, string> = {
    passed: i18n.t("passed"),
    rejected: i18n.t("rejected"),
    failed: i18n.t("failed"),
    skipped: i18n.t("skipped"),
    disabled: i18n.t("disabled"),
  };
  const parts = [
    i18n.t("title"),
    toolName,
    statusLabels[audit.status] ?? audit.status,
    i18n.t("reviewerCount", { count: reviewers.length }),
  ];
  const durationMs = getFiniteNumber(audit.durationMs);
  if (durationMs !== undefined) parts.push(formatDuration(durationMs));

  const lines = [parts.join(" · ")];
  if (expanded) {
    if (audit.filePath) lines.push(i18n.t("file", { path: audit.filePath }));
    for (const reviewer of reviewers) {
      const reviewerStatus = reviewer.status === "passed"
        ? i18n.t("reviewerPassed")
        : reviewer.status === "rejected"
          ? i18n.t("reviewerRejected")
          : reviewer.status === "failed"
            ? i18n.t("reviewerFailed")
            : i18n.t("reviewerSkipped");
      const reviewerDuration = getFiniteNumber(reviewer.durationMs);
      const conclusion = reviewer.summary ?? reviewer.error;
      lines.push([
        `  ${reviewer.name ?? i18n.t("reviewer")}`,
        reviewerStatus,
        reviewerDuration === undefined ? undefined : formatDuration(reviewerDuration),
        conclusion,
      ].filter(Boolean).join(" · "));
    }
    for (const warning of warnings) lines.push(`  ⚠ ${warning}`);
  }

  return {
    lines,
    tone: audit.status === "rejected" ? "error" : audit.status === "failed" || warnings.length > 0 ? "warning" : "muted",
  };
}

export function registerSupervisorFallbackRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<SupervisorAuditEntry>(
    SUPERVISOR_AUDIT_ENTRY_TYPE,
    (entry, { expanded }, theme) => {
      const data = entry.data;
      if (!data) return undefined;
      const rendered = buildSupervisorAuditLines(data.toolName, data.audit, expanded);
      if (!rendered) return undefined;
      return new Text(theme.fg(rendered.tone, rendered.lines.join("\n")), 0, 0);
    },
  );
}

export function appendSupervisorFallbackAudit(
  pi: Pick<ExtensionAPI, "appendEntry">,
  toolName: string,
  details: unknown,
): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) return false;
  const audit = (details as Record<string, unknown>).fileEditReview;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return false;
  const record = audit as SupervisorAudit;
  if (!record.status) return false;
  pi.appendEntry<SupervisorAuditEntry>(SUPERVISOR_AUDIT_ENTRY_TYPE, { toolName, audit: record });
  return true;
}
