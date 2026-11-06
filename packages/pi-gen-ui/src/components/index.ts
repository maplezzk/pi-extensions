import type { ComponentRegistry } from "../types.ts";
import { contentComponents } from "./content.ts";
import { dataComponents } from "./data.ts";
import { interactiveComponents } from "./interactive.ts";
import { layoutComponents } from "./layout.ts";

/**
 * Every component implementation, keyed by catalog component name.
 *
 * A test asserts this registry and the catalog expose the same component names,
 * so adding a catalog entry without an implementation fails loudly rather than
 * rendering an empty element.
 */
export const standardComponents: ComponentRegistry = {
  ...layoutComponents,
  ...contentComponents,
  ...dataComponents,
  ...interactiveComponents,
};

export { contentComponents, dataComponents, interactiveComponents, layoutComponents };
