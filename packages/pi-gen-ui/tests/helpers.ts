import type { Spec } from "@json-render/core";
import { stripAnsi } from "../src/ansi.ts";
import { SpecView } from "../src/view.ts";
import type { SpecViewOptions } from "../src/view.ts";

/** Build a spec from a root key and an element map. */
export function makeSpec(
  root: string,
  elements: Record<string, Record<string, unknown>>,
  state?: Record<string, unknown>,
): Spec {
  return {
    root,
    elements: Object.fromEntries(
      Object.entries(elements).map(([key, value]) => [key, { children: [], ...value }]),
    ),
    ...(state === undefined ? {} : { state }),
  } as unknown as Spec;
}

/** Render a spec to plain text lines and collect warnings. */
export function renderText(
  spec: Spec,
  width = 80,
  options: Partial<SpecViewOptions> = {},
): { lines: string[]; text: string; warnings: string[]; view: SpecView } {
  const view = new SpecView({ spec, ...options });
  const lines = view.render(width).map((line) => stripAnsi(line));
  return { lines, text: lines.join("\n"), warnings: view.getWarnings(), view };
}

/** Options for rendering one element as the spec root. */
interface ElementRenderOptions {
  /** Catalog component name. */
  type: string;
  /** Component props. */
  props?: Record<string, unknown>;
  /** Available columns. */
  width?: number;
  /** Extra elements referenced by the root's children. */
  children?: Record<string, Record<string, unknown>>;
}

/** Render a single element as the spec root and return plain text. */
export function renderElementText(options: ElementRenderOptions): {
  lines: string[];
  text: string;
  warnings: string[];
} {
  const { type, props = {}, width = 80, children = {} } = options;
  const spec = makeSpec("root", { root: { type, props, children: Object.keys(children) }, ...children });
  const { lines, text, warnings } = renderText(spec, width);
  return { lines, text, warnings };
}
