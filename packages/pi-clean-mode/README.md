# pi-clean-mode

`pi-clean-mode` collapses a whole agent run into a single duration header, leaving only the final answer in the transcript. Press the toggle key (default `f2`) to expand the work again.

## What it changes

One user prompt usually runs the agent through many tool calls and several narration paragraphs before the final answer. By default Pi renders all of it. This package treats everything except the final answer as **work** and collapses it:

```
[user message]

▌ 用时 4m 26s ▶
The cause was that today's restock used stock-sales from two days ago, so demand was underestimated.
```

Expanded, the work rows come back and the header shows `▼` instead of `▶`.

## Three levels of collapsing

| Level | Row | Behaviour |
|---|---|---|
| Run | `▌ 用时 4m 26s ▶` | Hides the whole run's work; only the final answer stays |
| Action group | `│ Explored · 3 steps ▶` | Hides a turn's tool calls behind one summary row |
| Member row | `├─ Ran npm test ▶` | An expanded group lists one command per row; click a row to show that command's original output |
| Tool row | `$ find . -name '*.ts'` | Pi's own per-row output expansion (`ctrl+o`, or click the result) |

Group boundaries follow **narration**: an assistant message with text starts a new group, and consecutive tool-only turns merge into the current one. So a burst of work reads as one row even when the model emits one tool call per turn — which is the common case.

Groups with a single member are never collapsed — the tool row itself is shown, so a lone command still reads as itself.

```
▌ 用时 11s ▼
I'll check the restock data first.

│ 探索 · 3 steps ▶                ← collapsed group

▌ 用时 11s ▼
I'll check the restock data first.

│ 探索 · 3 steps ▼                ← expanded group: one command per row
├─ Read src/index.ts ▶
├─ Ran pnpm test ▶
└─ Searched "handleMouse" ▶
```

To read one command's raw output, click that row and it opens in place (click again to fold it back):

```
│ 探索 · 3 steps ▼
├─ Read src/index.ts ▶
├─ Ran pnpm test ▼
│   pnpm test                    ← Pi's own rendering
│   Tests 42 passed
│   ... (18 more lines, ctrl+o to expand)
└─ Searched "handleMouse" ▶
```

Group state and run state are independent: expanding the run shows groups in whatever state you left them, including which commands were opened.

## Interaction

| Trigger | Effect |
|---|---|
| `f2` | Collapse or expand the current run's work |
| `shift+f2` | Expand or collapse every action group |
| Mouse click on the run header | Same as `f2`, **fullscreen TUI mode only** |
| Mouse click on a group header | Expand or collapse that one action group, **fullscreen TUI mode only** |
| Mouse click on a member command row | Open or fold that one command's raw output in place (the whole row is clickable), **fullscreen TUI mode only** |
| `/clean` | Same as the shortcut |
| `/clean config` | Open the interactive settings panel |
| `/config:clean-mode` | Open the interactive settings panel |
| `/config:clean-mode <key>=on\|off` | Change one boolean setting and save it, without opening the panel |

### Settings panel

Pi's built-in `/settings` only manages core options and has no extension registration API, so clean mode ships its own panel: `/clean config` (or bare `/config:clean-mode`) replaces the editor with a list of every option.

- `↑` / `↓` move, `enter` / `space` toggles, `esc` closes
- `activityRows` opens a second list with `1`–`20`; `enter` picks, `esc` leaves it unchanged
- the selected row shows its description, and the current value is on the right
- each change is written to the config file immediately; a failed write shows an error notice instead of silently keeping the value only in memory

Mouse support needs `pi --tui-mode fullscreen`; in regular mode the terminal owns mouse input and scrolling, so Pi never receives the click. The clickable area is the header line (the `▌ Working · Ns` state line while a run is active) plus the blank line above it. Clicking the answer body does nothing.

If you toggle the state yourself during a run, that run is not collapsed automatically at the end — your choice is respected until the next run starts. Collapsing by hand folds the work away only: the top `▌ Working · Ns` state line keeps showing until the run settles and becomes `▌ Took …`.

