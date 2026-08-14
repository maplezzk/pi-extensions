import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ResourceAction, SessionResource } from "./collector.ts";
import { i18n } from "./i18n.ts";

export const COMPACT_RESOURCE_LIMIT = 4;
export const EXPANDED_RESOURCE_LIMIT = 16;
const MAX_ACTION_LABELS = 2;

const ACTION_LABELS: Record<ResourceAction, string> = {
  read: "actionRead",
  changed: "actionChanged",
  inspected: "actionInspected",
  opened: "actionOpened",
  created: "actionCreated",
  referenced: "actionReferenced",
};

/** Converts a resource target to the URI consumed by OSC 8. */
function resourceUri(resource: SessionResource): string | undefined {
  if (resource.kind !== "file") return resource.target;
  try {
    return pathToFileURL(resource.target).href;
  } catch {
    return undefined;
  }
}

/** Returns the compact, locale-neutral resource kind marker. */
function kindLabel(resource: SessionResource): string {
  if (resource.kind === "review") return "MR";
  if (resource.kind === "web") return "WEB";
  return "FILE";
}

/** Formats at most two actions so narrow widget rows remain useful. */
function actionLabel(resource: SessionResource): string {
  return resource.actions
    .slice(0, MAX_ACTION_LABELS)
    .map((action) => i18n.t(ACTION_LABELS[action]))
    .join(",");
}

/** Renders one width-safe OSC 8 resource row. */
function renderResourceLine(resource: SessionResource, width: number, theme: Theme): string {
  const prefix = theme.fg("dim", `${kindLabel(resource)} `);
  const suffix = theme.fg("muted", `  [${actionLabel(resource)}]`);
  const reservedWidth = visibleWidth(prefix) + visibleWidth(suffix);
  if (width <= reservedWidth) {
    return truncateToWidth(`${kindLabel(resource)} [${actionLabel(resource)}]`, width, "");
  }

  const display = truncateToWidth(resource.label, width - reservedWidth, "…");
  const styledDisplay = theme.fg(resource.kind === "file" ? "text" : "accent", display);
  const uri = resourceUri(resource);
  const linkedDisplay = uri ? hyperlink(styledDisplay, uri) : styledDisplay;
  return `${prefix}${linkedDisplay}${suffix}`;
}

export interface RenderResourceWidgetOptions {
  resources: readonly SessionResource[];
  width: number;
  expanded: boolean;
  theme: Theme;
}

/** Renders the compact or expanded resource widget without exceeding terminal width. */
export function renderResourceWidget(options: RenderResourceWidgetOptions): string[] {
  const { resources, width, expanded, theme } = options;
  if (width <= 0 || resources.length === 0) return [];

  const fileCount = resources.filter((resource) => resource.kind === "file").length;
  const linkCount = resources.length - fileCount;
  const title = theme.fg("accent", theme.bold(i18n.t("widgetTitle")));
  const counts = theme.fg("dim", i18n.t("summaryCounts", { files: fileCount, links: linkCount }));
  const lines = [truncateToWidth(`${title}  ${counts}`, width, "…")];

  const limit = expanded ? EXPANDED_RESOURCE_LIMIT : COMPACT_RESOURCE_LIMIT;
  for (const resource of resources.slice(0, limit)) {
    lines.push(renderResourceLine(resource, width, theme));
  }

  const hiddenCount = resources.length - limit;
  if (hiddenCount > 0) {
    const key = expanded ? "olderResources" : "moreResources";
    lines.push(truncateToWidth(theme.fg("dim", i18n.t(key, { count: hiddenCount })), width, "…"));
  }

  return lines;
}
