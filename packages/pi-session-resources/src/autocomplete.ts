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

/** Single fixed subagent blue accent; readable on light and dark themes. */
const ACCENT = foreground({ red: 77, green: 163, blue: 255 });
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
  file: ACCENT,
  review: ACCENT,
  web: ACCENT,
};

/** Colorizes plain text with the shared blue accent. */
export function kindColored(kind: ResourceKind, text: string): string {
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
  const actions = resource.actions.map((action) => i18n.t(ACTION_LABELS[action])).join(" · ");
  const usage = resource.seenCount > 1 ? ` · ×${resource.seenCount}` : "";
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