## What a collapsed run looks like

Each level gets its own treatment so the hierarchy reads at a glance and never blends into the prose. The hierarchy comes from a **left rail plus text weight and colour tiers**; both rails start at column 0, so both labels line up in the same column — but the two rails are not one perfectly aligned continuous track. A half-block `▌` sits in the left half of its cell and the centred `│` sits in the middle, half a cell apart, so the row above a group header is left blank instead of using a rail to bridge the two ends:

```
▌ 用时 21s · 5 步 ▼
│ 探索 · 3 步 ▼
├─ 运行命令 ls -la ▶
└─ 按类别：目录、视频、Excel、其他。
```

| Level | Treatment | Meaning |
|---|---|---|
| Run header | heavy rail `▌` + **bold** primary text + chevron right after the text | a whole run is folded here |
| Action group header | light rail `│` + normal weight + muted colour + chevron right after it (the row above it is left blank) + **tool background** | one action, or a group of them, is folded here |
| Member command rows | tree prefix `├─` / `└─` + muted summary + **tool background** | this command is not text the agent wrote |
| Prose | no rail, no background, Pi's own look | content that is not folded |

The row above a group header is left blank and draws no rail: that row would hold nothing but a short vertical line with no text next to it, which reads as a stray stroke hovering above the header (it was drawn this way once), and the two rails sit half a cell apart anyway, so bridging them only makes the offset more obvious. The blank row still belongs to the same click target as the header, so clicking it still expands or collapses the group. The group header text and, once expanded, each member command's summary text use the muted colour: they announce that something is there, they are not prose, and they should not outshout it.

Blocks written by extensions during a run (pi-extensions-i18n notices, workflow result panels, `pi-distill` audit cards) follow the track as well: unless the run is collapsed, every one of their lines gets the same light rail prefix and the content shifts right by two columns, so a full-width block no longer cuts the track in half. Collapsed runs and moments outside a run get no rail — the group header is not on screen then, and a lone structural character would read as a stray fragment.

