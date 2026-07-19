# pi-extensions-i18n

Shared localization runtime for Pi extensions. It provides a small, catalog-backed API for `zh-CN`, `en-US`, and automatic locale selection.

## Why a shared package

Independent Pi extensions still need the same operational pieces: a portable configuration path, locale precedence, fallback behavior, catalog validation, and parameter interpolation. Keeping those pieces here lets feature packages concentrate on their own behavior while keeping user-facing messages consistent.

## Features

- `zh-CN`, `en-US`, and `auto` locale preferences.
- Persistent setting at `~/.pi/agent/extensions/pi-extensions-i18n/config.json`.
- `PI_EXTENSIONS_LOCALE` environment-variable override.
- `/pi-language` interactive command, plus `/pi-language en-US` direct selection.
- Catalog loading and validation requiring both language entries for every message key.
- Translator interpolation for user-facing UI, command descriptions, and agent prompts.

## Install

```bash
pi install npm:pi-extensions-i18n
```

Feature packages such as `pi-distill` and `pi-tool-supervisor` use it as a shared dependency. Install it explicitly when you want the locale command by itself.

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
/pi-language en-US
```

## Extension author API

The package exports the locale and catalog primitives used by the feature packages:

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
- Pi's extension runtime when using the `/pi-language` command.

## License

[MIT](../../LICENSE)
