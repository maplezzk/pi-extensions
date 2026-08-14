import { pathToFileURL } from "node:url";
import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ResourceAction, ResourceKind, SessionResource } from "./collector.ts";
import { i18n } from "./i18n.ts";

export const COMPACT_RESOURCE_LIMIT = 4;
export const EXPANDED_RESOURCE_LIMIT = 16;
export const RESOURCE_TABS = ["file", "review", "web"] as const;
export type ResourceTab = (typeof RESOURCE_TABS)[number];

const DEFAULT_RESOURCE_TAB = RESOURCE_TABS[0];
const MAX_ACTION_LABELS = 2;
const TOOLS_EXPAND_KEYBINDING = "app.tools.expand";
const TAB_LABELS: Record<ResourceTab, string> = {
  file: "FILE",
  review: "PR/MR",
  web: "WEB",
};

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

/** Uses Pi's configured expansion key, falling back to the standard command when unbound. */
function expansionHint(expanded: boolean): string {
  const shortcut = keyText(TOOLS_EXPAND_KEYBINDING);
  if (!shortcut) return i18n.t(expanded ? "collapseCommand" : "expandCommand");
  return i18n.t(expanded ? "collapseShortcut" : "expandShortcut", { shortcut });
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

interface RenderTabBarOptions {
  resources: readonly SessionResource[];
  activeTab: ResourceTab;
  width: number;
  theme: Theme;
}

/** Renders the ask_user_question-style resource type tab bar. */
function renderTabBar(options: RenderTabBarOptions): string {
  const { resources, activeTab, width, theme } = options;
  const counts = new Map<ResourceKind, number>();
  for (const resource of resources) counts.set(resource.kind, (counts.get(resource.kind) ?? 0) + 1);

  const pieces = [theme.fg("dim", " ← ")];
  for (const tab of RESOURCE_TABS) {
    const count = counts.get(tab) ?? 0;
    const segment = ` ${TAB_LABELS[tab]} ${count} `;
    pieces.push(
      tab === activeTab
        ? theme.bg("selectedBg", theme.fg("text", segment))
        : theme.fg(count > 0 ? "muted" : "dim", segment),
    );
    pieces.push(" ");
  }
  pieces.push(theme.fg("dim", "→ "));
  return truncateToWidth(pieces.join(""), width, "");
}

/** Renders one full-width accent border matching Pi's questionnaire chrome. */
function renderBorder(width: number, theme: Theme): string {
  return theme.fg("accent", "─".repeat(Math.max(0, width)));
}

/** Returns the first useful tab while preserving an explicitly selected non-empty tab. */
export function resolveResourceTab(
  resources: readonly SessionResource[],
  preferred?: ResourceTab,
): ResourceTab {
  if (preferred && resources.some((resource) => resource.kind === preferred)) return preferred;
  return RESOURCE_TABS.find((tab) => resources.some((resource) => resource.kind === tab)) ?? DEFAULT_RESOURCE_TAB;
}

/** Cycles resource tabs with wraparound. */
export function adjacentResourceTab(current: ResourceTab, delta: -1 | 1): ResourceTab {
  const index = RESOURCE_TABS.indexOf(current);
  return RESOURCE_TABS[(index + delta + RESOURCE_TABS.length) % RESOURCE_TABS.length] ?? DEFAULT_RESOURCE_TAB;
}

export interface RenderResourceWidgetOptions {
  resources: readonly SessionResource[];
  width: number;
  expanded: boolean;
  activeTab: ResourceTab;
  interactive?: boolean;
  theme: Theme;
}

/** Renders one tab of the compact or expanded resource widget without exceeding terminal width. */
export function renderResourceWidget(options: RenderResourceWidgetOptions): string[] {
  const { resources, width, expanded, activeTab, interactive = false, theme } = options;
  if (width <= 0 || resources.length === 0) return [];

  const activeResources = resources.filter((resource) => resource.kind === activeTab);
  const lines = [
    renderBorder(width, theme),
    renderTabBar({ resources, activeTab, width, theme }),
    "",
  ];
  const contentWidth = Math.max(0, width - 1);
  const limit = expanded ? EXPANDED_RESOURCE_LIMIT : COMPACT_RESOURCE_LIMIT;

  if (activeResources.length === 0) {
    lines.push(` ${truncateToWidth(theme.fg("dim", i18n.t("emptyTab")), contentWidth, "…")}`);
  } else {
    for (const resource of activeResources.slice(0, limit)) {
      lines.push(` ${renderResourceLine(resource, contentWidth, theme)}`);
    }
  }

  const hiddenCount = activeResources.length - limit;
  if (hiddenCount > 0) {
    const key = expanded ? "olderResources" : "moreResources";
    lines.push(` ${truncateToWidth(theme.fg("dim", i18n.t(key, { count: hiddenCount })), contentWidth, "…")}`);
  }

  const footer = interactive
    ? i18n.t("browserHint", { expansionHint: expansionHint(expanded) })
    : i18n.t("widgetHint", { expansionHint: expansionHint(expanded) });
  lines.push(renderBorder(width, theme));
  lines.push(` ${truncateToWidth(theme.fg("dim", footer), contentWidth, "…")}`);
  return lines;
}
