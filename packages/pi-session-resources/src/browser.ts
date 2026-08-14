import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  type Component,
} from "@earendil-works/pi-tui";
import type { SessionResource } from "./collector.ts";
import {
  adjacentResourceTab,
  renderResourceWidget,
  type ResourceTab,
} from "./render.ts";

const TOOLS_EXPAND_ACTION = "app.tools.expand";
const SELECT_CANCEL_ACTION = "tui.select.cancel";
const SELECT_DOWN_ACTION = "tui.select.down";

export interface ResourceBrowserOptions {
  resources: readonly SessionResource[];
  activeTab: ResourceTab;
  theme: Theme;
  keybindings: Pick<KeybindingsManager, "matches">;
  getExpanded: () => boolean;
  setExpanded: (expanded: boolean) => void;
  onTabChange: (tab: ResourceTab) => void;
  onClose: () => void;
  requestRender: () => void;
}

/** Focusable ask-style resource browser shown by Ctrl+Up. */
export class ResourceBrowser implements Component {
  private activeTab: ResourceTab;

  /** Captures immutable browser dependencies and the initial active resource tab. */
  constructor(private readonly options: ResourceBrowserOptions) {
    this.activeTab = options.activeTab;
  }

  /** Renders the current tab using the live Pi tool-expansion state. */
  render(width: number): string[] {
    return renderResourceWidget({
      resources: this.options.resources,
      width,
      expanded: this.options.getExpanded(),
      activeTab: this.activeTab,
      interactive: true,
      theme: this.options.theme,
    });
  }

  /** Routes close, tab navigation, and canonical Ctrl+O expansion input. */
  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (
      this.options.keybindings.matches(data, SELECT_CANCEL_ACTION)
      || this.options.keybindings.matches(data, SELECT_DOWN_ACTION)
    ) {
      this.options.onClose();
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.switchTab(1);
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
      this.switchTab(-1);
      return;
    }
    if (this.options.keybindings.matches(data, TOOLS_EXPAND_ACTION)) {
      if (!isKeyRepeat(data)) this.options.setExpanded(!this.options.getExpanded());
      this.options.requestRender();
    }
  }

  /** No cached layout is retained between Pi render passes. */
  invalidate(): void {}

  /** Applies one wrapped tab movement and asks Pi to repaint the overlay. */
  private switchTab(delta: -1 | 1): void {
    this.activeTab = adjacentResourceTab(this.activeTab, delta);
    this.options.onTabChange(this.activeTab);
    this.options.requestRender();
  }
}
