import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTranslator,
  getLocale,
  getLocaleConfigPath,
  parseLocalePreference,
  resetLocaleState,
  saveLocalePreference,
} from "../src/index.ts";
import piI18n from "../src/index.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-extensions-i18n-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_EXTENSIONS_LOCALE;
resetLocaleState();

assert.equal(parseLocalePreference("zh"), "zh-CN");
assert.equal(parseLocalePreference("en-US"), "en-US");
assert.equal(parseLocalePreference("auto"), "auto");
assert.equal(parseLocalePreference("fr"), undefined);
assert.equal(getLocale(), "zh-CN");

const translator = createTranslator({
  greeting: { "zh-CN": "你好，{name}", "en-US": "Hello, {name}" },
});
assert.equal(translator.t("greeting", { name: "Pi" }), "你好，Pi");

const configPath = saveLocalePreference("en-US");
assert.equal(configPath, getLocaleConfigPath(agentDir));
assert.equal(JSON.parse(readFileSync(configPath, "utf8")).locale, "en-US");
assert.equal(getLocale(), "en-US");
assert.equal(translator.t("greeting", { name: "Pi" }), "Hello, Pi");

process.env.PI_EXTENSIONS_LOCALE = "zh-CN";
resetLocaleState();
assert.equal(getLocale(), "zh-CN");
delete process.env.PI_EXTENSIONS_LOCALE;

writeFileSync(configPath, JSON.stringify({ locale: "zh-CN" }));
assert.equal(getLocale(), "zh-CN");
writeFileSync(configPath, JSON.stringify({ locale: "en-US" }));
assert.equal(getLocale(), "en-US");

let registeredCommand: any;
piI18n({
  registerCommand(name: string, options: unknown) {
    registeredCommand = { name, options };
  },
} as any);
assert.equal(registeredCommand.name, "pi-language");
registeredCommand.options.handler("", {
  hasUI: true,
  ui: {
    select: async () => "English (en-US)",
    notify: () => undefined,
  },
}).then(async () => {
  assert.equal(getLocale(), "en-US");
  const packageModule = await import("pi-extensions-i18n");
  assert.equal(typeof packageModule.createTranslator, "function");
  const catalogPath = join(agentDir, "test-catalog.json");
  writeFileSync(
    catalogPath,
    JSON.stringify({
      request: {
        "zh-CN": "用户的提炼请求：",
        "en-US": "User's distillation request:",
      },
    }),
  );
  const catalog = packageModule.loadCatalog(catalogPath);
  assert.equal(
    packageModule.createTranslator(catalog).t("request"),
    "User's distillation request:",
  );
  const invalidCatalogPath = join(agentDir, "invalid-catalog.json");
  writeFileSync(invalidCatalogPath, JSON.stringify({ incomplete: { "zh-CN": "only one locale" } }));
  assert.throws(
    () => packageModule.loadCatalog(invalidCatalogPath),
    /Invalid i18n catalog entry incomplete/,
  );
  console.log("pi-extensions-i18n tests passed");
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
