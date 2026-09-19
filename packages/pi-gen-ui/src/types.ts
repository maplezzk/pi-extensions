import type { ActionBinding, Spec, StateModel, UIElement } from "@json-render/core";

/**
 * A resolved element ready to render: props already resolved through the state
 * store, children already flattened (repeat expansion included).
 */
export interface RenderedNode {
  /** Element key from the flat spec map. */
  key: string;
  /** Source element. */
  element: UIElement;
  /** Props with `$state` / `$item` / `$index` / `$cond` expressions resolved. */
  props: Record<string, unknown>;
  /** Prop name → absolute state path, for `$bindState` / `$bindItem` props. */
  bindings: Record<string, string> | undefined;
  /** Inline (default slot) children. */
  children: RenderedNode[];
  /** Named slot children, when the spec uses `slots`. */
  slots: Record<string, RenderedNode[]>;
}

/** A rendered interactive region that can receive keyboard input. */
export interface InteractiveRegion {
  /** Stable id: `elementKey` for the common single-instance case. */
  id: string;
  /** Element key the region belongs to. */
  elementKey: string;
  /** Component name, for diagnostics. */
  component: string;
  /** Lines occupied by the region, relative to the rendered panel. */
  height: number;
  /** Handle a key press; return true when the input was consumed. */
  handleInput(data: string): boolean;
}

/** Options that shape one render pass. */
export interface RenderContext {
  /** Current resolved spec. */
  spec: Spec;
  /** Live state snapshot. */
  state: StateModel;
  /** Write a value into the state store and request a re-render. */
  setState(path: string, value: unknown): void;
  /** Push into an array at a state path. */
  pushState(path: string, value: unknown, clearPath?: string): void;
  /** Remove an array item at a state path. */
  removeState(path: string, index: number): void;
  /** Run an `on` / `watch` action binding for an element. */
  dispatch(elementKey: string, event: string, binding: ActionBinding | ActionBinding[]): void;
  /** True while the tool call is still streaming, so animated components may spin. */
  animating: boolean;
  /** Element keys that currently own keyboard focus, in priority order. */
  focusOrder: readonly string[];
  /** True when Pi owns the hardware cursor, so a component may emit CURSOR_MARKER. */
  hardwareCursor: boolean;
  /** Per-element ephemeral UI state that is not part of the spec's state model. */
  local: ReadonlyMap<string, unknown>;
  /**
   * Write ephemeral UI state. Unlike a raw map write this bumps a version, so
   * a host that processes keys faster than it re-renders still picks up cursor
   * changes before running the next input handler.
   */
  setLocal(key: string, value: unknown): void;
  /** Register an interactive region discovered during rendering. */
  registerInteractive(region: InteractiveRegion): void;
  /** Component registry, so nested layout components can render individual children. */
  components: ComponentRegistry;
  /** Record a non-fatal problem; returned to the model with the tool result. */
  warn(message: string): void;
}

/** Render a resolved node at a given width into terminal lines. */
export type NodeRenderer = (node: RenderedNode, width: number, ctx: RenderContext) => string[];

/** Arguments handed to one component implementation. */
export interface ComponentArgs {
  node: RenderedNode;
  width: number;
  ctx: RenderContext;
  /** Render the inline children and return their lines. */
  children(width: number): string[];
  /** Render a named slot and return its lines. */
  slot(name: string, width: number): string[];
}

/** A component implementation. */
export type ComponentRenderer = (args: ComponentArgs) => string[];

/** Component registry keyed by catalog component name. */
export type ComponentRegistry = Record<string, ComponentRenderer>;
