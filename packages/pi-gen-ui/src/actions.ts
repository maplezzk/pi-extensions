import { addByPath, getByPath, resolveActionParam, resolvePropValue, setByPath } from "@json-render/core";
import type { ActionBinding, PropResolutionContext } from "@json-render/core";

/** State mutations the built-in actions perform. */
export interface ActionRuntime {
  /** Replace the value at a JSON Pointer path. */
  set(path: string, value: unknown): void;
  /**
   * Append to the array at a JSON Pointer path.
   *
   * Returns a diagnostic when the path holds something that is not an array,
   * so the failure can be surfaced instead of silently discarding data.
   */
  push(path: string, value: unknown, clearPath?: string): string | undefined;
  /** Remove an array item by index. */
  remove(path: string, index: number): void;
}

/** Custom action handler registered by an embedder. */
export type ActionHandler = (params: Record<string, unknown>, elementKey: string) => void | Promise<void>;

/** Options for running one element event. */
export interface RunActionOptions {
  /** Binding declared on the element's `on` field; arrays run in order. */
  binding: ActionBinding | ActionBinding[];
  /** Element key that raised the event, for diagnostics. */
  elementKey: string;
  /** Prop resolution context, so action params can use `$state` / `$item`. */
  context: PropResolutionContext;
  /** Where built-in state actions write. */
  runtime: ActionRuntime;
  /** Custom handlers, keyed by action name. */
  handlers: Readonly<Record<string, ActionHandler>>;
  /** Report an unusable binding; never throw for spec-level mistakes. */
  warn(message: string): void;
}

/** Generate an id for `pushState` values that ask for one with `"$id"`. */
function generateId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Math.floor(Math.random() * 1e12).toString(36)}`;
}

/** Replace `"$id"` placeholder values inside a pushed value with a fresh id. */
function withGeneratedId(value: unknown, id: string): unknown {
  if (value === "$id") return id;
  if (Array.isArray(value)) return value.map((item) => withGeneratedId(item, id));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, withGeneratedId(item, id)]));
  }
  return value;
}

/** Read a string param, or undefined when it is missing or the wrong type. */
function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Run one binding. Returns normally even when the binding is unusable. */
async function runBinding(options: RunActionOptions, binding: ActionBinding): Promise<void> {
  const { elementKey, context, runtime, handlers, warn } = options;
  const name = typeof binding.action === "string" ? binding.action : "";
  if (!name) {
    warn(`Element "${elementKey}" has an "on" binding without an action name; the binding was ignored.`);
    return;
  }
  if (binding.confirm || binding.onSuccess || binding.onError) {
    warn(
      `Element "${elementKey}" uses "confirm"/"onSuccess"/"onError" on action "${name}". Pi panels do not run follow-up handler chains, so those fields were ignored.`,
    );
  }

  const rawParams = (binding.params ?? {}) as Record<string, unknown>;
  const resolved = Object.fromEntries(
    Object.entries(rawParams).map(([key, value]) => [key, resolveActionParam(value, context)]),
  );

  try {
    switch (name) {
      case "setState": {
        const path = stringParam(resolved, "statePath");
        if (!path) {
          warn(`Element "${elementKey}" called setState without a "statePath"; nothing changed.`);
          return;
        }
        runtime.set(path, resolvePropValue(rawParams.value, context));
        return;
      }
      case "pushState": {
        const path = stringParam(resolved, "statePath");
        if (!path) {
          warn(`Element "${elementKey}" called pushState without a "statePath"; nothing changed.`);
          return;
        }
        const id = generateId();
        const value = withGeneratedId(resolvePropValue(rawParams.value, context), id);
        const clearPath = stringParam(resolved, "clearStatePath");
        const issue = runtime.push(path, value, clearPath);
        if (issue) warn(`Element "${elementKey}": ${issue}`);
        return;
      }
      case "removeState": {
        const path = stringParam(resolved, "statePath");
        const index = resolved.index;
        if (!path || typeof index !== "number") {
          warn(`Element "${elementKey}" called removeState without a numeric "index"; nothing changed.`);
          return;
        }
        runtime.remove(path, index);
        return;
      }
      default: {
        const handler = handlers[name];
        if (!handler) {
          warn(
            `Element "${elementKey}" triggered unknown action "${name}". Register a handler or use setState/pushState/removeState.`,
          );
          return;
        }
        await handler(resolved, elementKey);
      }
    }
  } catch (error) {
    warn(
      `Action "${name}" on element "${elementKey}" failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Run one element event, sequentially for binding arrays. */
export async function runAction(options: RunActionOptions): Promise<void> {
  const bindings = Array.isArray(options.binding) ? options.binding : [options.binding];
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") {
      options.warn(`Element "${options.elementKey}" has a malformed "on" binding; it was ignored.`);
      continue;
    }
    await runBinding(options, binding as ActionBinding);
  }
}

/** Apply a `setState` write through a plain JSON Pointer path. */
export function applySet(state: Record<string, unknown>, path: string, value: unknown): void {
  setByPath(state, path, value);
}

/**
 * Apply a `pushState` write.
 *
 * RFC 6902 "add" on an existing member replaces it, so appending needs the
 * `/-` array tail. A missing path is initialized to a single-item array; a path
 * holding a non-array is reported instead of overwritten.
 */
export function applyPush(state: Record<string, unknown>, path: string, value: unknown): string | undefined {
  const current = getByPath(state, path);
  if (current === undefined) {
    addByPath(state, path, [value]);
    return undefined;
  }
  if (Array.isArray(current)) {
    addByPath(state, `${path}/-`, value);
    return undefined;
  }
  return `pushState target "${path}" is not an array (found ${typeof current}); nothing was appended.`;
}

/** Apply a `removeState` write: drop one array item by index. */
export function applyRemove(state: Record<string, unknown>, path: string, index: number): void {
  const current = getByPath(state, path);
  if (!Array.isArray(current)) return;
  setByPath(
    state,
    path,
    current.filter((_item, position) => position !== index),
  );
}
