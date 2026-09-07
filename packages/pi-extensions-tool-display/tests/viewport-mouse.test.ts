import assert from "node:assert/strict";
import test from "node:test";
import type { ViewportClickEvent } from "pi-viewport-mouse/client";
import {
  findExpandableComponent,
  toggleToolResultFromViewportClick,
} from "../src/viewport-mouse.ts";

/** Build the smallest viewport-click fixture needed by the pure toggle handler. */
function createClickEvent(component: unknown): { event: ViewportClickEvent; renderRequested: () => boolean } {
  let requested = false;
  const event = {
    closest: (predicate: (candidate: unknown) => boolean) => predicate(component) ? component : undefined,
    requestRender: () => {
      requested = true;
    },
  } as unknown as ViewportClickEvent;

  return {
    event,
    renderRequested: () => requested,
  };
}

test("findExpandableComponent returns the nearest expandable component", () => {
  const component = { expanded: false, setExpanded: () => undefined };
  const { event } = createClickEvent(component);

  assert.equal(findExpandableComponent(event), component);
});

test("toggleToolResultFromViewportClick expands a collapsed result and redraws", () => {
  let expanded: boolean | undefined = false;
  const component = {
    // Mirror the private runtime state exposed by Pi's expandable component.
    get expanded() {
      return expanded;
    },
    // Capture the state change requested by the click handler.
    setExpanded(value: boolean) {
      expanded = value;
    },
  };
  const { event, renderRequested } = createClickEvent(component);

  assert.equal(toggleToolResultFromViewportClick(event), true);
  assert.equal(expanded, true);
  assert.equal(renderRequested(), true);
});

test("toggleToolResultFromViewportClick collapses an expanded result", () => {
  let expanded: boolean | undefined = true;
  const component = {
    // Mirror the private runtime state exposed by Pi's expandable component.
    get expanded() {
      return expanded;
    },
    // Capture the state change requested by the click handler.
    setExpanded(value: boolean) {
      expanded = value;
    },
  };
  const { event } = createClickEvent(component);

  assert.equal(toggleToolResultFromViewportClick(event), true);
  assert.equal(expanded, false);
});

test("toggleToolResultFromViewportClick passes through clicks without an expandable component", () => {
  const { event, renderRequested } = createClickEvent({ render: () => [] });

  assert.equal(toggleToolResultFromViewportClick(event), false);
  assert.equal(renderRequested(), false);
});
