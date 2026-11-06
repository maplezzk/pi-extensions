import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { createStateStore } from "@json-render/core";
import type { ActionBinding, Spec, StateModel, StateStore } from "@json-render/core";
import { applyPush, applyRemove, applySet, runAction, type ActionHandler } from "./actions.ts";
import { standardComponents } from "./components/index.ts";
import { renderSpec } from "./renderer.ts";
import type { ComponentRegistry, InteractiveRegion, RenderContext } from "./types.ts";

/** Options for a rendered spec view. */
export interface SpecViewOptions {
  /** Spec to render. */
  spec: Spec;
  /** Component registry; defaults to the standard Pi components. */
  components?: ComponentRegistry;
  /** Custom action handlers for actions beyond setState/pushState/removeState. */
  handlers?: Readonly<Record<string, ActionHandler>>;
  /** Called after every state change. */
  onStateChange?(state: StateModel): void;
  /** Called once per non-fatal render problem. */
  onWarn?(message: string): void;
  /** Ask Pi to repaint; wired by the tool that opens the view. */
  requestRender?(): void;
  /** Called when the user dismisses the panel with Escape. */
  onClose?(): void;
  /** Whether animated components should spin. */
  animating?: boolean;
}

/**
 * Renders one json-render spec as a Pi TUI component.
 *
 * The view owns the state store, routes keyboard input to the focused
 * interactive element, and collects warnings so the tool result can report
 * every simplification instead of hiding it.
 */
export class SpecView implements Component, Focusable {
  /** Set by Pi when the view owns keyboard focus; gates hardware cursor placement. */
  focused = false;

  private readonly store: StateStore;
  private readonly components: ComponentRegistry;
  private readonly handlers: Readonly<Record<string, ActionHandler>>;
  private readonly warnings = new Set<string>();
  private readonly local = new Map<string, unknown>();
  private readonly interactive = new Map<string, InteractiveRegion>();

  private focusId: string | undefined;
  private frame = 0;
  private animating: boolean;
  private interacted = false;
  private lastWidth = 80;
  private stateVersion = 0;
  private renderedVersion = -1;
  private localVersion = 0;
  private renderedLocalVersion = -1;

  /** Build a view over one spec. */
  constructor(private readonly options: SpecViewOptions) {
    this.store = createStateStore(options.spec.state ?? {});
    this.components = options.components ?? standardComponents;
    this.handlers = options.handlers ?? {};
    this.animating = options.animating ?? false;
    this.store.subscribe(() => {
      this.stateVersion += 1;
      options.onStateChange?.(this.store.getSnapshot());
      this.options.requestRender?.();
    });
  }

  /** Enable or disable animation (spinner frames). */
  setAnimating(animating: boolean): void {
    this.animating = animating;
    this.options.requestRender?.();
  }

  /** Warnings collected during rendering, deduplicated and in first-seen order. */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /** Whether any `on` binding fired during the view's lifetime. */
  hasInteracted(): boolean {
    return this.interacted;
  }

  /** Current state snapshot. */
  getState(): StateModel {
    return this.store.getSnapshot();
  }

  /** Advance animation by one frame; used by the hosting tool's timer. */
  tick(): void {
    this.frame += 1;
    this.local.set("spinnerFrame", this.frame);
    this.localVersion += 1;
    this.options.requestRender?.();
  }

  /** Drop cached render state after a theme change. */
  invalidate(): void {
    // Rendering reads live state each pass, so there is no cached output to drop.
  }

  /** Render the spec into terminal lines. */
  render(width: number): string[] {
    this.lastWidth = Math.max(1, Math.floor(width));
    this.interactive.clear();
    let lines = this.renderPass(this.lastWidth);
    // Focus is only known after the first pass discovers the interactive elements.
    if (this.focusId === undefined && this.interactive.size > 0) {
      this.focusId = this.orderedInteractiveIds()[0];
      this.interactive.clear();
      lines = this.renderPass(this.lastWidth);
    }
    this.renderedVersion = this.stateVersion;
    this.renderedLocalVersion = this.localVersion;
    return lines;
  }

