# pi-session-resources

A passive session-context extension for the [Pi coding agent](https://github.com/earendil-works/pi). It collects files and links from successful tool activity and renders them as clickable OSC 8 links above the editor.

[中文文档](./README.zh-CN.md)

## Features

- Tracks files read, changed, inspected, or opened by built-in and custom tools.
- Tracks structured HTTP(S) URL fields plus links emitted by browser, shell, and MR/PR creation tools.
- Recognizes GitHub pull requests and GitLab merge requests and marks creation commands such as `gh pr create` and `glab mr create`.
- Rebuilds state from the active session branch after reload, resume, fork, or `/tree` navigation. It does not add tracking entries to model context.
- Splits recent resources into file, PR/MR, and web tabs and renders them as OSC 8 hyperlinks. File links use `file://`; web and review links keep their original URL.
- Provides both `zh-CN` and `en-US` UI text through `pi-extensions-i18n`.

Example:

```text
╭─ ◆ SESSION RESOURCES ─────────────────────────────╮
│ ‹  ▤ FILE 3   ⎇ PR/MR 1   ◎ WEB 2  ›             │
│  ▤ src/index.ts                     [write · read] │
│  ▤ docs/session notes.md            [read]         │
├───────────────────────────────────────────────────┤
│  Ctrl+↑ to browse · Ctrl+O to expand               │
╰───────────────────────────────────────────────────╯
```

The widget stays above the editor and shows one resource type at a time, so files, PR/MR links, and web links are not mixed. Ctrl+Up temporarily replaces the input editor with the focused browser instead of placing a short overlay below it; the original editor text and focus return when it closes. Use Left/Right to switch tabs and Down or Esc to return.

Collapsed mode shows the 4 most recent resources in the current tab. Expanded mode shows up to 16 and reports how many older resources remain hidden. The widget follows Pi's built-in `app.tools.expand` state, so Ctrl+O expands or collapses tool output and session resources together. If the user remaps that built-in action in `keybindings.json`, the widget follows the remapped key without registering a competing shortcut.

## Commands

```text
/config:session-resources             Open the focused tab browser
/config:session-resources show        Show the widget
/config:session-resources hide        Hide the widget
/config:session-resources expand      Show more resources in the current tab
/config:session-resources collapse    Return the current tab to compact view
```

`/session-resources` remains available as a compatibility alias.

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
- File contents and generic prose are not scanned for loose URLs or paths, preventing a README or source file from flooding the widget with unrelated references.

Relative paths embedded only inside an arbitrary shell command are not parsed as shell syntax. Built-in file tools, structured custom-tool path fields, absolute paths, and URLs are tracked reliably; this avoids treating ordinary command text as files.

## OSC 8 compatibility

Click behavior depends on the terminal. Pi fullscreen mode can open OSC 8 links directly, while many terminals use Cmd/Ctrl-click in normal mode. Unsupported terminals still show readable labels.

File targets are generated with `pathToFileURL()`, and structured HTTP(S) URL fields are normalized with `URL`, so spaces and other unsafe target characters are percent-encoded before entering OSC 8. Plain-text tool output must still contain a syntactically valid URL; URLs containing spaces should use `%20`, because whitespace is necessarily treated as the boundary between prose and a loose URL.

## Privacy and portability

The package makes no network requests and starts no background process. Collected state stays in memory and is reconstructed from the current Pi session branch, whose tool calls and results already contain the source data. Labels omit URL query strings, while the clickable target preserves the original URL.
