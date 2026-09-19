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

探索 · 3 steps ▶          ← collapsed group

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
| `/clean config` | Open the interactive settings panel |
| `/config:clean-mode` | Open the interactive settings panel |
| `/config:clean-mode <key>=on\|off` | Change one boolean setting and save it, without opening the panel |

### Settings panel

Pi's built-in `/settings` only manages core options and has no extension registration API, so clean mode ships its own panel: `/clean config` (or bare `/config:clean-mode`) replaces the editor with a list of every option.

- `↑` / `↓` move, `enter` / `space` toggles, `esc` closes
- `activityRows` opens a second list with `1`–`20`; `enter` picks, `esc` leaves it unchanged
- the selected row shows its description, and the current value is on the right
- each change is written to the config file immediately; a failed write shows an error notice instead of silently keeping the value only in memory

Mouse support needs `pi --tui-mode fullscreen`; in regular mode the terminal owns mouse input and scrolling, so Pi never receives the click. The clickable area is the header line (the `Working · Ns` band while a run is active) plus the blank line above it. Clicking the answer body does nothing.

If you toggle the state yourself during a run, that run is not collapsed automatically at the end — your choice is respected until the next run starts. Collapsing by hand folds the work away only: the top `Working · Ns` band keeps showing until the run settles and it becomes `Took …`.

## What a collapsed run looks like

Each level gets its own treatment so the hierarchy reads at a glance and never blends into the prose:

```
 用时 21s · 5 步 ▼
 探索 · 3 步 ▼
 运行命令 ls -la ▶
 按类别：目录、视频、Excel、其他。
```

| Level | Treatment | Meaning |
|---|---|---|
| Run header | full-width **band** with a background + chevron right after the text | a whole run is folded here |
| Action group header | same label column as the run header + a **chip** (background only behind the label) + chevron right after it | one action, or a group of them, is folded here |
| Prose and tool rows | no background, Pi's own look | content that is not folded |

A single action uses its own summary as the label (`Run Command ls -la`); two or more are summarised as `Explored · N steps`. Every folded row and every visible tool row ends its first line with `▶` / `▼`, sitting right after the text: state and "clickable" in one glance, with no key hint to learn.

Backgrounds come from Pi's own theme keys (`customMessageBg` for the run band, `toolPendingBg` for the action chip), so this reads as the same visual language as extension message blocks and tool rows. If a theme is missing a colour key, only that layer of decoration is dropped — the layout is unaffected.

## How the work/final split is decided

Pi exports its transcript components, so this package replaces `AssistantMessageComponent.render` and `ToolExecutionComponent.render` on the prototype:

| Component | Collapsed behaviour |
|---|---|
| Assistant message **with** tool calls | hidden entirely (narration belongs to the work) |
| Assistant message **without** tool calls | kept, with the duration header attached |
| Tool row | hidden entirely, or reduced to one action-group header row |
| Extension entry (custom entry) | rows created during the run or the session-restore window are hidden too; notices are exempt |

A message without tool calls is the final answer because the agent loop only ends once a response has no tool calls left, so there is exactly one such message per run.

