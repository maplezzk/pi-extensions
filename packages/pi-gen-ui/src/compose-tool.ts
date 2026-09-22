import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Spec, StateModel } from "@json-render/core";
import { Type } from "typebox";
import { catalogDocPath } from "./agent-dir.ts";
import { composeSpec, resolveComposition, validateCandidates, type CompositionAvailability, type CompositionStepInfo } from "./compose.ts";
import { StaticPanel, errorText, openInteractivePanel, progressText } from "./panel.ts";
import { specIsInteractive } from "./tool.ts";
import { i18n } from "./i18n.ts";
import type { JsonRenderConfig } from "./config.ts";

/** Candidate schema accepted by the composer. */
const candidateSchema = Type.Object({
  id: Type.String({ description: "Unique candidate id, referenced in composition errors and progress." }),
  description: Type.String({
    description: "What this candidate shows and when it is appropriate. The evaluator judges candidates by this text.",
  }),
  element: Type.Object({
    type: Type.String({ description: "Component name from the catalog reference." }),
    props: Type.Optional(Type.Any({ description: "Concrete prop values, including $state bindings to `state`." })),
    on: Type.Optional(Type.Any({ description: "Allowed action bindings for this element." })),
    visible: Type.Optional(Type.Any({ description: "Visibility condition." })),
  }),
  root: Type.Optional(Type.Boolean({ description: "Whether this candidate may become the tree root." })),
  maxUses: Type.Optional(Type.Number({ description: "Maximum times the composer may place this candidate." })),
  resource: Type.Optional(Type.String({ description: "Optional resource grouping label." })),
});

const composeUiSchema = Type.Object({
  prompt: Type.String({ description: "What the user asked for, in natural language." }),
  candidates: Type.Array(candidateSchema, {
    description:
      "Atomic candidate elements with concrete prop values. The composer selects which to include, their order, and their placement; it never invents prop values.",
  }),
  state: Type.Optional(
    Type.Any({ description: "State model written into the spec, and the values $state prop expressions resolve against." }),
  ),
  context: Type.Optional(Type.Any({ description: "Additional app context explicitly shared with the evaluator." })),
  strategy: Type.Optional(
    Type.Union([Type.Literal("batch"), Type.Literal("sequential")], {
      description: "batch (default) selects and lays out in one evaluation; sequential decides one element at a time.",
    }),
  ),
  maxElements: Type.Optional(Type.Number({ description: "Element budget including the root. Default 32." })),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "true always opens the keyboard-interactive panel; false never opens it. Omit to open it only when the composed spec uses an interactive component.",
    }),
  ),
});

/** Structured tool result details. */
export interface ComposeUiDetails {
  /** Latest spec snapshot; during streaming this is the tree so far. */
  spec?: Spec;
  /** Warnings and simplifications, reported rather than dropped. */
  warnings: string[];
  /** Composer progress label, for the streaming header. */
  progress?: string;
  /** State after the user interacted with the panel. */
  state?: StateModel;
  /** Whether any control consumed input. */
  interacted: boolean;
  /** Set when composition was refused or failed. */
  error?: string;
  /** Why the composer stopped. */
  stopReason?: "finish" | "limit" | "unavailable";
  /** Number of composition steps applied. */
  steps: number;
  /** Total elapsed milliseconds reported by the composer. */
  elapsedMs: number;
  /** Input tokens reported by the gateway, when available. */
  inputTokens: number | null;
}

/** Options for the tool factory. */
export interface ComposeUiToolOptions {
  /** Read the current configuration on every call. */
  getConfig(): JsonRenderConfig;
  /** Whether composition is usable right now. */
  getAvailability(): CompositionAvailability;
}

/** One-line progress description for the streaming header. */
function progressLabel(step: CompositionStepInfo, elapsedMs: number): string {
  const target = step.elementId ? i18n.t("composeProgressTarget", { id: step.elementId }) : "";
  return i18n.t("composeProgress", { index: step.index, target, elapsed: elapsedMs });
}

