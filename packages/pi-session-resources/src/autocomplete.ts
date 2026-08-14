import { pathToFileURL } from "node:url";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter, hyperlink } from "@earendil-works/pi-tui";
import type { ResourceAction, ResourceKind, SessionResource } from "./collector.ts";
import { i18n } from "./i18n.ts";

export const RESOURCE_AUTOCOMPLETE_LIMIT = 12;
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
function resourceItem(resource: SessionResource): AutocompleteItem {
  const uri = resourceUri(resource);
  const actions = resource.actions.map((action) => i18n.t(ACTION_LABELS[action])).join(" · ");
  const usage = resource.seenCount > 1 ? ` · ×${resource.seenCount}` : "";
  return {
    value: resourceReference(resource),
    label: uri ? hyperlink(resource.label, uri) : resource.label,
    description: `${actions}${usage}`,
  };
}

/** Filters recent resources with Pi's fuzzy matcher and caps the result set. */
export function resourceSuggestions(
  resources: readonly SessionResource[],
  query: string,
): AutocompleteItem[] {
  const matches = query
    ? fuzzyFilter([...resources], query, resourceSearchText)
    : [...resources];
  return matches.slice(0, RESOURCE_AUTOCOMPLETE_LIMIT).map(resourceItem);
}
