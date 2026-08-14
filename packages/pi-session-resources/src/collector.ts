import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ResourceKind = "file" | "review" | "web";
export type ResourceAction = "read" | "changed" | "inspected" | "opened" | "created" | "referenced";

export interface SessionResource {
  key: string;
  kind: ResourceKind;
  target: string;
  label: string;
  actions: ResourceAction[];
  tools: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
}

export interface ToolObservation {
  toolName: string;
  input: Record<string, unknown>;
  content?: unknown;
  details?: unknown;
  cwd: string;
  timestamp: number;
  includeInput?: boolean;
}

export interface ResourceObservation {
  kind: ResourceKind;
  target: string;
  label: string;
  action: ResourceAction;
  toolName: string;
  timestamp: number;
}

interface CollectOperationStringsOptions {
  value: unknown;
  key?: string;
  output: string[];
  seen: WeakSet<object>;
  depth?: number;
}

interface PushFileObservationOptions {
  observations: ResourceObservation[];
  rawPath: string;
  source: "input" | "output";
  context: ToolObservation;
  action: ResourceAction;
}

interface PushUrlObservationOptions {
  observations: ResourceObservation[];
  rawUrl: string;
  context: ToolObservation;
  createsReview: boolean;
  opensBrowser: boolean;
}

interface ScanValueOptions {
  value: unknown;
  key?: string;
  source: "input" | "output";
  context: ToolObservation;
  action: ResourceAction;
  createsReview: boolean;
  opensBrowser: boolean;
  looseUrls: boolean;
  loosePaths: boolean;
  observations: ResourceObservation[];
  seen: WeakSet<object>;
  depth?: number;
}

