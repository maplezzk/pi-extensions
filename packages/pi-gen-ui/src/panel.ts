import { Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Spec, StateModel } from "@json-render/core";
import { SpecView } from "./view.ts";
import { i18n } from "./i18n.ts";

/** Render a spec statically in the transcript, truncating long output unless expanded. */
export class StaticPanel implements Component {
  private readonly view: SpecView;

  /** Build a static (non-interactive) view of one spec. */
  constructor(
    private readonly spec: Spec,
    private readonly options: { maxLines: number; expanded: boolean },
  ) {
    this.view = new SpecView({ spec });
  }

  /** Render the spec, hiding overflow lines behind an explicit hint. */
  render(width: number): string[] {
    const lines = this.view.render(width);
    if (this.options.expanded || lines.length <= this.options.maxLines) return lines;
    const hidden = lines.length - this.options.maxLines;
    return [...lines.slice(0, this.options.maxLines), "", i18n.t("resultTruncated", { count: hidden })];
  }

  /** Drop cached render state after a theme change. */
  invalidate(): void {
    this.view.invalidate();
  }
}

/** A one-line progress message for a tool that is still working. */
export function progressText(message: string, theme: { fg(color: string, text: string): string }): Text {
  return new Text(theme.fg("dim", message), 0, 0);
}

/** Build a refusal message component for a tool result. */
export function errorText(message: string, theme: { fg(color: string, text: string): string }): Text {
  return new Text(theme.fg("error", message), 0, 0);
}

/** Result of showing the interactive panel. */
export interface InteractivePanelOutcome {
  /** State after the user finished interacting. */
  state?: StateModel;
  /** Whether any control consumed input. */
  interacted: boolean;
}

/** Options for opening the interactive panel. */
export interface OpenPanelOptions {
  /** Extension context that owns the UI. */
  ctx: ExtensionContext;
  /** Spec to render interactively. */
  spec: Spec;
  /** Warnings collected by the tool so far; the panel appends its own. */
  warnings: string[];
  /** Animation frame interval in milliseconds. */
  frameMs?: number;
}

/**
 * Open the spec in a centred overlay so it can receive keyboard input.
 *
 * Returns undefined when the mode has no interactive UI, so the caller can fall
 * back to the static transcript rendering without special-casing the mode.
 */
export async function openInteractivePanel(options: OpenPanelOptions): Promise<InteractivePanelOutcome | undefined> {
  const { ctx, spec, warnings, frameMs = 150 } = options;
  const view = await ctx.ui.custom<SpecView | null>(
    (tui, _theme, _keybindings, done) => {
      let timer: NodeJS.Timeout | undefined;
      const panel = new SpecView({
        spec,
        onWarn: (message) => {
          if (!warnings.includes(message)) warnings.push(message);
        },
        requestRender: () => tui.requestRender(),
        onClose: () => {
          if (timer) clearInterval(timer);
          done(panel);
        },
      });
      timer = setInterval(() => panel.tick(), frameMs);
      timer.unref?.();
      return panel;
    },
    { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center", margin: 1 } },
  );

  if (!view) return undefined;
  for (const warning of view.getWarnings()) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return { state: view.getState(), interacted: view.hasInteracted() };
}
