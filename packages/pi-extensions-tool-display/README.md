# pi-extensions-tool-display

`pi-extensions-tool-display` provides the Pi tool-display host plus the shared tool-result rendering protocol and component helpers used by Pi extensions.

It provides:

- registration, disposal, and activity checks for result-render middleware;
- a pending registration queue for when the Pi display host loads later;
- safe component detection and a helper for appending an audit panel to the original tool result;
- optional mouse click toggling for individual tool results in Pi fullscreen TUI mode.

Mouse expansion uses the separate `pi-viewport-mouse` extension. Install both packages and run Pi in fullscreen mode:

```bash
pi install npm:pi-viewport-mouse
pi install npm:pi-extensions-tool-display
pi --tui-mode fullscreen
```

Clicking an expandable tool result toggles only that result. `Ctrl+O` keeps its native global expand/collapse behavior. Mouse expansion is inactive in regular TUI mode and does not affect scrolling, selection, or drag behavior.

It is also a standalone Pi extension. Install or include this package in Pi's package list to load the actual tool-display host. Feature package manifests include this dependency's extension entry, so installing either feature package loads one shared host without requiring a second host package.

## Boundary

This package owns the display protocol and generic component composition only. Each feature extension continues to own its domain-specific audit extraction, copy, status, and layout.

Built-in overrides only replace tools that Pi has already activated; `registerToolOverrides` does not enable inactive built-in tools.

## Upstream attribution

The display integration is designed to work with the MIT-licensed [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display), the original full-featured Pi tool-display project. We thank MasuRii for that work.

The host implementation is based on the MIT-licensed upstream project and is now maintained in this package so consumers do not need a second separately installed host package.

## Install

Install this package directly when you want only the tool-display host:

```bash
pi install npm:pi-extensions-tool-display
```

`pi-distill` and `pi-tool-supervisor` declare this host entry in their package manifests when they are installed.

## Development

```bash
npm test
npm run typecheck
```

## License

[MIT](../../LICENSE)