const ACTION_ORDER: ResourceAction[] = ["changed", "created", "opened", "read", "inspected", "referenced"];
const MAX_SCAN_CHARS = 100_000;
const MAX_SCAN_DEPTH = 8;
const BASH_TOOL_NAME = "bash";
const WINDOWS_PLATFORM = "win32";
const WINDOWS_DRIVE_PREFIX_PATTERN = /^[A-Za-z]:[\\/]/;
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const FILE_URL_PATTERN = /file:\/\/[^\s<>"'`]+/g;
const POSIX_PATH_PATTERN = /(?:^|[\s"'`([{<])((?:~\/|\/)[^\s"'`<>)}\]]+)/g;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s<>"'`]+/g;
const REVIEW_CREATION_PATTERN = /(?:^|[^a-z0-9])(?:gh\s+pr\s+create|glab\s+mr\s+create|(?:create|open)[-_ ]?(?:pull|merge)[-_ ]?request|(?:pull|merge)[-_ ]?request[-_ ]?(?:create|open))(?:$|[^a-z0-9])/i;
const BROWSER_OPEN_PATTERN = /(?:browser|chrome|playwright|navigate|go[_-]?to|visit|open[_-]?(?:url|page|browser)|new[_-]?page)/i;

const PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "filepaths",
  "filename",
  "filenames",
  "directory",
  "directories",
  "directorypath",
  "folder",
  "folders",
  "folderpath",
  "sourcepath",
  "targetpath",
  "destinationpath",
  "inputpath",
  "outputpath",
  "sourcefile",
  "targetfile",
  "destinationfile",
  "inputfile",
  "outputfile",
]);

const URL_KEYS = new Set([
  "url",
  "uri",
  "href",
  "link",
  "weburl",
  "htmlurl",
  "browserurl",
  "pageurl",
]);

const OPERATION_KEYS = new Set([
  "tool",
  "toolname",
  "name",
  "action",
  "operation",
  "method",
  "command",
]);

const BUILTIN_FILE_ACTIONS: Record<string, ResourceAction> = {
  read: "read",
  write: "changed",
  edit: "changed",
  grep: "inspected",
  find: "inspected",
  ls: "inspected",
};

/** Removes common prose punctuation before path or URL parsing. */
function sanitizeToken(raw: string): string {
  let value = raw.trim().replace(/^[@"'`(<\[]+/, "");
  value = value.replace(/[>"'`,;.\])}]+$/, "");
  return value;
}

/** Prevents control sequences from reaching terminal-rendered labels. */
function sanitizeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/** Strips editor-style line and column suffixes from file references. */
function stripLineSuffix(value: string): string {
  let result = value.replace(/#L\d+(?:C\d+)?$/i, "");
  const lastSeparator = Math.max(result.lastIndexOf("/"), result.lastIndexOf("\\"));
  const lastColon = result.lastIndexOf(":");
  if (lastColon > lastSeparator && /^\d+(?::\d+)?$/.test(result.slice(lastColon + 1))) {
    result = result.slice(0, lastColon);
  }
  return result;
}

/** Resolves a path against the session cwd and canonicalizes existing files. */
function normalizeFilePath(raw: string, cwd: string, allowMissing: boolean): string | undefined {
  let candidate = sanitizeToken(raw);
  if (!candidate) return undefined;

  if (candidate.startsWith("file://")) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return undefined;
    }
  }

  candidate = stripLineSuffix(candidate);
  if (!candidate || candidate.includes("\n") || candidate.includes("\r")) return undefined;
  if (WINDOWS_DRIVE_PREFIX_PATTERN.test(candidate) && process.platform !== WINDOWS_PLATFORM) return undefined;
  if (candidate === "~") candidate = homedir();
  else if (candidate.startsWith("~/")) candidate = resolve(homedir(), candidate.slice(2));
  else if (!isAbsolute(candidate)) candidate = resolve(cwd, candidate);

  const resolved = normalize(candidate);
  if (!allowMissing && !existsSync(resolved)) return undefined;

  if (existsSync(resolved)) {
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  }
  return resolved;
}

/** Prefers a project-relative label while preserving out-of-tree absolute paths. */
function displayFilePath(target: string, cwd: string): string {
  const relativePath = relative(cwd, target);
  if (relativePath && !relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath)) {
    return sanitizeLabel(relativePath);
  }
  return sanitizeLabel(target);
}

/** Accepts only normalized HTTP(S) URLs suitable for OSC 8 links. */
function normalizeWebUrl(raw: string): string | undefined {
  const candidate = sanitizeToken(raw);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

/** Recognizes GitHub PR and GitLab MR URLs; all other HTTP URLs are web resources. */
function classifyUrl(target: string): ResourceKind {
  const parsed = new URL(target);
  if (/^\/[^?#]+\/-\/merge_requests\/\d+\/?$/i.test(parsed.pathname)) return "review";
  if (/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/i.test(parsed.pathname)) return "review";
  return "web";
}

/** Builds a concise, query-free label without changing the link target. */
function displayUrl(target: string, kind: ResourceKind): string {
  const parsed = new URL(target);
  let pathname = parsed.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Keep the encoded pathname when a remote emitted malformed escapes.
  }
  pathname = pathname.replace(/\/$/, "");

  if (kind === "review") {
    const github = pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i);
    if (github) return sanitizeLabel(`${github[1]}/${github[2]}#${github[3]}`);

    const gitlab = pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)$/i);
    if (gitlab) return sanitizeLabel(`${gitlab[1]}!${gitlab[2]}`);
  }

  const host = parsed.hostname.replace(/^www\./, "");
  return sanitizeLabel(pathname ? `${host}${pathname}` : host);
}

/** Normalizes heterogeneous tool argument keys for path-key matching. */
function normalizeKey(key: string | undefined): string {
  return (key ?? "").replace(/[-_.]/g, "").toLowerCase();
}

/** Checks whether an argument key conventionally contains filesystem paths. */
function isPathKey(key: string | undefined): boolean {
  return PATH_KEYS.has(normalizeKey(key));
}

/** Checks whether an argument key conventionally contains a URL. */
function isUrlKey(key: string | undefined): boolean {
  return URL_KEYS.has(normalizeKey(key));
}

/** Checks whether an argument key names a tool operation rather than arbitrary prose. */
function isOperationKey(key: string | undefined): boolean {
  return OPERATION_KEYS.has(normalizeKey(key));
}

/** Infers a generic file action from custom tool naming conventions. */
function inferFileAction(toolName: string): ResourceAction {
  const normalized = toolName.toLowerCase();
  if (/(?:write|edit|patch|create|delete|remove|move|copy|rename|save|upload|screenshot|capture)/.test(normalized)) return "changed";
  if (/(?:read|view|preview|cat|download)/.test(normalized)) return "read";
  if (/(?:grep|find|search|list|scan|inspect|glob|tree|\bls\b)/.test(normalized)) return "inspected";
  if (/(?:open|reveal|quick.?look)/.test(normalized)) return "opened";
  return "referenced";
}

/** Collects bounded operation fields while ignoring descriptions and payload prose. */
function collectOperationStrings(options: CollectOperationStringsOptions): void {
  const { value, key, output, seen, depth = 0 } = options;
  if (depth > MAX_SCAN_DEPTH) return;
  if (typeof value === "string") {
    if (isOperationKey(key)) output.push(value.slice(0, MAX_SCAN_CHARS));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectOperationStrings({ value: item, key, output, seen, depth: depth + 1 });
    }
    return;
  }
  for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
    collectOperationStrings({ value: item, key: childKey, output, seen, depth: depth + 1 });
  }
}

