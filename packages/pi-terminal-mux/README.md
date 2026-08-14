# pi-terminal-mux

Terminal multiplexer abstraction for pi extensions — one unified surface API across **muxy, cmux, tmux, zellij, wezterm, herdr, otty and orca**, with automatic **headless fallback** (background child process + log file) when no multiplexer is detected.

Any pi extension that needs terminal interaction (splitting panes, sending commands, reading screens, closing panes, waiting for process exit) should depend on this package instead of re-implementing backend detection and command assembly.

[中文文档](./README.zh-CN.md)

## Install

```bash
npm install pi-terminal-mux
```

## Quick start

```ts
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  createSurfaceSplit,
  sendCommand,
  sendLongCommand,
  sendEscape,
  readScreen,
  closeSurface,
  pollForExit,
} from "pi-terminal-mux";

if (!isMuxAvailable()) {
  console.warn(muxSetupHint()); // localized setup hint via pi-extensions-i18n
}

// Smart placement: split / stack / new tab depending on the backend strategy
// (returns a headless surface when no multiplexer is available)
const surface = createSurface("my-agent");

// Long commands are written to a script file first to avoid terminal line wrapping
// (Bash by default; pass interpreter: "powershell" on Windows for PowerShell)
const scriptPath = sendLongCommand(surface, "pi --session abc", {
  scriptPreamble: "export MY_FLAG=1",
});

const tail = readScreen(surface, 50);
sendEscape(surface);
closeSurface(surface);
```

## Backend detection

| Backend | Detection |
|---------|-----------|
| muxy | `MUXY_SOCKET_PATH` + `muxy` command |
| cmux | `CMUX_SOCKET_PATH` + `cmux` command |
| tmux | `TMUX` + `tmux` command |
| zellij | `ZELLIJ` / `ZELLIJ_SESSION_NAME` + `zellij` command |
| wezterm | `WEZTERM_UNIX_SOCKET` + `wezterm` command |
| herdr | `HERDR_ENV=1` + `HERDR_PANE_ID` + `herdr` command |
| otty | `TERM_PROGRAM=otty` + `otty` command |
| orca | `TERM_PROGRAM=Orca` + `orca` command + reachable Orca runtime |

Default priority follows the table order (muxy first). Force a backend with:

- `PI_TERMINAL_MUX` (preferred): `muxy | cmux | tmux | zellij | wezterm | herdr | otty | orca`
- `PI_SUBAGENT_MUX`: backward-compatible alias

If the forced backend's runtime is unavailable, `getMuxBackend()` returns `null` — it never silently falls back to another backend.

## API overview

### Unified surface API (same semantics across backends)

| Function | Description |
|----------|-------------|
| `createSurface(name)` | Smart placement (cmux: first right-split then tabs; zellij: tab-aware tiled/stacked; muxy/otty/orca: breadth-first splits; orca falls back to a new tab without an agent handle), returns a surface handle |
| `createSurfaceSplit(name, direction, fromSurface?, options?)` | Split in an explicit direction (left/right/up/down). `options.activate` (WezTerm only, default `false`) focuses the new pane after splitting |
| `sendCommand(surface, command)` | Send a command and press Enter |
| `sendLongCommand(surface, command, opts?)` | Write long commands to a script file first. `opts.scriptPreamble` injects leading lines; `opts.interpreter` (`"bash"` default, or `"powershell"` on Windows) selects the scripting runtime; returns the script path |
| `sendEscape(surface)` | Send one ESC keypress |
| `readScreen(surface, lines?, options?)` / `readScreenAsync` | Read the last N screen lines. `options.source` (herdr-only) forwards a herdr read source such as `"recent_unwrapped"`; other backends ignore it |
| `closeSurface(surface)` | Close the surface |
| `renameSurface(surface, name)` / `renameCurrentTab(title)` / `renameAgent(surface, name)` / `renameWorkspace(title)` | Naming, degrading per backend capability |
| `pollForExit(surface, signal, opts)` | Wait for the process in a surface to exit: `.exit` sidecar file first, then a screen sentinel (`__SUBAGENT_DONE_<code>__`); headless uses child process exit |
| `getLastSplitSource()` / `clearLastSplitSource()` | Source pane of the most recent split (for UI display) |