Putting a block on the rail also drops the blank line it carries at the top (Pi's `CustomEntryComponent` and `CustomMessageComponent` each prepend a `Spacer(1)`): during a run the transcript is a one-row-per-record list, so that blank reads as a hole in it — everything above and below is packed tight, yet each extension block pushes an empty row in between. Dropping it puts the block flush against its neighbours, one row per notice. Blocks outside a run keep Pi's own spacing.

None of them carry a source prefix: the headers are drawn every run in a fixed position, so a prefix is pure noise and would push the text into a column different from the detail rows. The bold primary-coloured line at the very top of the run is itself the marker that says clean mode drew this.

A single action uses its own summary as the label (`Run Command ls -la`); two or more are summarised as `{leading word} · N steps`. **When no single kind of action is over half the group it no longer falls back to a vague `Explored · N steps`: it spells out what the group was made of** (`Run Command 2 · Read File 1`, most frequent first), and only falls back to the generic wording when the counts are unavailable. Every folded row and every visible tool row ends its first line with `▶` / `▼`, sitting right after the text: state and "clickable" in one glance, with no key hint to learn.

**A background is used on tool rows only**: group headers and member command rows (when collapsed, the header stands in for those calls) get Pi's own three tool backgrounds — a member row reads its own state (`toolPendingBg` while running, `toolErrorBg` on failure, `toolSuccessBg` otherwise), and a group header counts as running only when it is the current group *and* the run has not settled (otherwise the last group would keep the in-progress tint forever). This is not a hierarchy tier, it is "this is not text the agent wrote": Pi's own tool rows always had a background, and the summary rows that replace them have to carry that meaning back. The block is padded to the full width, so these rows truncate and pad themselves. Headers, prose and the activity block stay background-free; a theme missing these keys degrades the row to plain text.

## How the work/final split is decided

Pi exports its transcript components, so this package replaces `AssistantMessageComponent.render` and `ToolExecutionComponent.render` on the prototype:

| Component | Collapsed behaviour |
|---|---|
| Assistant message **with** tool calls | hidden entirely (narration belongs to the work) |
| Assistant message **without** tool calls | kept, with the duration header attached |
| Tool row | hidden entirely, or reduced to one action-group header row |
| Extension entry (custom entry) | rows created during the run or the session-restore window are hidden too; notices split by level: `info` (metrics telemetry, receipts) folds away with the work, `warning` / `error` stay |

A message without tool calls is the final answer because the agent loop only ends once a response has no tool calls left, so there is exactly one such message per run.

Extension entries (rows written with `pi.appendEntry`, such as distill's audit line) are rendered by Pi's internal `CustomEntryComponent`, which is not part of Pi's public exports and carries no collapse signal. This package therefore patches `Container.prototype.render` from pi-tui, recognising entry components by "has entry + renderer + hasContent at once" and returning zero lines when collapsed. Only **work entries** are folded: rows first rendered during a run, or during the session-restore window (`session_start` until the first `agent_start`). Rows that only appear after a run settles (notices, summaries) stay visible, while pi-extensions-i18n notices split by level: `info` notices (pi-metrics' per-turn telemetry, a saved config) are process noise and fold away with the work, whereas `warning` / `error` are the only voice an extension has when something goes wrong, so they always stay — otherwise warnings such as a failed config read would be silently swallowed. Set `hideExtensionEntries: false` to turn the behaviour off.

The same patch puts extension entries and message panels written during a run onto the rail: the content is rendered at `width - 2`, its leading blank line is dropped, and every line gets a `│ ` prefix, so the line width is unchanged and the block's background still reaches the right edge. Ownership is keyed on the entry/message object, so it does not flip when Pi rebuilds the component.

Hidden rows render zero lines, so the duration header lands directly above the final answer. The header itself is a real child component wrapped in `MouseRegion` — not a string prepended during render — because Pi's `Container` computes mouse hit offsets from child heights.

## Live behaviour

The transcript stays expanded while the agent is running — otherwise a collapsed run would show nothing until the answer arrives. When the run settles (`agent_settled`) the work collapses automatically. Automatic collapsing is suppressed for the rest of the run if you toggled the state yourself.

Collapsing by hand while the run is still going (mouse click on the header, `f2`, or `/clean`) folds the work and the activity block away but **keeps the `▌ Working · Ns` state line at the top of the run**: it is the only thing that says the agent is still running, and with everything else folded away the screen would otherwise look dead. The `▌ Took …` header needs a duration, which is only written when the run settles; until then that same slot holds the running state line.

## Resumed sessions

After `/resume`, `/reload`, or `/fork`, historical messages do not replay `agent_start` / `agent_settled`, so the state would stay in the initial expanded form and the whole history would look as if clean mode were off. `session_start` therefore calls `restoreHistory`: when the master switch is on, the history is treated as already settled (collapsed), and the next real run expands again on `agent_start`.

The cost: historical runs have **no duration header**. Durations and step counts live in memory and are never written into the session, so `getRunDuration` has nothing to return after a restore and the header stays hidden. Use `f2` or the command to expand everything.

## Configuration

Config file: `<pi agent dir>/extensions/pi-clean-mode/config.json`. See `config.example.json`.

```json
{
  "enabled": true,
  "autoExpandWhileRunning": true,
  "showRunHeader": true,
  "hideThinking": true,
  "hideExtensionEntries": true
}
```

| Key | Meaning |
|---|---|
| `enabled` | Master switch. When off, every patch passes the original render through untouched. |
| `autoExpandWhileRunning` | Expand while running, then collapse when the run settles. |
| `showRunHeader` | Show the `▌ Took …` header at the top of the run. |
| `enableActionGroups` | Collapse a turn's multiple tool calls into one group header row. |
| `showActivityArea` | Show the live activity block that follows the current action group. |
| `activityRows` | Activity area height, 1-20 (default 4). |
| `animateActivity` | Animate the activity glyph; off keeps a still marker. |
| `hideThinking` | Strip Pi's thinking blocks from the message entirely (on by default). |
| `hideExtensionEntries` | Also collapse extension-written entries when collapsed (on by default); `info` notices fold away too, warnings and errors stay visible. |

`hideThinking` removes the thinking content blocks rather than turning on Pi's own "hide thinking" setting: that setting renders thinking as a one-line placeholder, which still costs a blank row plus the spacer after it even when the label is empty. Removing the blocks drops both rows (a test asserts the line count).

## Debugging

Set `PI_CLEAN_MODE_DEBUG=1` to append event and render decisions to `<pi agent dir>/pi-clean-mode-debug.log`. It is off by default and the flag is read once at process start, so it costs nothing on the render path when disabled.

## Live activity area

While the agent runs, the layout splits in two: **the very top only answers "how long has the whole run taken", and the newest state always sits below the newest action.**

```
user: help me fix xxx
  ▌ 处理中 · 42s                    ← top: run-level state + time (heavy rail, not a background)
  │ Explored · 5 steps ▶              ← current group header: step count (member rows hidden while collapsed)
  ├─ ◐ Thinking  tracing the token expiry path…   ← block: thinking, a sibling of the command rows
  └─ ⠋ Run Command npm test · read 4 · search 3   ← block: the action running now + this run's counters
     ↳ 12 passing                                 ← block: the last line this command has printed so far
```

With the group expanded the same list reads as commands, and the thinking row still closes it:

```
  │ Explored · 5 steps ▼
  ├─ Read src/index.ts ▶
  ├─ Ran ls -la ▶
  ├─ Ran npm test ▶
  └─ ◐ Thinking  tracing the token expiry path…   ← same level as the commands, at the bottom
```

- **Top (run-level state line)**: state plus run-level time only — no counters, no thinking or tool detail, and no spinner: the elapsed time already ticks every second, and a glyph turning every 150ms only adds a second thing that moves up there. While running it reads `▌ Working · 42s`; when the run settles the same slot holds `▌ Took 42s · 3 steps ▶`, so switching state changes the text, not the layout.
- **Group header**: the leading word follows what the group actually did — when one kind of action is over half the group it names it (`Run Command · 12 steps`); when the mix has no majority it spells out the composition (`Run Command 2 · Read File 1`), falling back to the generic `Explored · N steps` only when counts are unavailable. Counters are not here; they drop to a tail note on the block's last item row.
- **An action is named once**: with a single member the group header *is* that action's summary (`Run Command npm test ▶`), so the block does not list the action again — it only adds the thinking head and the output tail. A collapsed multi-member header is a summary line without action names, so there the block lists what is running; once the group is expanded the commands are already listed one per row, so the block drops the action name again.
- **Activity block**: attached below the current group's **last visible row**. With the group expanded that is its last member; with the group collapsed the member rows render zero lines and the group header is the only visible row, so the block follows it. Either way it sits at the bottom of the list instead of hanging in the middle.
- **The block hangs off the group header with tree lines**: each item starts with `├─` (another item follows) or `└─` (the last one), an output tail sits at the column after the branch, and a continuation whose owner still has siblings gets a `│`. The branch sits in the same column as the group header rail, so the whole thing reads as one track. Indentation alone does not say which row above an item belongs to; dropping the action name (single-member group) recomputes the closing branch, so the thinking row takes over as the last item.
- **The thinking row is a sibling of the command rows**: member rows of an expanded group use the same tree prefix, so the thinking row reads as the last item of that list (the last command yields its `└─` to it) instead of hanging under some command's multi-line output.

At any moment, the newest state is at the bottom of what you see. When the run itself is collapsed (tool rows render zero lines) the block is not drawn at all and only the top state line remains — collapsing means folding the process away.

**Counters no longer live in the group header**: they are appended to the block's last *item* row (the running action, or the thinking head), e.g. `└─ ⠋ Run Command npm test · read 3 · command 2`. Appending to an already rendered row instead of taking a row of its own means they cost no row budget, and a single-member group that drops its action row does not lose them. They are **not** appended to the output tail: that row is what the command itself printed, and counters behind it read like a summary of that command. They are suppressed entirely when only one action has run — the header already names that action.

Every row in the block is a plain row (nothing repeated from the top, each row prefixed with a `├─` / `└─` tree line): the thinking head, then each running tool (one row per parallel call) with its latest output line. Contents come from real events only, never guessed progress.

Two implementation constraints matter:

1. **Unchanged content never repaints.** Each tick renders the lines into a string and compares it with the previous tick; when it matches, no repaint is requested at all.
2. **The block only grows.** During a run it is padded with blank rows up to the largest height seen in that run, so the rows below it never get pushed around. Animation advances one frame every 150ms (about 6.7fps), the timer only exists while a run is active and is `unref()`-ed; with `animateActivity: false` it slows to 1s and shows still markers.

While the area shows the current action, Pi's own `Working...` line is suppressed so the two do not say the same thing twice. That takeover lasts the **whole run**: once the block has taken over, the built-in line stays hidden until the run settles (`clearActivityArea` hands it back at the end). It is never flashed back for the one or two frames where the block happens to be empty (a tool just finished, the next one has not started) — that line carries the elapsed time, and flickering is worse than a duplicate. It is only handed back when the run-level state line is off too (`showRunHeader: false`) and the current frame has no block rows, because then it is the only feedback on screen.

Rendering is split in three places that share the same row data (`runtime.activityArea.rows` is padded to the largest height seen, then rendered into the full `lines` and the action-name-free `detailLines`): the current group's tool rows append the block after themselves (`appendActivityTail` in `component-patches.ts`; only the last visible row appends), the run-header component emits run-level time only (`createRunHeaderComponent`, reading `getRunStatusLines`), the group header gets its leading word from `getGroupActivityLabel` (the group's majority class, via `dominantActivityClass`), and the counter tail note is appended by `activity-area.ts` to the last *item* row (`formatActivityCountersNote` + `appendActivityCountersNote`) — counts accumulate per group (the `activity` field of `registerActionToolCall`), so historical groups still describe themselves. **Tool calls are registered as soon as they stream**: `stream-registration.ts` scans the streaming assistant message for tool-call content blocks (`{ type: "toolCall", id, name, arguments }`) and writes them into the action group before Pi renders that tool row — relying on `tool_call` / `tool_execution_start` alone is about 300ms late, so the row would be drawn once as an unregistered raw row and only then be folded away. Group boundaries are opened in that same state machine and always before registration, so when narration arrives *after* a tool call those already-registered calls are moved to the new group. A single-member group and an expanded multi-member group both use the action-name-free form (`resolveActivityTail`; the expanded list already names every command), while a collapsed multi-member group lists what is running. Every activity row is truncated to the current render width before it is appended (`clampLinesToWidth`): in main-screen mode pi-tui throws and stops on a line wider than the terminal, and in fullscreen mode the line is clipped. All three only accept "the current group" and "the current run's header host", so historical turns never repeat the same content. Neither headers nor block rows carry a background; the tool background is painted on group headers and member command rows only, and padding rows still render as blank.

## Compatibility

This package patches Pi component prototypes, so it is coupled to Pi's exported component surface (`AssistantMessageComponent.hasToolCalls`, `ToolExecutionComponent.render`, and the empty-render-means-zero-lines behaviour). It restores the original prototypes on reload and shutdown, and refuses to overwrite a prototype that another extension replaced after install.

Folding extension entries (`hideExtensionEntries`) additionally patches `Container.prototype.render` from pi-tui: Pi's internal `CustomEntryComponent` is not publicly exported, so the patch recognises it by structure ("has entry + renderer + hasContent at once"). If Pi renames those fields or lets the entry component override `render`, this single behaviour degrades silently (entries become visible again) instead of failing; `tests/extension-entry-patch.test.ts` guards the recognition.

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
