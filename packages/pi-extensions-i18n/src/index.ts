import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const SUPPORTED_LOCALES = ["zh-CN", "en-US"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export type LocalePreference = Locale | "auto";

export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = "zh-CN";
export const LOCALE_ENV = "PI_EXTENSIONS_LOCALE";
export const LOCALE_CONFIG_FILE = "config.json";
export const LOCALE_CONFIG_DIR = "extensions/pi-extensions-i18n";

export interface LocaleConfig {
  locale: LocalePreference;
}

export type MessageCatalog = Record<string, Record<Locale, string>>;
export type MessageKey<Catalog extends MessageCatalog> = keyof Catalog & string;
export type MessageParams = Record<string, string | number>;

interface Translator<Catalog extends MessageCatalog> {
  locale(): Locale;
  t(key: MessageKey<Catalog>, params?: MessageParams): string;
}

let runtimePreference: LocalePreference | undefined;

function normalizeLocale(value: unknown): LocalePreference | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized === "zh" || normalized === "zh-cn") return "zh-CN";
  if (normalized === "en" || normalized === "en-us") return "en-US";
  return undefined;
}

export function parseLocalePreference(value: string): LocalePreference | undefined {
  return normalizeLocale(value);
}

function resolveAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  if (configured === "~") return homedir();
  return configured.startsWith("~/")
    ? join(homedir(), configured.slice(2))
    : configured;
}

export function getLocaleConfigPath(agentDir = resolveAgentDir()): string {
  return join(agentDir, LOCALE_CONFIG_DIR, LOCALE_CONFIG_FILE);
}

function readPersistedPreference(agentDir: string): LocalePreference | undefined {
  const configPath = getLocaleConfigPath(agentDir);
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const value = normalizeLocale(
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).locale
        : undefined,
    );
    if (value) return value;
    console.warn(
      `[pi-extensions-i18n] Invalid locale in ${configPath}; using ${DEFAULT_LOCALE_PREFERENCE}.`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[pi-extensions-i18n] Failed to read ${configPath}; using ${DEFAULT_LOCALE_PREFERENCE}: ${String(error)}`,
      );
    }
  }
  return undefined;
}

export function getLocalePreference(): LocalePreference {
  const envValue = process.env[LOCALE_ENV];
  if (envValue !== undefined) {
    const parsed = normalizeLocale(envValue);
    if (parsed) return parsed;
    console.warn(
      `[pi-extensions-i18n] Invalid ${LOCALE_ENV}=${JSON.stringify(envValue)}; using ${DEFAULT_LOCALE_PREFERENCE}.`,
    );
    return DEFAULT_LOCALE_PREFERENCE;
  }

  if (runtimePreference) return runtimePreference;
  runtimePreference =
    readPersistedPreference(resolveAgentDir()) ?? DEFAULT_LOCALE_PREFERENCE;
  return runtimePreference;
}

function detectSystemLocale(): Locale {
  const systemLocale = process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "";
  return systemLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getLocale(): Locale {
  const preference = getLocalePreference();
  return preference === "auto" ? detectSystemLocale() : preference;
}

export function resetLocaleState(): void {
  runtimePreference = undefined;
}

export function saveLocalePreference(
  preference: LocalePreference,
  agentDir = resolveAgentDir(),
): string {
  const normalized = normalizeLocale(preference);
  if (!normalized) {
    throw new Error(`Unsupported locale preference: ${String(preference)}`);
  }

  const configPath = getLocaleConfigPath(agentDir);
  mkdirSync(dirname(configPath), { recursive: true });
  const config: LocaleConfig = { locale: normalized };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  runtimePreference = normalized;
  return configPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadCatalog(catalogFile: URL | string): MessageCatalog {
  const filePath = catalogFile instanceof URL ? fileURLToPath(catalogFile) : catalogFile;
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  if (!isRecord(parsed)) {
    throw new Error(`Invalid i18n catalog: expected an object in ${filePath}`);
  }

  const catalog: MessageCatalog = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (!isRecord(entry) || typeof entry["zh-CN"] !== "string" || typeof entry["en-US"] !== "string") {
      throw new Error(`Invalid i18n catalog entry ${key} in ${filePath}`);
    }
    catalog[key] = {
      "zh-CN": entry["zh-CN"],
      "en-US": entry["en-US"],
    };
  }
  return catalog;
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (placeholder, name) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`Missing interpolation value for ${placeholder}`);
    }
    return String(value);
  });
}

export function createTranslator<Catalog extends MessageCatalog>(
  catalog: Catalog,
): Translator<Catalog> {
  return {
    locale: getLocale,
    t(key, params) {
      const entry = catalog[key];
      if (!entry) {
        throw new Error(`Unknown i18n message key: ${String(key)}`);
      }
      const message = entry[getLocale()];
      if (message === undefined) {
        throw new Error(`Missing ${getLocale()} translation for message key: ${String(key)}`);
      }
      return interpolate(message, params);
    },
  };
}

const commandMessages = loadCatalog(
  new URL("../locales/command.json", import.meta.url),
);

function registerLocaleCommand(pi: ExtensionAPI): void {
  const i18n = createTranslator(commandMessages);
  pi.registerCommand("pi-language", {
    description: i18n.t("description"),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(i18n.t("noUi"), "warning");
        return;
      }

      const requested = args.trim();
      const directPreference = requested ? parseLocalePreference(requested) : undefined;
      if (requested && !directPreference) {
        ctx.ui.notify(i18n.t("invalid", { value: requested }), "error");
        return;
      }

      let preference = directPreference;
      if (!preference) {
        const options = [
          i18n.t("zh"),
          i18n.t("en"),
          i18n.t("auto"),
        ];
        const current = getLocalePreference();
        const currentOption = current === "zh-CN"
          ? options[0]
          : current === "en-US"
            ? options[1]
            : options[2];
        const selected = await ctx.ui.select(
          `${i18n.t("title")} [${currentOption}]`,
          options,
        );
        if (selected === undefined) return;
        preference = selected === options[0]
          ? "zh-CN"
          : selected === options[1]
            ? "en-US"
            : "auto";
      }

      try {
        const configPath = saveLocalePreference(preference);
        const envOverride = process.env[LOCALE_ENV];
        const overrideNotice = envOverride
          ? `\n${i18n.t("envOverride", { env: LOCALE_ENV })}`
          : "";
        ctx.ui.notify(
          `${i18n.t("saved", { locale: preference })}${overrideNotice}\n${configPath}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(i18n.t("failed", { error: String(error) }), "error");
      }
    },
  });
}

export default function piI18n(pi: ExtensionAPI): void {
  registerLocaleCommand(pi);
}
