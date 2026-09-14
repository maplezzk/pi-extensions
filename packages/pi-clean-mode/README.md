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

## Three levels of collapsing

| Level | Row | Behaviour |
|---|---|---|
| Run | `Took 4m 26s ›` | Hides the whole run's work; only the final answer stays |
| Action group | `▸ Explored · 3 steps` | Hides a turn's tool calls behind one summary row |
| Tool row | `$ find . -name '*.ts'` | Pi's own per-row output expansion (`ctrl+o`, or click the result) |

Group boundaries follow **narration**: an assistant message with text starts a new group, and consecutive tool-only turns merge into the current one. So a burst of work reads as one row even when the model emits one tool call per turn — which is the common case.

Groups with a single member are never collapsed — the tool row itself is shown, so a lone command still reads as itself.

```
Took 11s ⌄
I'll check the restock data first.

▸ Explored · 3 steps          ← collapsed group

Took 11s ⌄
I'll check the restock data first.

  $ find . -name '*.ts'       ← expanded group
  $ wc -l src/*.ts
  $ git status
```

Group state and run state are independent: expanding the run shows groups in whatever state you left them.

## Interaction

| Trigger | Effect |
|---|---|
| `f2` | Collapse or expand the current run's work |
| `shift+f2` | Expand or collapse every action group |
| Mouse click on the run header | Same as `f2`, **fullscreen TUI mode only** |
| Mouse click on a group header | Expand or collapse that one action group, **fullscreen TUI mode only** |
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
| Tool row | hidden entirely, or reduced to one action-group header row |

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
| `enableActionGroups` | Collapse a turn's multiple tool calls into one group header row. |
| `showActivityArea` | Show the live activity area above the editor while the agent runs. |
| `activityRows` | Activity area height, 1-6 (default 4). |
| `animateActivity` | Animate the activity glyph; off keeps a still marker. |

## Debugging

Set `PI_CLEAN_MODE_DEBUG=1` to append event and render decisions to `<pi agent dir>/pi-clean-mode-debug.log`. It is off by default and the flag is read once at process start, so it costs nothing on the render path when disabled.

## Live activity area

While the agent runs, a small area above the editor shows what is happening right now:

```
│ ◑ 思考  正在追踪 token 失效路径…
│ ⠹ 运行命令 npm test
│   ↳ 12 passing
│ 读取 4 · 搜索 3 · 命令 1 · 42s
```

Contents come from real events only — the running tool, its latest output line, the thinking head, and counters. Parallel calls collapse into one summary line.

Two implementation constraints matter, both taken from how `pi-desktop-transcript` handles the same problem:

1. **`ctx.ui.setWidget` repaints the whole screen.** The lines are rendered into a string first and compared with the previous tick; if the content is identical, `setWidget` is not called at all.
2. **Motion is capped at 2.5fps (400ms)**, the timer only exists while a run is active, and it is `unref()`-ed. With `animateActivity: false` it slows to 1s and shows still markers.

While the area shows the current action, Pi's own `Working...` line and hidden-thinking placeholder are suppressed so the two do not say the same thing twice.

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