  /** Route a key press to the focused interactive element. */
  handleInput(data: string): boolean {
    if (matchesKey(data, Key.escape)) {
      this.options.onClose?.();
      return true;
    }
    // Input handlers capture render-time values, so replay a pending render
    // first; otherwise two quick keys would both act on the older snapshot.
    this.refreshIfStale();
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.cycleFocus(matchesKey(data, Key.shift("tab")) ? -1 : 1);
      return true;
    }

    const target = this.focusId ? this.interactive.get(this.focusId) : undefined;
    if (target?.handleInput(data)) {
      this.interacted = true;
      return true;
    }

    // Focus is established on the first render, so an unhandled key stays
    // unhandled: stealing it for another control would break Tab ordering.
    return false;
  }

  /** Re-run the render pass when state or ephemeral UI state changed. */
  private refreshIfStale(): void {
    if (this.renderedVersion === this.stateVersion && this.renderedLocalVersion === this.localVersion) return;
    this.interactive.clear();
    this.renderPass(this.lastWidth);
    this.renderedVersion = this.stateVersion;
    this.renderedLocalVersion = this.localVersion;
  }

  /** Ids of interactive elements in render order. */
  private orderedInteractiveIds(): string[] {
    return [...this.interactive.keys()];
  }

  /** Move focus to the next or previous interactive element. */
  private cycleFocus(step: number): void {
    const ids = this.orderedInteractiveIds();
    if (ids.length === 0) return;
    const current = this.focusId ? ids.indexOf(this.focusId) : -1;
    const next = current < 0 ? 0 : (current + step + ids.length) % ids.length;
    this.focusId = ids[next];
    this.options.requestRender?.();
  }

  /** Build the render context and render one pass. */
  private renderPass(width: number): string[] {
    const context: RenderContext = {
      spec: this.options.spec,
      state: this.store.getSnapshot(),
      components: this.components,
      focusOrder: this.focusId ? [this.focusId] : [],
      hardwareCursor: this.focused,
      local: this.local,
      setLocal: (key, value) => {
        this.local.set(key, value);
        this.localVersion += 1;
      },
      animating: this.animating,
      setState: (path, value) => this.writeState(path, value),
      pushState: (path, value, clearPath) => this.writePush(path, value, clearPath),
      removeState: (path, index) => this.writeRemove(path, index),
      dispatch: (elementKey, event, binding) => this.dispatch(elementKey, event, binding),
      registerInteractive: (region) => {
        this.interactive.set(region.id, region);
      },
      warn: (message) => this.warn(message),
    };

    return renderSpec({ spec: this.options.spec, width, ctx: context, components: this.components });
  }

  /** Record a warning once. */
  private warn(message: string): void {
    if (this.warnings.has(message)) return;
    this.warnings.add(message);
    this.options.onWarn?.(message);
  }

  /** Apply a `setState` action against a mutable copy of the state. */
  private writeState(path: string, value: unknown): void {
    const next = structuredClone(this.store.getSnapshot());
    applySet(next, path, value);
    this.store.update(next);
  }

  /** Apply a `pushState` action. */
  private writePush(path: string, value: unknown, clearPath?: string): string | undefined {
    const next = structuredClone(this.store.getSnapshot());
    const issue = applyPush(next, path, value);
    if (clearPath) applySet(next, clearPath, []);
    this.store.update(next);
    return issue;
  }

  /** Apply a `removeState` action. */
  private writeRemove(path: string, index: number): void {
    const next = structuredClone(this.store.getSnapshot());
    applyRemove(next, path, index);
    this.store.update(next);
  }

  /** Run an element's `on` binding without blocking the input handler. */
  private dispatch(elementKey: string, event: string, binding: ActionBinding | ActionBinding[]): void {
    if ((Array.isArray(binding) && binding.length === 0) || (!Array.isArray(binding) && !binding)) return;
    this.interacted = true;
    void runAction({
      binding,
      elementKey,
      context: { stateModel: this.store.getSnapshot() },
      runtime: {
        set: (path, value) => this.writeState(path, value),
        push: (path, value, clearPath) => {
          const issue = this.writePush(path, value, clearPath);
          if (issue) this.warn(issue);
          return issue;
        },
        remove: (path, index) => this.writeRemove(path, index),
      },
      handlers: this.handlers,
      warn: (message) => this.warn(message),
    }).catch((error: unknown) => {
      this.warn(`${event} on element "${elementKey}" failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