/** Build the `compose_ui` tool, which delegates layout selection to a decision model. */
export function createComposeUiTool(
  options: ComposeUiToolOptions,
): ToolDefinition<typeof composeUiSchema, ComposeUiDetails> {
  const catalogPath = catalogDocPath();

  return defineTool({
    name: "compose_ui",
    label: "Compose UI",
    description: [i18n.t("composeToolDescription"), i18n.t("catalogPointer", { path: catalogPath })].join(" "),
    promptSnippet: i18n.t("composeToolSnippet"),
    promptGuidelines: [i18n.t("composeGuidelineCandidates"), i18n.t("composeGuidelineFallback")],
    parameters: composeUiSchema,

    /** Compose a spec through the decision model and stream each snapshot into the transcript. */
    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<{
      content: { type: "text"; text: string }[];
      details: ComposeUiDetails;
    }> {
      const config = options.getConfig();
      const warnings: string[] = [];
      const base: ComposeUiDetails = { warnings, interacted: false, steps: 0, elapsedMs: 0, inputTokens: null };

      // The master switch stops both tools. render_ui refuses in the same place, so disabling
      // the package never leaves compose_ui running against a paid provider.
      if (!config.enabled) {
        const text = i18n.t("toolDisabled");
        return { content: [{ type: "text", text }], details: { ...base, error: text } };
      }

      const availability = options.getAvailability();
      if (!availability.available) {
        const text =
          availability.reason === "disabled"
            ? i18n.t("composeDisabled")
            : availability.reason === "unsupportedCore"
              ? i18n.t("composeUnsupportedCore")
              : i18n.t("composeMissingKey");
        return { content: [{ type: "text", text }], details: { ...base, error: text } };
      }

      const candidateIssues = validateCandidates(params.candidates ?? []);
      if (candidateIssues.length > 0) {
        const text = i18n.t("composeInvalidCandidates", {
          issues: candidateIssues.map((issue) => `- ${issue}`).join("\n"),
          catalog: catalogPath,
        });
        return { content: [{ type: "text", text }], details: { ...base, error: text } };
      }

      // Resolve the transport again per call so a key added or rotated after
      // startup is picked up, and so the resolved provider is what actually runs.
      const resolved = resolveComposition({ config });
      if (!resolved) {
        const text = i18n.t("composeMissingKey", { provider: config.composition.provider });
        return { content: [{ type: "text", text }], details: { ...base, error: text } };
      }

      let spec: Spec | null = null;
      let progress: string | undefined;
      let stopReason: ComposeUiDetails["stopReason"];
      let steps = 0;
      let elapsedMs = 0;
      let inputTokens: number | null = null;

      try {
        for await (const event of composeSpec({
          prompt: params.prompt,
          candidates: params.candidates ?? [],
          apiKey: resolved.apiKey,
          model: resolved.model,
          provider: resolved.provider,
          timeoutMs: config.composition.timeoutMs,
          ...(resolved.endpoint === undefined ? {} : { endpoint: resolved.endpoint }),
          ...(params.state === undefined ? {} : { initialState: params.state }),
          ...(params.context === undefined ? {} : { context: params.context }),
          ...(params.strategy === undefined ? {} : { strategy: params.strategy }),
          ...(params.maxElements === undefined ? {} : { maxElements: params.maxElements }),
          signal,
        })) {
          if (event.type === "step") {
            spec = event.spec;
            steps = event.step.index;
            progress = progressLabel(event.step, event.step.elapsedMs);
            // Stream the tree so far into the tool row: this is the progressive
            // rendering the composition model is built for.
            onUpdate?.({
              content: [{ type: "text", text: progress }],
              details: { ...base, spec, progress, steps, elapsedMs: event.step.elapsedMs, inputTokens },
            });
            continue;
          }
          spec = event.spec;
          steps = event.steps;
          elapsedMs = event.elapsedMs;
          inputTokens = event.inputTokens;
          stopReason = event.stopReason;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const text = i18n.t("composeFailed", { error: message, catalog: catalogPath });
        return { content: [{ type: "text", text }], details: { ...base, spec: spec ?? undefined, error: text } };
      }

      if (!spec) {
        const text = i18n.t(
          stopReason === "limit" ? "composeStoppedAtLimit" : "composeStoppedUnavailable",
          { catalog: catalogPath },
        );
        return {
          content: [{ type: "text", text }],
          details: { ...base, error: text, stopReason, steps, elapsedMs, inputTokens },
        };
      }

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

      const parts: string[] = [
        i18n.t("composeSummary", {
          elements: Object.keys((spec.elements ?? {}) as Record<string, unknown>).length,
          steps,
          elapsed: elapsedMs,
        }),
      ];
      if (stopReason === "limit") parts.push(i18n.t("composeStoppedAtLimit", { catalog: catalogPath }));
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
        details: { spec, warnings, progress, state, interacted, stopReason, steps, elapsedMs, inputTokens },
      };
    },

    /** Show the tool call header with the candidate count. */
    renderCall(args, theme) {
      const count = Array.isArray(args.candidates) ? args.candidates.length : 0;
      const suffix = count > 0 ? theme.fg("dim", ` ${count} candidates`) : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("compose_ui"))}${suffix}`, 0, 0);
    },

    /** Render the latest spec snapshot while composing, then the finished panel. */
    renderResult(result, { expanded, isPartial }, theme) {
      if (result.details?.error) return errorText(result.details.error, theme);
      const spec = result.details?.spec;
      const maxLines = options.getConfig().maxResultLines;
      if (isPartial) {
        if (!spec) return progressText(result.details?.progress ?? i18n.t("composing"), theme);
        const container = new Container();
        container.addChild(progressText(result.details.progress ?? i18n.t("composing"), theme));
        container.addChild(new StaticPanel(spec, { maxLines, expanded }));
        return container;
      }
      if (!spec) return progressText(i18n.t("generating"), theme);
      return new StaticPanel(spec, { maxLines, expanded });
    },
  });
}
