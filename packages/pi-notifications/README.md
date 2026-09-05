# pi-notifications

Configurable external notifications for the [Pi coding agent](https://pi.dev).

[中文文档](./README.zh-CN.md)

## Features

- Sends a system notification before `ask_user_question` or the legacy `ask_user` tool waits for input.
- Sends a completion notification after each Pi agent run, including whether a tool reported an error and the number of completed turns.
- Runs the adapter with Node's argv API, never through a shell, so notification text is not re-parsed as command syntax.
- Detects the configured command at runtime. A missing command or the first failed invocation produces one in-session warning and then disables external notifications for that runtime.
- Notification failures never block Pi's agent lifecycle or tool execution.
- All runtime messages are localized through `pi-extensions-i18n`.

## Install

```bash
pi install npm:pi-notifications
```

Then reload Pi:

```text
/reload
```

Install the shared i18n package automatically through this package's dependency. The default adapter expects `terminal-notifier` to be available in `PATH`.

## Configuration

The optional configuration file is:

```text
<pi-agent-dir>/extensions/pi-notifications/config.json
```

`<pi-agent-dir>` is Pi's configured agent directory (normally `~/.pi/agent`). Start from [`config.example.json`](./config.example.json). Configuration fields are:

- `enabled`: set to `false` to disable external notifications.
- `adapter.command`: executable name or path.
- `adapter.args`: argv entries. `{title}`, `{subtitle}`, and `{message}` are replaced in each entry.
- `timeoutMs`: maximum time for one adapter invocation.

For example, a custom adapter can use an executable directly:

```json
{
  "enabled": true,
  "adapter": {
    "command": "notify-send",
    "args": ["{title}", "{message}"]
  },
  "timeoutMs": 3000
}
```

The configuration file is read when the extension loads. Reload Pi after changing it. A missing file uses the default `terminal-notifier` configuration. A malformed file is reported in Pi and uses the default configuration.

## Default adapter

The default argv is equivalent to:

```text
terminal-notifier -title <title> -subtitle <subtitle> -message <message> -sound default -timeout 5
```

Install it using the package manager appropriate for your operating system, or configure another notification executable. The package does not assume a specific operating system daemon.

## Localization

Runtime messages are provided in `zh-CN` and `en-US` through `pi-extensions-i18n`. Set the shared language with `/config:language` or `PI_EXTENSIONS_LOCALE`.

## License

MIT
