# pi-extensions-i18n

Shared localization runtime for Pi extensions. It provides a small, catalog-backed API for `zh-CN`, `en-US`, and automatic locale selection.

## Why a shared package

Independent Pi extensions still need the same operational pieces: a portable configuration path, locale precedence, fallback behavior, catalog validation, and parameter interpolation. Keeping those pieces here lets feature packages concentrate on their own behavior while keeping user-facing messages consistent.

## Features

- `zh-CN`, `en-US`, and `auto` locale preferences.
- Persistent setting at `~/.pi/agent/extensions/pi-extensions-i18n/config.json`.
- `PI_EXTENSIONS_LOCALE` environment-variable override.
- `/config:language` interactive command, plus `/config:language en-US` direct selection.
- Catalog loading and validation requiring both language entries for every message key.
- Translator interpolation for user-facing UI, command descriptions, and agent prompts.
- A single notice outlet, `notifyWithSource`, that draws every user-visible notice as a filled background block in the transcript (the same block Pi uses for extension messages) with a short `[tag]` source label. Pi renders `info` notices as dim, unprefixed text, so without the block and tag you cannot tell which extension spoke. Every package uses the same muted label colour (`NOTICE_TAG_COLOR`): the tag text identifies the source, the colour deliberately does not — nine theme colour slots cannot tell sixteen packages apart, and a collision would actively mislead.
- Notices land below the message and stay out of the LLM context: they are written as Pi custom entries (`appendEntry` + `registerEntryRenderer`) and only affect the transcript.
- Notice details stay collapsed on a single line with an expand arrow at the end (collapsed `▶`, expanded `▼`, in the accent colour): click the block in fullscreen mode, or press `Ctrl+O` in regular mode (with an older pi-tui that has no `MouseRegion`, keyboard expansion still works). The arrow is used instead of a `Ctrl+O to expand` label because entry renderers cannot tell fullscreen from regular mode — the arrow holds in both, and it is the same glyph clean mode already uses for its headers. A notice without details gets no arrow, so nothing points at an entry that cannot react to a click.

## Install

```bash
pi install npm:pi-extensions-i18n
```

Feature packages use it as a shared dependency and load its extension entry automatically, so installing a feature package is enough to provide the locale command. Install this package directly only when you want the locale command without another feature package.

Reload Pi after installation:

```text
/reload
```

## Locale precedence

```text
PI_EXTENSIONS_LOCALE environment variable
    > persisted config
    > default zh-CN
```

The `auto` preference checks `LC_ALL`, `LC_MESSAGES`, and `LANG`; Chinese system locales resolve to `zh-CN`, and other locales resolve to `en-US`. `zh` and `en` are accepted as short aliases.

Examples:

```bash
PI_EXTENSIONS_LOCALE=en-US pi
```

```text
/config:language en-US
```

## Extension author API
The package exports the locale and catalog primitives used by the feature packages, plus the shared notice outlet:

```ts
import { NOTICE_TAG_COLOR, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** Short, unique notice tag for this package. */
const NOTICE_TAG = "distill";
/** Label colour: every package uses the shared muted colour, the tag text identifies the source. */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** This package's notice source. */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

This renders as a filled background block with `[distill] message` on its first line: the label uses the shared muted `NOTICE_TAG_COLOR`, the body colour follows `level` (`warning` yellow, `error` red, `info` the extension message text colour), and `textColor` overrides the body colour for verdict-style lines that carry their own semantic colour. Level colours are semantic and stay untouched; only the source label gives up colour as an identity channel. In tui mode the notice is written as a Pi custom entry below the message; rpc/print/json keep using `ctx.ui.notify` with plain `[distill] message` text so no ANSI leaks into other frontends. The block is registered once by this package's own extension entry, so a package that uses the helper must load `../pi-extensions-i18n/index.ts` in its `pi.extensions` list. Use `formatNotice({ source, message, mode, theme })` when you only need the rendered string.

Other exports:

```ts
import {
  createTranslator,
  getLocale,
  loadCatalog,
} from "pi-extensions-i18n";

const messages = loadCatalog(new URL("../locales/messages.json", import.meta.url));
const i18n = createTranslator(messages);

i18n.t("description");
getLocale();
```

Catalog entries must contain both locale keys:

```json
{
  "description": {
    "zh-CN": "扩展描述",
    "en-US": "Extension description"
  }
}
```

Invalid catalogs fail during loading, which makes missing translations visible in tests and CI instead of silently leaking a single-language message to users.

## Requirements

- Node.js 22 or newer.
- Pi's extension runtime when using the `/config:language` command. `/pi-language` remains available as a compatibility alias.

## License

[MIT](../../LICENSE)
