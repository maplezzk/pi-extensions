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
const FRAME_EDGE_WIDTH = 2;
const RESOURCE_ROW_HORIZONTAL_PADDING = 2;
const TOOLS_EXPAND_KEYBINDING = "app.tools.expand";
const TAB_LABELS: Record<ResourceTab, string> = {
  file: "FILE",
  review: "PR/MR",
  web: "WEB",
};
const RESOURCE_ICONS: Record<ResourceTab, string> = {
  file: "▤",
  review: "⎇",
  web: "◎",
};

const ACTION_LABELS: Record<ResourceAction, string> = {
  read: "actionRead",
  changed: "actionChanged",
  inspected: "actionInspected",
  opened: "actionOpened",
  created: "actionCreated",
  referenced: "actionReferenced",
};

type BorderColor = "border" | "borderAccent";

/** Converts a resource target to the URI consumed by OSC 8. */
function resourceUri(resource: SessionResource): string | undefined {
  if (resource.kind !== "file") return resource.target;
  try {
    return pathToFileURL(resource.target).href;
  } catch {
    return undefined;
  }
}

/** Colors each resource icon without assigning status semantics to the label. */
function resourceIcon(resource: SessionResource, theme: Theme): string {
  const icon = RESOURCE_ICONS[resource.kind];
  if (resource.kind === "review") return theme.fg("accent", icon);
  if (resource.kind === "web") return theme.fg("mdLink", icon);
  return theme.fg("toolTitle", icon);
}

/** Formats at most two actions so narrow widget rows remain useful. */
function actionLabel(resource: SessionResource): string {
  return resource.actions
    .slice(0, MAX_ACTION_LABELS)
    .map((action) => i18n.t(ACTION_LABELS[action]))
    .join(" · ");
}

/** Uses Pi's configured expansion key, falling back to the standard command when unbound. */
function expansionHint(expanded: boolean): string {
  const shortcut = keyText(TOOLS_EXPAND_KEYBINDING);
  if (!shortcut) return i18n.t(expanded ? "collapseCommand" : "expandCommand");
  return i18n.t(expanded ? "collapseShortcut" : "expandShortcut", { shortcut });
}

/** Renders one width-safe OSC 8 resource row. */
function renderResourceLine(resource: SessionResource, width: number, theme: Theme): string {
  const prefix = `${resourceIcon(resource, theme)} `;
  const suffix = theme.fg("muted", `  [${actionLabel(resource)}]`);
  const reservedWidth = visibleWidth(prefix) + visibleWidth(suffix);
  if (width <= reservedWidth) {
    return truncateToWidth(`${RESOURCE_ICONS[resource.kind]} [${actionLabel(resource)}]`, width, "");
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

  const pieces = [theme.fg("dim", " ‹ ")];
  for (const tab of RESOURCE_TABS) {
    const count = counts.get(tab) ?? 0;
    const segment = ` ${RESOURCE_ICONS[tab]} ${TAB_LABELS[tab]} ${count} `;
    pieces.push(
      tab === activeTab
        ? theme.bg("selectedBg", theme.fg("accent", theme.bold(segment)))
        : theme.fg(count > 0 ? "muted" : "dim", segment),
    );
    pieces.push(" ");
  }
  pieces.push(theme.fg("dim", "› "));
  return truncateToWidth(pieces.join(""), width, "");
}

/** Renders the titled top edge of the resource card. */
function renderTopBorder(width: number, theme: Theme, borderColor: BorderColor): string {
  if (width <= 0) return "";
  if (width === 1) return theme.fg(borderColor, "─");

  const innerWidth = width - FRAME_EDGE_WIDTH;
  const title = truncateToWidth(` ◆ ${i18n.t("panelTitle")} `, innerWidth, "");
  const remainder = "─".repeat(Math.max(0, innerWidth - visibleWidth(title)));
  return `${theme.fg(borderColor, "╭")}${theme.fg("accent", theme.bold(title))}${theme.fg(borderColor, `${remainder}╮`)}`;
}

interface RenderFrameRowOptions {
  content: string;
  width: number;
  theme: Theme;
  borderColor: BorderColor;
}

/** Pads one content row between vertical card edges without breaking ANSI or OSC 8 sequences. */
function renderFrameRow(options: RenderFrameRowOptions): string {
  const { content, width, theme, borderColor } = options;
  if (width <= 0) return "";
  if (width === 1) return theme.fg(borderColor, "│");

  const innerWidth = width - FRAME_EDGE_WIDTH;
  return `${theme.fg(borderColor, "│")}${truncateToWidth(content, innerWidth, "", true)}${theme.fg(borderColor, "│")}`;
}

/** Separates resource content from keyboard hints. */
function renderSeparator(width: number, theme: Theme, borderColor: BorderColor): string {
  if (width <= 0) return "";
  if (width === 1) return theme.fg(borderColor, "│");
  return theme.fg(borderColor, `├${"─".repeat(Math.max(0, width - FRAME_EDGE_WIDTH))}┤`);
}

/** Closes the resource card. */
function renderBottomBorder(width: number, theme: Theme, borderColor: BorderColor): string {
  if (width <= 0) return "";
  if (width === 1) return theme.fg(borderColor, "─");
  return theme.fg(borderColor, `╰${"─".repeat(Math.max(0, width - FRAME_EDGE_WIDTH))}╯`);
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

/** Renders one tab as a framed compact or expanded resource card. */
export function renderResourceWidget(options: RenderResourceWidgetOptions): string[] {
  const { resources, width, expanded, activeTab, interactive = false, theme } = options;
  if (width <= 0 || resources.length === 0) return [];

  const activeResources = resources.filter((resource) => resource.kind === activeTab);
  const borderColor: BorderColor = interactive ? "borderAccent" : "border";
  const innerWidth = Math.max(0, width - FRAME_EDGE_WIDTH);
  const resourceWidth = Math.max(0, innerWidth - RESOURCE_ROW_HORIZONTAL_PADDING);
  const lines = [
    renderTopBorder(width, theme, borderColor),
    renderFrameRow({
      content: renderTabBar({ resources, activeTab, width: innerWidth, theme }),
      width,
      theme,
      borderColor,
    }),
  ];
  const limit = expanded ? EXPANDED_RESOURCE_LIMIT : COMPACT_RESOURCE_LIMIT;

  if (activeResources.length === 0) {
    lines.push(
      renderFrameRow({
        content: ` ${theme.fg("dim", i18n.t("emptyTab"))}`,
        width,
        theme,
        borderColor,
      }),
    );
  } else {
    for (const resource of activeResources.slice(0, limit)) {
      lines.push(
        renderFrameRow({
          content: ` ${renderResourceLine(resource, resourceWidth, theme)} `,
          width,
          theme,
          borderColor,
        }),
      );
    }
  }

  const hiddenCount = activeResources.length - limit;
  if (hiddenCount > 0) {
    const key = expanded ? "olderResources" : "moreResources";
    lines.push(
      renderFrameRow({
        content: ` ${theme.fg("dim", i18n.t(key, { count: hiddenCount }))}`,
        width,
        theme,
        borderColor,
      }),
    );
  }

  const footer = interactive
    ? i18n.t("browserHint", { expansionHint: expansionHint(expanded) })
    : i18n.t("widgetHint", { expansionHint: expansionHint(expanded) });
  lines.push(renderSeparator(width, theme, borderColor));
  lines.push(
    renderFrameRow({
      content: ` ${theme.fg("dim", footer)}`,
      width,
      theme,
      borderColor,
    }),
  );
  lines.push(renderBottomBorder(width, theme, borderColor));
  return lines;
}
