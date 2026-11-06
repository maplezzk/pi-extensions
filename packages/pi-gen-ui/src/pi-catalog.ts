import { defineCatalog } from "@json-render/core";
import { schema } from "./schema.ts";
import { standardActionDefinitions, standardComponentDefinitions } from "./catalog.ts";

/**
 * The Pi terminal catalog: every component and action the renderer understands.
 *
 * Component names and props match `@json-render/ink`'s standard catalog, so a
 * spec generated for Ink validates here too. The renderer honors a documented
 * subset of the prop surface and reports every ignored prop instead of
 * silently dropping it.
 */
export const piCatalog = defineCatalog(schema, {
  components: standardComponentDefinitions,
  actions: standardActionDefinitions,
});

/** Type of the Pi terminal catalog. */
export type PiCatalog = typeof piCatalog;

/** Component names in catalog order; used for prompts and diagnostics. */
export const piComponentNames: readonly string[] = piCatalog.componentNames;
