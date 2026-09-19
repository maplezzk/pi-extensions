import {
  evaluateVisibility,
  getByPath,
  resolveBindings,
  resolveElementProps,
  resolveRepeatStatePath,
  splitRepeatVisibility,
} from "@json-render/core";
import type { PropResolutionContext, Spec, UIElement, VisibilityCondition } from "@json-render/core";
import { unsupportedProps } from "./capabilities.ts";
import type { ComponentRegistry, RenderContext, RenderedNode } from "./types.ts";

/** Options for one full spec render pass. */
export interface SpecRenderOptions {
  /** The spec to render. */
  spec: Spec;
  /** Available columns. */
  width: number;
  /** Mutable render context shared by all components. */
  ctx: RenderContext;
  /** Component implementations keyed by catalog component name. */
  components: ComponentRegistry;
}

/** Resolve the element map once per pass. */
function elementsOf(spec: Spec): Record<string, UIElement> {
  return (spec.elements ?? {}) as Record<string, UIElement>;
}

/** Warn once per distinct message. */
function warnOnce(ctx: RenderContext, message: string): void {
  ctx.warn(message);
}

/** Resolve the raw prop bag into values plus write-back bindings. */
function resolveProps(
  element: UIElement,
  context: PropResolutionContext,
): { props: Record<string, unknown>; bindings: Record<string, string> | undefined } {
  const raw = (element.props ?? {}) as Record<string, unknown>;
  const bindings = resolveBindings(raw, context);
  const props = resolveElementProps(raw, context);
  return { props, bindings };
}

/** Read the repeat array from state, reporting unusable shapes. */
function repeatItems(
  element: UIElement,
  context: PropResolutionContext,
  elementKey: string,
  ctx: RenderContext,
): unknown[] {
  const repeat = element.repeat;
  if (!repeat || typeof repeat !== "object") return [];
  const path = resolveRepeatStatePath(repeat.statePath, context.repeatBasePath);
  if (!path) {
    warnOnce(
      ctx,
      `Element "${elementKey}" uses a repeat statePath of the form { "$item": ... } outside a repeat scope; the repeat was skipped.`,
    );
    return [];
  }
  const value = getByPath(context.stateModel, path);
  if (!Array.isArray(value)) {
    warnOnce(
      ctx,
      `Element "${elementKey}" repeats over "${path}", which is not an array in the state model (got ${value === undefined ? "undefined" : typeof value}); the repeat was skipped.`,
    );
    return [];
  }
  return value;
}

/**
 * Resolve one element key into zero or more rendered nodes.
 *
 * Returns an empty array when the element is missing, hidden, or produced no
 * repeate items — never a placeholder row, so hidden content leaves no gap.
 */
function resolveNode(
  key: string,
  context: PropResolutionContext,
  options: SpecRenderOptions,
): RenderedNode[] {
  const { ctx } = options;
  const elements = elementsOf(options.spec);
  const element = elements[key];
  if (!element) {
    warnOnce(ctx, `Element "${key}" is referenced but not defined in "elements"; that branch was skipped.`);
    return [];
  }
  if (typeof element.type !== "string" || element.type.length === 0) {
    warnOnce(ctx, `Element "${key}" has no "type"; it was skipped.`);
    return [];
  }
  if (!options.components[element.type]) {
    warnOnce(ctx, `Element "${key}" uses unknown component "${element.type}"; it was skipped.`);
    return [];
  }

  const build = (scope: PropResolutionContext): RenderedNode | undefined => {
    const { props, bindings } = resolveProps(element, scope);

    for (const prop of unsupportedProps(element.type, props)) {
      warnOnce(ctx, `Element "${key}" (${element.type}): prop "${prop}" is ignored by the Pi renderer.`);
    }

    const childKeys = Array.isArray(element.children) ? element.children : [];
    if (element.children === undefined) {
      warnOnce(ctx, `Element "${key}" (${element.type}) has no "children" array; treating it as a leaf.`);
    }
    const children = childKeys.flatMap((childKey) => resolveNode(childKey, scope, options));

    const slots: Record<string, RenderedNode[]> = {};
    const rawSlots = element.slots as Record<string, unknown> | undefined;
    if (rawSlots && typeof rawSlots === "object") {
      for (const [name, value] of Object.entries(rawSlots)) {
        if (!Array.isArray(value)) continue;
        slots[name] = value.flatMap((childKey) =>
          typeof childKey === "string" ? resolveNode(childKey, scope, options) : [],
        );
      }
    }

    return { key, element, props, bindings, children, slots };
  };

  const repeat = element.repeat;
  if (repeat && typeof repeat === "object") {
    const { container, itemFilter } = splitRepeatVisibility(element.visible as VisibilityCondition | undefined);
    if (container !== undefined && !evaluateVisibility(container, { stateModel: context.stateModel })) return [];

    const items = repeatItems(element, context, key, ctx);
    const basePath = resolveRepeatStatePath(repeat.statePath, context.repeatBasePath);
    const nodes: RenderedNode[] = [];

    items.forEach((item, index) => {
      const itemContext: PropResolutionContext = {
        ...context,
        repeatItem: item,
        repeatIndex: index,
        repeatBasePath: basePath ? `${basePath}/${index}` : undefined,
      };
      if (itemFilter !== undefined && !evaluateVisibility(itemFilter, itemContext)) return;
      const node = build(itemContext);
      if (node) nodes.push({ ...node, key: `${key}[${index}]` });
    });

    return nodes;
  }

  if (!evaluateVisibility(element.visible as VisibilityCondition | undefined, context)) return [];
  const node = build(context);
  return node ? [node] : [];
}

/** Render a resolved node by delegating to its component implementation. */
export function renderNode(
  node: RenderedNode,
  width: number,
  ctx: RenderContext,
  components: ComponentRegistry,
): string[] {
  const renderer = components[node.element.type];
  if (!renderer) return [];
  const args = {
    node,
    width,
    ctx,
    children: (childWidth: number): string[] => renderNodes(node.children, childWidth, ctx, components),
    slot: (name: string, slotWidth: number): string[] =>
      renderNodes(node.slots[name] ?? [], slotWidth, ctx, components),
  };
  try {
    return renderer(args);
  } catch (error) {
    ctx.warn(
      `Component "${node.element.type}" on element "${node.key}" failed to render: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/** Render a list of sibling nodes, stacking them vertically. */
export function renderNodes(
  nodes: RenderedNode[],
  width: number,
  ctx: RenderContext,
  components: ComponentRegistry,
): string[] {
  return nodes.flatMap((node) => renderNode(node, width, ctx, components));
}

/** Render a whole spec starting from its root element. */
export function renderSpec(options: SpecRenderOptions): string[] {
  const { spec, width, ctx, components } = options;
  const safeWidth = Math.max(1, Math.floor(width));
  const root = spec?.root;
  if (typeof root !== "string" || root.length === 0) {
    warnOnce(ctx, 'The spec has no "root" key; nothing was rendered.');
    return [];
  }
  const context: PropResolutionContext = { stateModel: ctx.state };
  const nodes = resolveNode(root, context, options);
  return renderNodes(nodes, safeWidth, ctx, components);
}
