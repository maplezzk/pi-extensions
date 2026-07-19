# pi-extensions-tool-display

`pi-extensions-tool-display` provides the shared tool-result rendering protocol and component helpers used by Pi extensions.

It provides:

- registration, disposal, and activity checks for result-render middleware;
- a pending registration queue for when the Pi display host loads later;
- safe component detection and a helper for appending an audit panel to the original tool result.

It is not a standalone Pi extension: it registers no tools, commands, or entry renderers. It is intended to be consumed as a runtime dependency by extensions such as `pi-distill` and `pi-tool-supervisor`.

## Boundary

This package owns the display protocol and generic component composition only. Each feature extension continues to own its domain-specific audit extraction, copy, status, and layout.

## Development

```bash
npm test
npm run typecheck
```

## License

[MIT](../../LICENSE)
