# pi-session-resources

A passive session-resource reference extension for the [Pi coding agent](https://github.com/earendil-works/pi). It collects files, web pages, and PR/MR links from successful tool activity, then opens a tabbed resource picker above the editor when you type `#`.

[中文文档](./README.zh-CN.md)

## Features

- Tracks files read, changed, inspected, or opened by built-in and custom tools.
- Tracks structured HTTP(S) URL fields plus links emitted by browser, shell, and MR/PR creation tools.
- Recognizes GitHub pull requests and GitLab merge requests and marks creation commands such as `gh pr create` and `glab mr create`.
- Rebuilds state from the active session branch after reload, resume, fork, or `/tree` navigation. It does not add tracking entries to model context.
- Shows a rounded, accent-bordered resource picker only after `#` is typed, with no persistent panel. It follows the editor width as the terminal resizes, while files, PR/MR links, and URLs stay in separate tabs.
- Fuzzy-filters recent resources by label, target, kind, action, and source tool. The frame, selected arrow, and selected label use the subagent widget's fixed `#4DA3FF` accent; the selected label is bold, while actions stay dim.
- Renders candidate labels as OSC 8 hyperlinks. File links use `file://`; web and review links keep their original URL.
- Shows a one-line `查看资源` / `View resources` button above the editor in Pi fullscreen mode. Clicking it opens the picker panel, and the pointer can then switch tabs, highlight rows, and open resources without touching the keyboard.
- Provides both `zh-CN` and `en-US` UI text through `pi-extensions-i18n`.

## Usage

Type `#` at a token boundary in the editor, or click the fullscreen resource button:

```text
╭─ Session resources ────────────────────────────────────╮
│  FILE 8   PR/MR 2   URL 3                              │
├────────────────────────────────────────────────────────┤
│ → src/index.ts                                write · read │
│   tests/index.test.ts                                write │
├────────────────────────────────────────────────────────┤
│ Left/Right or Tab/Shift+Tab type · Up/Down select · Enter insert │
╰────────────────────────────────────────────────────────╯
Please inspect #ind
```

- Continue typing after `#` to filter the current type live.
- Left/Right switches resource types while the picker is open. Tab selects the next type and Shift+Tab selects the previous type.
- Up/Down wraps through resources in the current type.
- Enter inserts the selected reference. Esc closes the picker and keeps the typed text.
- At most 6 recent matches are shown for the current type.

File references use the session display path, such as `#src/index.ts`; paths containing whitespace are inserted as `#"docs/design notes.md"`. Web and PR/MR references insert the full URL. A reference is ordinary prompt text: it does not read a file again or add hidden model context.

Candidate labels are OSC 8 hyperlinks and the whole row is the link target. Unsupported terminals still show readable labels.

## Mouse browsing (fullscreen)

Pi only routes mouse input to components in fullscreen mode, so start Pi with `pi --tui-mode fullscreen` (or `"tuiMode": "fullscreen"` in settings). The button only appears when at least one resource was collected:

```text
 查看资源 FILE 3 · PR/MR 1 · URL 2
╭─ Session resources ────────────────────────────────────╮
│  FILE 8   PR/MR 2   URL 3                              │
├────────────────────────────────────────────────────────┤
│ → src/index.ts                                write · read │
│   tests/index.test.ts                                write │
├────────────────────────────────────────────────────────┤
│ ←/→ type · ↑/↓ select · Enter insert · click open      │
╰────────────────────────────────────────────────────────╯
```

- Click the button to open the picker without typing `#`. The picker then opens with an empty query, so typing goes back to the editor instead of filtering.
- Click a tab to switch resource type; the pointer highlights the tab, the rows, and the button while hovering.
- Click a resource row to open it, which is the same result as Cmd+click on an OSC 8 link: Pi's fullscreen renderer runs its own URL opener for the clicked link.
- Shift+click (or Ctrl+click) a resource row to insert the reference instead of opening it.
- Drag inside the picker to select text, and scroll the transcript with the wheel; the header leaves wheel input to Pi.
- Esc closes the picker, and the `#` flow keeps working unchanged.

The button and mouse handling need a Pi build with the component mouse API (`@earendil-works/pi-tui` 0.85 or newer). Older builds keep the keyboard-only `#` picker and render no button.

## Commands

```text
/config:session-resources             Show the # reference usage hint
/config:session-resources enable      Enable the # resource picker
/config:session-resources disable     Disable the # resource picker
```

`show`/`hide` remain compatibility aliases for `enable`/`disable`, and `/session-resources` remains available as a command alias. The setting is stored in `<pi-agent-dir>/extensions/pi-session-resources/config.json`; use [`config.example.json`](./config.example.json) as a starting point:

```json
{
  "enabled": true
}
```

Use `/config:session-resources enable` or `/config:session-resources disable` to change and persist it. Run `/reload` after changing the file manually.

## Install

```bash
pi install npm:pi-session-resources
```

Then run `/reload` in Pi.

## Detection model

The extension observes Pi's native `tool_result` event and only records successful calls.

- Built-in `read`, `write`, `edit`, `grep`, `find`, and `ls` inputs receive exact action labels.
- Custom tools are recognized through conventional path keys such as `path`, `filePath`, `files`, `directory`, and `outputPath`.
- Structured URL/path fields are extracted recursively; shell, browser, and MR/PR creation tools also support plain-text URL output.
- Browser-open and MR/PR-create actions are inferred conservatively from tool names and command text.
- File contents and generic prose are not scanned for loose URLs or paths, preventing a README or source file from flooding the candidate list with unrelated references.

Relative paths embedded only inside an arbitrary shell command are not parsed as shell syntax. Built-in file tools, structured custom-tool path fields, absolute paths, and URLs are tracked reliably; this avoids treating ordinary command text as files.

## Privacy and portability

The package makes no network requests and starts no background process. Collected state stays in memory and is reconstructed from the current Pi session branch, whose tool calls and results already contain the source data. Labels omit URL query strings, while inserted references and clickable OSC 8 targets preserve the original URL.
