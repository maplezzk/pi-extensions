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
- A single notice outlet, `notifyWithSource`, that prefixes every user-visible notice with a short source tag in the package's own label colour. Pi renders `info` notices as dim, unprefixed text, so without a tag you cannot tell which extension spoke.

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
import { notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";

/** Short, unique notice tag for this package. */
const NOTICE_TAG = "distill";
/** Label colour; keep it distinct from sibling packages. */
const NOTICE_COLOR: NoticeColor = "muted";
/** This package's notice source. */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };

notifyWithSource({ ctx, source: NOTICE_SOURCE, level: "warning", message: i18n.t("failed") });
```

This renders as `[distill] message`: the tag carries the package colour, the message stays untouched, and `level` still decides Pi's yellow `Warning:` / red `Error:` prefix. Colours are only added in tui mode; rpc/print/json get plain text so no ANSI leaks into other frontends. Use `formatNotice({ source, message, mode, theme })` when you only need the rendered string.

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
