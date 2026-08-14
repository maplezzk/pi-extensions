import { pathToFileURL } from "node:url";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { fuzzyFilter, hyperlink, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import type { ResourceAction, ResourceKind, SessionResource } from "./collector.ts";
import { i18n } from "./i18n.ts";

export const RESOURCE_AUTOCOMPLETE_LIMIT = 12;
const RESOURCE_QUERY_PATTERN = /(?:^|[\t ])#([^\s#]*)$/;
const NEXT_CANDIDATE_INPUT = "\x1b[B";
const PREVIOUS_CANDIDATE_INPUT = "\x1b[A";
const RESOURCE_ICONS: Record<ResourceKind, string> = {
  file: "▤",
  review: "⎇",
  web: "◎",
};
const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
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

export interface ResourceAutocompleteState {
  active: boolean;
}

interface CreateResourceAutocompleteProviderOptions {
  current: AutocompleteProvider;
  getResources: () => readonly SessionResource[];
  onActiveChange: (active: boolean) => void;
}

interface ApplyResourceCompletionOptions {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  item: AutocompleteItem;
  prefix: string;
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

/** Formats one resource as a clickable built-in autocomplete row. */
function resourceItem(resource: SessionResource): AutocompleteItem {
  const display = `${RESOURCE_KIND_LABELS[resource.kind]} ${RESOURCE_ICONS[resource.kind]} ${resource.label}`;
  const uri = resourceUri(resource);
  const actions = resource.actions.map((action) => i18n.t(ACTION_LABELS[action])).join(" · ");
  const usage = resource.seenCount > 1 ? ` · ×${resource.seenCount}` : "";
  return {
    value: resourceReference(resource),
    label: uri ? hyperlink(display, uri) : display,
    description: `${actions}${usage}`,
  };
}

/** Filters recent resources with Pi's fuzzy matcher and caps the popup height. */
export function resourceSuggestions(
  resources: readonly SessionResource[],
  query: string,
): AutocompleteItem[] {
  const matches = query
    ? fuzzyFilter([...resources], query, resourceSearchText)
    : [...resources];
  return matches.slice(0, RESOURCE_AUTOCOMPLETE_LIMIT).map(resourceItem);
}

/** Applies a # resource completion and leaves the editor ready for continued typing. */
export function applyResourceCompletion(options: ApplyResourceCompletionOptions): {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
} {
  const { lines, cursorLine, cursorCol, item, prefix } = options;
  const currentLine = lines[cursorLine] ?? "";
  const beforePrefix = currentLine.slice(0, Math.max(0, cursorCol - prefix.length));
  const afterCursor = currentLine.slice(cursorCol);
  const needsSpace = afterCursor.length === 0 || !/^[\s,.;:!?)]/.test(afterCursor);
  const suffix = needsSpace ? " " : "";
  const nextLines = [...lines];
  nextLines[cursorLine] = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
  return {
    lines: nextLines,
    cursorLine,
    cursorCol: beforePrefix.length + item.value.length + suffix.length,
  };
}

/** Layers # resource completion over Pi's existing slash, path, and @ providers. */
export function createResourceAutocompleteProvider(
  options: CreateResourceAutocompleteProviderOptions,
): AutocompleteProvider {
  const { current, getResources, onActiveChange } = options;
  let resourceSuggestionsActive = false;

  /** Keeps Tab routing synchronized with the currently visible resource popup. */
  function setActive(active: boolean): void {
    resourceSuggestionsActive = active;
    onActiveChange(active);
  }

  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "#"])],
    async getSuggestions(lines, cursorLine, cursorCol, request): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? "";
      const query = extractResourceQuery(currentLine.slice(0, cursorCol));
      if (query === undefined) {
        setActive(false);
        return current.getSuggestions(lines, cursorLine, cursorCol, request);
      }

      const items = resourceSuggestions(getResources(), query);
      if (request.signal.aborted || items.length === 0) {
        setActive(false);
        return current.getSuggestions(lines, cursorLine, cursorCol, request);
      }

      setActive(true);
      return { items, prefix: `#${query}` };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!resourceSuggestionsActive) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      setActive(false);
      return applyResourceCompletion({ lines, cursorLine, cursorCol, item, prefix });
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

/** Rewrites Tab into wrapped candidate navigation while the # popup is active. */
export function routeResourceAutocompleteInput(
  data: string,
  state: ResourceAutocompleteState,
): { consume?: boolean; data?: string } | undefined {
  if (!state.active || isKeyRelease(data)) return undefined;
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
    state.active = false;
    return undefined;
  }
  if (matchesKey(data, Key.shift("tab"))) return { data: PREVIOUS_CANDIDATE_INPUT };
  if (matchesKey(data, Key.tab)) return { data: NEXT_CANDIDATE_INPUT };
  return undefined;
}