/** Detects successful MR/PR creation intent from the tool name or operation fields. */
function inputCreatesReview(toolName: string, input: Record<string, unknown>): boolean {
  if (REVIEW_CREATION_PATTERN.test(toolName)) return true;
  const operations: string[] = [];
  collectOperationStrings({ value: input, output: operations, seen: new WeakSet() });
  return REVIEW_CREATION_PATTERN.test(operations.join("\n"));
}

/** Detects browser navigation intent in direct or proxy-style operation fields. */
function inputOpensBrowser(toolName: string, input: Record<string, unknown>): boolean {
  if (BROWSER_OPEN_PATTERN.test(toolName)) return true;
  const operations: string[] = [];
  collectOperationStrings({ value: input, output: operations, seen: new WeakSet() });
  return BROWSER_OPEN_PATTERN.test(operations.join("\n"));
}

/** Classifies link activity as created, opened, or merely referenced. */
function linkAction(kind: ResourceKind, createsReview: boolean, opensBrowser: boolean): ResourceAction {
  if (kind === "review" && createsReview) return "created";
  if (opensBrowser) return "opened";
  return "referenced";
}

/** Normalizes one path and records it when it is safe to expose as a file link. */
function pushFileObservation(options: PushFileObservationOptions): void {
  const { observations, rawPath, source, context, action } = options;
  const target = normalizeFilePath(rawPath, context.cwd, source === "input");
  if (!target) return;
  observations.push({
    kind: "file",
    target,
    label: displayFilePath(target, context.cwd),
    action,
    toolName: context.toolName,
    timestamp: context.timestamp,
  });
}

/** Normalizes one HTTP URL and records its review/web classification. */
function pushUrlObservation(options: PushUrlObservationOptions): void {
  const { observations, rawUrl, context, createsReview, opensBrowser } = options;
  const target = normalizeWebUrl(rawUrl);
  if (!target) return;
  const kind = classifyUrl(target);
  observations.push({
    kind,
    target,
    label: displayUrl(target, kind),
    action: linkAction(kind, createsReview, opensBrowser),
    toolName: context.toolName,
    timestamp: context.timestamp,
  });
}

/** Recursively extracts path and URL observations from bounded JSON-like values. */
function scanValue(options: ScanValueOptions): void {
  const {
    value,
    key,
    source,
    context,
    action,
    createsReview,
    opensBrowser,
    looseUrls,
    loosePaths,
    observations,
    seen,
    depth = 0,
  } = options;
  if (depth > MAX_SCAN_DEPTH) return;
  if (typeof value === "string") {
    const text = value.slice(0, MAX_SCAN_CHARS);
    if (looseUrls || isUrlKey(key)) {
      for (const match of text.matchAll(HTTP_URL_PATTERN)) {
        pushUrlObservation({ observations, rawUrl: match[0], context, createsReview, opensBrowser });
      }
    }
    if (loosePaths || isPathKey(key) || isUrlKey(key)) {
      for (const match of text.matchAll(FILE_URL_PATTERN)) {
        pushFileObservation({ observations, rawPath: match[0], source, context, action });
      }
    }
    if (isPathKey(key)) {
      pushFileObservation({ observations, rawPath: text, source, context, action });
    }
    if (loosePaths) {
      for (const match of text.matchAll(POSIX_PATH_PATTERN)) {
        pushFileObservation({ observations, rawPath: match[1], source, context, action });
      }
      for (const match of text.matchAll(WINDOWS_PATH_PATTERN)) {
        pushFileObservation({ observations, rawPath: match[0], source, context, action });
      }
    }
    return;
  }

  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      scanValue({ ...options, value: item, depth: depth + 1 });
    }
    return;
  }

  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    scanValue({ ...options, value: child, key: childKey, depth: depth + 1 });
  }
}

/** Deduplicates repeated discoveries within one tool result. */
function uniqueObservations(observations: ResourceObservation[]): ResourceObservation[] {
  const unique = new Map<string, ResourceObservation>();
  for (const observation of observations) {
    unique.set(`${observation.kind}\u0000${observation.target}\u0000${observation.action}`, observation);
  }
  return [...unique.values()];
}

