import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { autoFixSpec, formatSpecIssues, validateSpec } from "@json-render/core";
import type { Spec, StateModel, UIElement } from "@json-render/core";
import { Type } from "typebox";
import { catalogDocPath } from "./agent-dir.ts";
import { piCatalog } from "./pi-catalog.ts";
import { INTERACTIVE_COMPONENTS } from "./components/interactive.ts";
import { StaticPanel, errorText, openInteractivePanel, progressText } from "./panel.ts";
import { i18n } from "./i18n.ts";
import type { JsonRenderConfig } from "./config.ts";

/** Tool parameter schema. The real contract lives in the generated catalog reference. */
const renderUiSchema = Type.Object({
  root: Type.String({
    description: "Key of the root element inside `elements`.",
  }),
  elements: Type.Record(
    Type.String(),
    Type.Object({
      type: Type.String({ description: "Component name from the catalog reference." }),
      props: Type.Optional(Type.Any({ description: "Component props; see the catalog reference." })),
      children: Type.Optional(Type.Array(Type.String(), { description: "Child element keys; [] for leaves." })),
      visible: Type.Optional(Type.Any({ description: "Visibility condition." })),
      repeat: Type.Optional(Type.Any({ description: 'Repeat over a state array: { "statePath": "/items" }.' })),
      on: Type.Optional(Type.Any({ description: "Event bindings, for example on.change." })),
      slots: Type.Optional(Type.Any({ description: "Named slot element keys." })),
      watch: Type.Optional(Type.Any({ description: "Reactive state bindings." })),
    }),
  ),
  state: Type.Optional(Type.Any({ description: "Initial state model; a top-level sibling of root and elements." })),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "true always opens the keyboard-interactive panel; false never opens it. Omit to open it only when the spec uses an interactive component.",
    }),
  ),
});

/** Structured tool result details. */
export interface RenderUiDetails {
  /** Spec that was rendered, after lossless auto-fixes. */
  spec?: Spec;
  /** Non-fatal simplifications and problems; never empty when something was dropped. */
  warnings: string[];
  /** State after the user interacted with the panel. */
  state?: StateModel;
  /** Whether any `on` binding fired. */
  interacted: boolean;
  /** Set when rendering was refused; the text content repeats this message. */
  error?: string;
  /** Element count in the rendered spec. */
  elementCount: number;
  /** Distinct component types used. */
  componentCount: number;
}

/** Options for the tool factory. */
export interface RenderUiToolOptions {
  /** Read the current configuration on every call. */
  getConfig(): JsonRenderConfig;
}

/** Format zod validation issues into one line per problem. */
function formatZodIssues(error: unknown): string {
  const issues = (error as { issues?: { path?: (string | number)[]; message: string }[] } | undefined)?.issues;
  if (!Array.isArray(issues)) return String(error);
  return issues
    .map((issue) => {
      const path = (issue.path ?? []).join(".");
      return path ? `- ${path}: ${issue.message}` : `- ${issue.message}`;
    })
    .join("\n");
}

/** Whether the spec contains a component that needs keyboard input. */
export function specIsInteractive(spec: Spec): boolean {
  const elements = (spec.elements ?? {}) as Record<string, UIElement>;
  return Object.values(elements).some((element) => INTERACTIVE_COMPONENTS.includes(element?.type ?? ""));
}

/** Build the `render_ui` tool. */
export function createRenderUiTool(options: RenderUiToolOptions): ToolDefinition<typeof renderUiSchema, RenderUiDetails> {
  const catalogPath = catalogDocPath();

  return defineTool({
    name: "render_ui",
    label: "Render UI",
    description: [i18n.t("toolDescription"), i18n.t("catalogPointer", { path: catalogPath })].join(" "),
    promptSnippet: i18n.t("toolSnippet"),
    promptGuidelines: [i18n.t("guidelineCatalog"), i18n.t("guidelineShape"), i18n.t("guidelineInteractive")],
    parameters: renderUiSchema,

    /** Validate the spec, then render it in the transcript and optionally open the interactive panel. */
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<{
      content: { type: "text"; text: string }[];
      details: RenderUiDetails;
    }> {
      const config = options.getConfig();
      const warnings: string[] = [];
      const emptyDetails: RenderUiDetails = { warnings, interacted: false, elementCount: 0, componentCount: 0 };

      if (!config.enabled) {
        const text = i18n.t("toolDisabled");
        return { content: [{ type: "text", text }], details: { ...emptyDetails, error: text } };
      }

      const rawSpec = {
        root: params.root,
        elements: params.elements ?? {},
        ...(params.state === undefined ? {} : { state: params.state }),
      } as unknown as Spec;

      // Relocate misplaced visible/on/repeat fields before validating; this is lossless.
      const fixed = autoFixSpec(rawSpec, { lossy: false });

      const structural = validateSpec(fixed.spec);
      if (!structural.valid) {
        const text = i18n.t("specInvalid", { issues: formatSpecIssues(structural.issues), catalog: catalogPath });
        return { content: [{ type: "text", text }], details: { ...emptyDetails, error: text, spec: fixed.spec } };
      }

      const propsResult = piCatalog.validate(fixed.spec);
      if (!propsResult.success) {
        const text = i18n.t("specPropsInvalid", {
          issues: formatZodIssues(propsResult.error),
          catalog: catalogPath,
        });
        return { content: [{ type: "text", text }], details: { ...emptyDetails, error: text, spec: fixed.spec } };
      }

      const spec = (propsResult.data ?? fixed.spec) as Spec;
      const elements = (spec.elements ?? {}) as Record<string, UIElement>;
      const componentTypes = new Set(Object.values(elements).map((element) => element?.type).filter(Boolean));
      const elementCount = Object.keys(elements).length;
      const componentCount = componentTypes.size;

      const interactive = params.interactive ?? specIsInteractive(spec);
      const openPanel =
        ctx.mode === "tui" &&
        (params.interactive === true ||
          (config.interactiveView === "always" && params.interactive !== false) ||
          (config.interactiveView === "auto" && interactive));

      let state: StateModel | undefined;
      let interacted = false;

      if (openPanel) {
        const outcome = await openInteractivePanel({ ctx, spec, warnings });
        if (outcome) {
          state = outcome.state;
          interacted = outcome.interacted;
        }
      }

      const parts: string[] = [i18n.t("resultSummary", { elements: elementCount, components: componentCount })];
      if (ctx.mode !== "tui") parts.push(i18n.t("resultNotTui", { mode: ctx.mode }));
      if (interacted && state) parts.push(i18n.t("resultInteractive", { state: JSON.stringify(state) }));
      if (warnings.length > 0) {
        parts.push(
          i18n.t("resultWarnings", {
            count: warnings.length,
            details: warnings.map((warning) => `- ${warning}`).join("\n"),
          }),
        );
      }

      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: { spec, warnings, state, interacted, elementCount, componentCount },
      };
    },

    /** Show the tool call header with the element count. */
    renderCall(args, theme) {
      const count = Object.keys((args.elements ?? {}) as Record<string, unknown>).length;
      const suffix = count > 0 ? theme.fg("dim", ` ${count} elements`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("render_ui"))}${suffix}`, 0, 0);
    },

    /** Render the panel inline, or the refusal reason when the spec was rejected. */
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return progressText(i18n.t("generating"), theme);
      if (result.details?.error) return errorText(result.details.error, theme);
      const spec = result.details?.spec;
      if (!spec) return progressText(i18n.t("generating"), theme);
      return new StaticPanel(spec, { maxLines: options.getConfig().maxResultLines, expanded });
    },
  });
}