Extension entries (rows written with `pi.appendEntry`, such as distill's audit line) are rendered by Pi's internal `CustomEntryComponent`, which is not part of Pi's public exports and carries no collapse signal. This package therefore patches `Container.prototype.render` from pi-tui, recognising entry components by "has entry + renderer + hasContent at once" and returning zero lines when collapsed. Only **work entries** are folded: rows first rendered during a run, or during the session-restore window (`session_start` until the first `agent_start`). Rows that only appear after a run settles (notices, summaries) stay visible, and pi-extensions-i18n notices are exempt at all times — otherwise warnings such as a failed config read would be folded away with the work. Set `hideExtensionEntries: false` to turn the behaviour off.

Hidden rows render zero lines, so the duration header lands directly above the final answer. The header itself is a real child component wrapped in `MouseRegion` — not a string prepended during render — because Pi's `Container` computes mouse hit offsets from child heights.

## Live behaviour

The transcript stays expanded while the agent is running — otherwise a collapsed run would show nothing until the answer arrives. When the run settles (`agent_settled`) the work collapses automatically. Automatic collapsing is suppressed for the rest of the run if you toggled the state yourself.

Collapsing by hand while the run is still going (mouse click on the band, `f2`, or `/clean`) folds the work and the activity block away but **keeps the `Working · Ns` band at the top of the run**: it is the only thing that says the agent is still running, and with everything else folded away the screen would otherwise look dead. The `Took …` band needs a duration, which is only written when the run settles; until then that same slot holds the running status band.

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
| `showRunHeader` | Show the `Took …` band at the top of the run. |
| `enableActionGroups` | Collapse a turn's multiple tool calls into one group header row. |
| `showActivityArea` | Show the live activity block that follows the current action group. |
| `activityRows` | Activity area height, 1-20 (default 4). |
| `animateActivity` | Animate the activity glyph; off keeps a still marker. |
| `hideThinking` | Strip Pi's thinking blocks from the message entirely (on by default). |
| `hideExtensionEntries` | Also collapse extension-written entries when collapsed (on by default); notices stay visible. |

`hideThinking` removes the thinking content blocks rather than turning on Pi's own "hide thinking" setting: that setting renders thinking as a one-line placeholder, which still costs a blank row plus the spacer after it even when the label is empty. Removing the blocks drops both rows (a test asserts the line count).

## Debugging

Set `PI_CLEAN_MODE_DEBUG=1` to append event and render decisions to `<pi agent dir>/pi-clean-mode-debug.log`. It is off by default and the flag is read once at process start, so it costs nothing on the render path when disabled.

## Live activity area

While the agent runs, the layout splits in two: **the very top only answers "how long has the whole run taken", and the newest state always sits below the newest action.**

```
user: help me fix xxx
  ⠋ Working · 42s                     ← top: run-level state + time (the only band on screen)
 Explored · 5 steps · read 4 · search 3 ▶  ← current group header: step count + this run's counters
 Run Command ls -la ▶
 Run Command npm test                  ← newest action (the block attaches below it)
  ├─ ◐ Thinking  tracing the token expiry path…   ← block: thinking
  └─ ⠋ Run Command npm test                        ← block: the action running now
     ↳ 12 passing                                  ← its latest output
```

- **Top (run-level band)**: state plus run-level time only — no counters, no thinking or tool detail. While running it reads `[clean] ⠋ Working · 42s`; when the run settles the same slot holds `[clean] Took 42s · 3 steps ▶`, so switching state changes the text, not the layout.
- **Group header chip**: the leading word follows what the group actually did — when one kind of action is over half the group it names it (`Run Command · 12 steps`), and only a group with no majority falls back to the generic `Explored · N steps`. The counters after it (`· read 3 · command 2`) are this run's totals: they do not take a row of their own — on its own row the counters simply count the same thing as the step count, and with the top band that makes three places reporting progress — and only the current group shows them.
- **An action is named once**: with a single member the group header *is* that action's summary (`Run Command npm test ▶`), so the block does not list the action again — it only adds the thinking head and the output tail. A multi-member header is a summary line without action names, so there the block lists what is running.
- **Activity block**: attached below the current group's **last visible row**. With the group expanded that is its last member; with the group collapsed the member rows render zero lines and the group header is the only visible row, so the block follows it. Either way it sits at the bottom of the list instead of hanging in the middle.
- **The block hangs off the group header with tree lines**: each item starts with `├─` (another item follows) or `└─` (the last one), an output tail sits at the column after the branch, and a continuation whose owner still has siblings gets a `│`. Indentation alone does not say which row above an item belongs to; dropping the action name (single-member group) recomputes the closing branch, so the thinking row takes over as the last item.

At any moment, the newest state is at the bottom of what you see. When the run itself is collapsed (tool rows render zero lines) the block is not drawn at all and only the top band remains — collapsing means folding the process away.

Every row in the block is a plain row (no background band, nothing repeated from the top, each row prefixed with a `├─` / `└─` tree line): the thinking head, then each running tool (one row per parallel call) with its latest output line. Contents come from real events only, never guessed progress.

Two implementation constraints matter:

1. **Unchanged content never repaints.** Each tick renders the lines into a string and compares it with the previous tick; when it matches, no repaint is requested at all.
2. **The block only grows.** During a run it is padded with blank rows up to the largest height seen in that run, so the rows below it never get pushed around. Animation advances one frame every 150ms (about 6.7fps), the timer only exists while a run is active and is `unref()`-ed; with `animateActivity: false` it slows to 1s and shows still markers.

While the area shows the current action, Pi's own `Working...` line is suppressed so the two do not say the same thing twice.

Rendering is split in three places that share the same row data (`runtime.activityArea.rows` is padded to the largest height seen, then rendered into the full `lines` and the action-name-free `detailLines`): the current group's tool rows append the block after themselves (`appendActivityTail` in `component-patches.ts`; only the last visible row appends), the run-header component emits run-level time only (`createRunHeaderComponent`, reading `getRunStatusLines`), and the group chip gets its leading word from `getGroupActivityLabel` (the group's majority class, via `dominantActivityClass`) plus this run's counters from `getActivityCounters` (built by `formatActivityCountersSuffix`) — counts accumulate per group (the `activity` field of `registerActionToolCall`), so historical groups still describe themselves. A single-member group uses the action-name-free form and keeps thinking plus output tails; multi-member groups list what is running. All three only accept "the current group" and "the current run's header host", so historical turns never repeat the same content. Only the run-level band gets a background (`bandActivityHead`); block rows carry their tree prefix and padding rows still render as blank.

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