/** Extracts normalized file, review, and web resources from one successful tool result. */
export function collectToolResources(context: ToolObservation): ResourceObservation[] {
  const observations: ResourceObservation[] = [];
  const createsReview = inputCreatesReview(context.toolName, context.input);
  const opensBrowser = inputOpensBrowser(context.toolName, context.input);
  const inferredAction = BUILTIN_FILE_ACTIONS[context.toolName] ?? inferFileAction(context.toolName);
  const looseUrls = context.toolName === BASH_TOOL_NAME || opensBrowser || createsReview;
  const loosePaths = context.toolName === BASH_TOOL_NAME;

  if (context.includeInput !== false) {
    const builtinAction = BUILTIN_FILE_ACTIONS[context.toolName];
    const builtinPath = context.input.path;
    if (builtinAction && typeof builtinPath === "string") {
      pushFileObservation({
        observations,
        rawPath: builtinPath,
        source: "input",
        context,
        action: builtinAction,
      });
    }
    scanValue({
      value: context.input,
      source: "input",
      context,
      action: inferredAction,
      createsReview,
      opensBrowser,
      looseUrls,
      loosePaths,
      observations,
      seen: new WeakSet(),
    });
  }

  scanValue({
    value: context.content,
    source: "output",
    context,
    action: inferredAction,
    createsReview,
    opensBrowser,
    looseUrls,
    loosePaths: false,
    observations,
    seen: new WeakSet(),
  });
  scanValue({
    value: context.details,
    source: "output",
    context,
    action: inferredAction,
    createsReview,
    opensBrowser,
    looseUrls,
    loosePaths: false,
    observations,
    seen: new WeakSet(),
  });

  return uniqueObservations(observations);
}

/** Returns actions in a stable importance order for compact rendering. */
function sortedActions(actions: Iterable<ResourceAction>): ResourceAction[] {
  const values = new Set(actions);
  return ACTION_ORDER.filter((action) => values.has(action));
}

/** Deduplicates resources and preserves action/source metadata across tool results. */
export class ResourceIndex {
  private readonly resources = new Map<string, SessionResource>();

  /** Removes all resources before a session branch is rebuilt. */
  clear(): void {
    this.resources.clear();
  }

  /** Replaces the index with already-normalized resources from a session rebuild. */
  replace(resources: readonly SessionResource[]): void {
    this.resources.clear();
    for (const resource of resources) {
      this.resources.set(resource.key, {
        ...resource,
        actions: [...resource.actions],
        tools: [...resource.tools],
      });
    }
  }

  /** Merges normalized observations by resource identity. */
  observe(observations: ResourceObservation[]): void {
    for (const observation of observations) {
      const key = `${observation.kind}:${observation.target}`;
      const existing = this.resources.get(key);
      if (!existing) {
        this.resources.set(key, {
          key,
          kind: observation.kind,
          target: observation.target,
          label: observation.label,
          actions: [observation.action],
          tools: [observation.toolName],
          firstSeenAt: observation.timestamp,
          lastSeenAt: observation.timestamp,
          seenCount: 1,
        });
        continue;
      }

      existing.label = observation.label;
      existing.actions = sortedActions([...existing.actions, observation.action]);
      existing.tools = [...new Set([...existing.tools, observation.toolName])].sort();
      existing.firstSeenAt = Math.min(existing.firstSeenAt, observation.timestamp);
      existing.lastSeenAt = Math.max(existing.lastSeenAt, observation.timestamp);
      existing.seenCount += 1;
    }
  }

  /** Returns immutable copies ordered by most recent activity. */
  list(): SessionResource[] {
    return [...this.resources.values()]
      .map((resource) => ({ ...resource, actions: [...resource.actions], tools: [...resource.tools] }))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.label.localeCompare(right.label));
  }
}

interface StoredToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** Narrows stored tool arguments to the object shape expected by collectors. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rebuilds resource state from successful tool results on the active session branch. */
export function collectSessionResources(entries: readonly SessionEntry[], cwd: string): SessionResource[] {
  const calls = new Map<string, StoredToolCall>();

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (block.type !== "toolCall") continue;
      calls.set(block.id, {
        toolName: block.name,
        input: isRecord(block.arguments) ? block.arguments : {},
      });
    }
  }

  const index = new ResourceIndex();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError) continue;
    const call = calls.get(entry.message.toolCallId);
    index.observe(
      collectToolResources({
        toolName: entry.message.toolName || call?.toolName || "unknown",
        input: call?.input ?? {},
        content: entry.message.content,
        details: entry.message.details,
        cwd,
        timestamp: entry.message.timestamp,
      }),
    );
  }

  return index.list();
}
