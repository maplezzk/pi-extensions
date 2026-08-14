import { pathToFileURL } from "node:url";
import { fuzzyFilter, hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import type { ResourceAction, ResourceKind, SessionResource } from "./collector.ts";
import { i18n } from "./i18n.ts";

export const RESOURCE_AUTOCOMPLETE_LIMIT = 12;
const ANSI_RESET = "\x1b[0m";
const ANSI_FOREGROUND_RGB_MODE = 38;
const ANSI_TRUECOLOR_MODE = 2;

/** One RGB truecolor escape; fixed values match the subagent widget approach. */
function rgb(red: number, green: number, blue: number): string {
  return `\x1b[${ANSI_FOREGROUND_RGB_MODE};${ANSI_TRUECOLOR_MODE};${red};${green};${blue}m`;
}

/** Wraps text in one fixed RGB foreground color. */
function tinted(start: string, text: string): string {
  return `${start}${text}${ANSI_RESET}`;
}

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

/** Builds one foreground escape from a palette entry. */
function foreground(color: RgbColor): string {
  return rgb(color.red, color.green, color.blue);
}

/** Fixed palette shared by picker accents; mid-tones stay readable on light and dark themes. */
const PALETTE = {
  file: foreground({ red: 77, green: 163, blue: 255 }),
  review: foreground({ red: 198, green: 140, blue: 231 }),
  web: foreground({ red: 38, green: 171, blue: 184 }),
  actionRead: foreground({ red: 96, green: 139, blue: 190 }),
  actionChanged: foreground({ red: 214, green: 149, blue: 52 }),
  actionInspected: foreground({ red: 148, green: 159, blue: 177 }),
  actionOpened: foreground({ red: 38, green: 171, blue: 184 }),
  actionCreated: foreground({ red: 64, green: 168, blue: 99 }),
  actionReferenced: foreground({ red: 148, green: 159, blue: 177 }),
  usageCount: foreground({ red: 148, green: 159, blue: 177 }),
} as const;

/** Per-action semantic colors; write operations stand out, reads stay quiet. */
const ACTION_COLORS: Record<ResourceAction, string> = {
  read: PALETTE.actionRead,
  changed: PALETTE.actionChanged,
  inspected: PALETTE.actionInspected,
  opened: PALETTE.actionOpened,
  created: PALETTE.actionCreated,
  referenced: PALETTE.actionReferenced,
};
const RESOURCE_QUERY_PATTERN = /(?:^|[\t ])#([^\s#]*)$/;
const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  file: "FILE",
  review: "PR/MR",
  web: "URL",
};
const ACTION_LABELS: Record<ResourceAction, string> = {
  read: "actionRead",
  changed: "actionChanged",
  inspected: "actionInspected",
  opened: "actionOpened",
  created: "actionCreated",
  referenced: "actionReferenced",
};

export interface ResourceSuggestion {
  value: string;
  label: string;
  /** Visible width of the plain label, for layout around OSC 8 sequences. */
  labelWidth: number;
  description: string;
}

export const KIND_COLORS: Record<ResourceKind, string> = {
  file: PALETTE.file,
  review: PALETTE.review,
  web: PALETTE.web,
};

/** Colorizes plain text with the resource type's accent; ANSI input passes through unchanged. */
export function kindColored(kind: ResourceKind, text: string): string {
  if (text.includes("\x1b")) return text;
  return tinted(KIND_COLORS[kind], text);
}

/** Extracts the resource query only when # starts the token under the cursor. */
export function extractResourceQuery(textBeforeCursor: string): string | undefined {
  return textBeforeCursor.match(RESOURCE_QUERY_PATTERN)?.[1];
}

/** Returns the OSC 8 target for a resource while safely encoding file paths. */
function resourceUri(resource: SessionResource): string | undefined {
  if (resource.kind !== "file") return resource.target;
  try {
    return pathToFileURL(resource.target).href;
  } catch {
    return undefined;
  }
}

/** Quotes references containing whitespace so the inserted # expression stays readable. */
function resourceReference(resource: SessionResource): string {
  const target = resource.kind === "file" ? resource.label : resource.target;
  if (!/\s/.test(target)) return `#${target}`;
  const escaped = target.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `#"${escaped}"`;
}

/** Builds searchable text without exposing ANSI sequences to fuzzy matching. */
function resourceSearchText(resource: SessionResource): string {
  const actionLabels = resource.actions.map((action) => i18n.t(ACTION_LABELS[action]));
  return [
    resource.label,
    resource.target,
    resource.kind,
    RESOURCE_KIND_LABELS[resource.kind],
    ...resource.actions,
    ...actionLabels,
    ...resource.tools,
  ].join(" ");
}

/** Formats one resource as a clickable picker row without repeating the active tab type. */
function resourceItem(resource: SessionResource): ResourceSuggestion {
  const uri = resourceUri(resource);
  const actions = resource.actions
    .map((action) => tinted(ACTION_COLORS[action], i18n.t(ACTION_LABELS[action])))
    .join(" · ");
  const usage = resource.seenCount > 1 ? tinted(PALETTE.usageCount, ` · ×${resource.seenCount}`) : "";
  const label = resource.label;
  return {
    value: resourceReference(resource),
    label: uri ? hyperlink(label, uri) : label,
    labelWidth: visibleWidth(label),
    description: `${actions}${usage}`,
  };
}

/** Filters recent resources with Pi's fuzzy matcher and caps the result set. */
export function resourceSuggestions(
  resources: readonly SessionResource[],
  query: string,
): ResourceSuggestion[] {
  const matches = query
    ? fuzzyFilter([...resources], query, resourceSearchText)
    : [...resources];
  return matches.slice(0, RESOURCE_AUTOCOMPLETE_LIMIT).map(resourceItem);
}
