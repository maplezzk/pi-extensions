/**
 * Public library surface of pi-gen-ui.
 *
 * The Pi extension entry point is `../index.ts`; everything here can also be
 * used standalone, for example to render a spec into lines inside another
 * terminal application.
 */

export { SpecView, type SpecViewOptions } from "./view.ts";
export { renderSpec, renderNode, renderNodes, type SpecRenderOptions } from "./renderer.ts";
export { standardComponents } from "./components/index.ts";
export { piCatalog, piComponentNames, type PiCatalog } from "./pi-catalog.ts";
export { schema, type PiJsonRenderSchema, type PiJsonRenderSpec } from "./schema.ts";
export { standardActionDefinitions, standardComponentDefinitions } from "./catalog.ts";
export { renderCatalogDoc } from "./catalog-doc.ts";
export { SUPPORTED_BORDER_STYLES, SUPPORTED_PROPS, unsupportedProps } from "./capabilities.ts";
export { createRenderUiTool, specIsInteractive, type RenderUiDetails, type RenderUiToolOptions } from "./tool.ts";
export { StaticPanel, openInteractivePanel, type InteractivePanelOutcome, type OpenPanelOptions } from "./panel.ts";
export {
  DEFAULT_COMPOSITION_MODEL,
  composeSpec,
  compositionAvailability,
  coreSupportsComposition,
  validateCandidates,
  type ComposeSpecOptions,
  type CompositionAvailability,
  type CompositionBlockReason,
  type CompositionCompleteEvent,
  type CompositionEvent,
  type CompositionStepEvent,
  type CompositionStepInfo,
} from "./compose.ts";
export { createComposeUiTool, type ComposeUiDetails, type ComposeUiToolOptions } from "./compose-tool.ts";
export {
  DEFAULT_CONFIG,
  loadConfig,
  normalizeConfig,
  saveConfig,
  type CompositionConfig,
  type InteractiveViewMode,
  type JsonRenderConfig,
} from "./config.ts";
export { catalogDocPath, configPath, packageDataDir, resolveAgentDir } from "./agent-dir.ts";
export type {
  ComponentArgs,
  ComponentRegistry,
  ComponentRenderer,
  InteractiveRegion,
  NodeRenderer,
  RenderContext,
  RenderedNode,
} from "./types.ts";