### Detection and utilities

`getMuxBackend()`, `isMuxAvailable()`, `isHeadlessMode()`, `muxSetupHint()`, `getAgentPaneId(backend?)`, `backendAgentPaneEnvVar(backend)`, `shellEscape()`, `isFishShell()`, `exitStatusVar()`, plus zellij placement planning (`selectZellijPlacement` etc.) and cmux/otty JSON parsing helpers — all pure and unit-testable.

### Backend-native APIs

Backend-native functions are also re-exported (e.g. `createHerdrSurface`, `splitHerdrPane`, `readHerdrScreen`, `sendOttyCommand`, `renameOttyTab`, `createOrcaSurface`, `sendOrcaCommand`, ...). Subpath imports are available too: `pi-terminal-mux/mux`, `pi-terminal-mux/herdr`, `pi-terminal-mux/otty`, `pi-terminal-mux/orca`.

## Headless mode

When no backend is detected, `createSurface` returns a `headless:`-prefixed surface, `sendLongCommand` spawns a background child process writing to a log file, and `readScreen` / `pollForExit` / `closeSurface` keep the same semantics — callers need no special-casing.

## Windows PowerShell support

All platforms keep **Bash as the default** scripting runtime to preserve existing caller semantics. On Windows 11 PowerShell/WezTerm/herdr, opt in explicitly:

- **Command submission (WezTerm)**: the Enter terminator is `\r` on `win32` and `\n` elsewhere, so PowerShell input is submitted exactly once instead of stopping at the continuation prompt.
- **Long commands (`sendLongCommand`)**: pass `interpreter: "powershell"` to generate a `.ps1` and run it via `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File <path>` (mux) or `-Command "& <path>"` (headless). Explicit `scriptPath` is preserved as-is; auto paths choose `.ps1`/`.sh` by interpreter. Omitted `interpreter` keeps the existing Bash command, `.sh` paths and `$?` numeric sentinels unchanged.
- **Screen capture (`readScreen` / `readScreenAsync`)**: pass `{ source: "recent_unwrapped" }` (herdr-only) to select herdr's soft-wrap merged capture; omitted options keep herdr `recent` and other backends keep their own read semantics.

These are opt-in capabilities — existing Bash callers and `pi-interactive-subagents` continue to run under the default Bash runtime on every platform.

## Environment variables

| Variable | Description |
|----------|-------------|
| `PI_TERMINAL_MUX` / `PI_SUBAGENT_MUX` | Force a backend |
| `PI_SUBAGENT_ZELLIJ_MIN_COLUMNS` / `PI_SUBAGENT_ZELLIJ_MIN_ROWS` | Minimum usable size for zellij splits (default 50x10; stacks instead when smaller) |
| `PI_SUBAGENT_RENAME_TMUX_WINDOW` / `PI_SUBAGENT_RENAME_TMUX_SESSION` | Allow renameCurrentTab / renameWorkspace on tmux (user naming untouched by default) |
| `PI_SUBAGENT_RENAME_HERDR_WORKSPACE` | Allow renameWorkspace on herdr |
| `PI_EXTENSIONS_LOCALE` | Hint language (`zh-CN` / `en-US` / `auto`), provided by pi-extensions-i18n |

## Design constraints

- **No machine coupling**: every backend is selected via runtime detection (env vars + command availability); no hardcoded local paths; missing CLIs degrade backend-by-backend down to headless.
- **Localized user-facing text**: setup hints go through the [pi-extensions-i18n](https://www.npmjs.com/package/pi-extensions-i18n) catalog with complete `zh-CN` and `en-US` entries.
- **Agent pane anchoring**: the agent's own pane ID on muxy/herdr/otty/orca is captured at module load (`AGENT_MUXY_PANE_ID`, `AGENT_ORCA_TERMINAL_HANDLE` etc.), immune to later focus switches.

## License

MIT
