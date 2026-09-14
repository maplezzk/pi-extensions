# pi-clean-mode

`pi-clean-mode` collapses a whole agent run into a single duration header, leaving only the final answer in the transcript. Press the toggle key (default `f2`) to expand the work again.

## What it changes

One user prompt usually runs the agent through many tool calls and several narration paragraphs before the final answer. By default Pi renders all of it. This package treats everything except the final answer as **work** and collapses it:

```
[user message]

Took 4m 26s ›
The cause was that today's restock used stock-sales from two days ago, so demand was underestimated.
```

Expanded, the work rows come back and the header shows `⌄` instead of `›`.

## Interaction

| Trigger | Effect |
|---|---|
| `f2` | Collapse or expand the current run's work |
| Mouse click on the header | Same as `f2`, **fullscreen TUI mode only** |
| `/clean` | Same as the shortcut |
| `/config:clean-mode` | Print the current configuration |
| `/config:clean-mode <key>=on\|off` | Change one boolean setting and save it |

Mouse support needs `pi --tui-mode fullscreen`; in regular mode the terminal owns mouse input and scrolling, so Pi never receives the click. The clickable area is the header line plus the blank line above it. Clicking the answer body does nothing.

If you toggle the state yourself during a run, that run is not collapsed automatically at the end — your choice is respected until the next run starts.

## How the work/final split is decided

Pi exports its transcript components, so this package replaces `AssistantMessageComponent.render` and `ToolExecutionComponent.render` on the prototype:

| Component | Collapsed behaviour |
|---|---|
| Assistant message **with** tool calls | hidden entirely (narration belongs to the work) |
| Assistant message **without** tool calls | kept, with the duration header attached |
| Tool row | hidden entirely |

A message without tool calls is the final answer because the agent loop only ends once a response has no tool calls left, so there is exactly one such message per run.

Hidden rows render zero lines, so the duration header lands directly above the final answer. The header itself is a real child component wrapped in `MouseRegion` — not a string prepended during render — because Pi's `Container` computes mouse hit offsets from child heights.

## Live behaviour

The transcript stays expanded while the agent is running — otherwise a collapsed run would show nothing until the answer arrives. When the run settles (`agent_settled`) the work collapses automatically. Automatic collapsing is suppressed for the rest of the run if you toggled the state yourself.

The header only appears once the run duration is known, so it does not show during streaming.
## Configuration

Config file: `<pi agent dir>/extensions/pi-clean-mode/config.json`. See `config.example.json`.

```json
{
  "enabled": true,
  "autoExpandWhileRunning": true,
  "showRunHeader": true,
  "showExpandHint": true
}
```

| Key | Meaning |
|---|---|
| `enabled` | Master switch. When off, every patch passes the original render through untouched. |
| `autoExpandWhileRunning` | Expand while running, then collapse when the run settles. |
| `showRunHeader` | Show the `Took …` header above the final answer. |
| `showExpandHint` | Append the expand hint to the header. |

## Compatibility

This package patches Pi component prototypes, so it is coupled to Pi's exported component surface (`AssistantMessageComponent.hasToolCalls`, `ToolExecutionComponent.render`, and the empty-render-means-zero-lines behaviour). It restores the original prototypes on reload and shutdown, and refuses to overwrite a prototype that another extension replaced after install.

`f2` was chosen because Pi's built-in keybindings do not use it. If you rebind Pi keys, avoid colliding with it.

## Install

```bash
pi install npm:pi-clean-mode
```

## Development

```bash
npm test
npm run typecheck
```

## License

[MIT](../../LICENSE)
