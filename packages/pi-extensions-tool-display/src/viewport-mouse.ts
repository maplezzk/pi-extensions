import {
  onViewportClick,
  type ViewportClickEvent,
} from "pi-viewport-mouse/client";
import { registerCleanup } from "./disposable.js";

const VIEWPORT_MOUSE_HANDLER_KEY = "pi-extensions-tool-display";

type ExpandableComponent = {
  expanded?: boolean;
  setExpanded(expanded: boolean): void;
};

/** Find the nearest runtime component that exposes Pi's expansion method. */
export function findExpandableComponent(event: ViewportClickEvent): ExpandableComponent | undefined {
  const component = event.closest((candidate) =>
    Boolean(candidate && typeof candidate.setExpanded === "function"),
  );

  return component as ExpandableComponent | undefined;
}

/** Toggle one tool result, request a redraw, and pass through unrelated clicks. */
export function toggleToolResultFromViewportClick(event: ViewportClickEvent): boolean {
  const component = findExpandableComponent(event);
  if (!component) {
    return false;
  }

  component.setExpanded(component.expanded !== true);
  event.requestRender();
  return true;
}

/**
 * Enable per-component mouse expansion when pi-viewport-mouse is installed.
 * The mouse extension owns terminal input and this package only owns the
 * tool-display action, so regular/inline TUI mode remains a no-op.
 */
export function registerToolDisplayViewportMouse(): void {
  const unsubscribe = onViewportClick(
    VIEWPORT_MOUSE_HANDLER_KEY,
    toggleToolResultFromViewportClick,
  );
  registerCleanup(unsubscribe);
}
