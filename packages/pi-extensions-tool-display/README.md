# pi-extensions-tool-display

`pi-extensions-tool-display` provides the shared tool-result rendering protocol and component helpers used by Pi extensions.

It provides:

- registration, disposal, and activity checks for result-render middleware;
- a pending registration queue for when the Pi display host loads later;
- safe component detection and a helper for appending an audit panel to the original tool result.

It is not a standalone Pi extension: it registers no tools, commands, or entry renderers. It is intended to be consumed as a runtime dependency by extensions such as `pi-distill` and `pi-tool-supervisor`.

## Boundary

This package owns the display protocol and generic component composition only. Each feature extension continues to own its domain-specific audit extraction, copy, status, and layout.

## Upstream attribution

The display integration is designed to work with the MIT-licensed [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display), the original full-featured Pi tool-display project. We thank MasuRii for that work.

This package is a separate shared-runtime extraction from this repository's own extension bridges. It does not bundle or redistribute `pi-tool-display`'s implementation; the upstream project remains the reference for full tool rendering.

## Development

```bash
npm test
npm run typecheck
```

## License

[MIT](../../LICENSE)
