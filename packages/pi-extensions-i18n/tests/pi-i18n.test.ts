import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
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

const registeredCommands: any[] = [];
piI18n({
  registerCommand(name: string, options: unknown) {
    registeredCommands.push({ name, options });
  },
} as any);
const registeredCommand = registeredCommands.find((command) => command.name === "config:language");
assert.ok(registeredCommand);
assert.ok(registeredCommands.find((command) => command.name === "pi-language"));
// 无参数执行命令时打开 SettingsList 面板，不再走 ctx.ui.select。
initTheme();
/** 用键盘驱动语言面板：下移一次到「English (en-US)」再回车选定。 */
const selectEnglishViaPanel = (component: { handleInput(data: string): void }): void => {
  component.handleInput("\u001b[B");
  component.handleInput("\r");
};
registeredCommand.options.handler("", {
  hasUI: true,
  ui: {
    custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => { handleInput(data: string): void }) => {
      // 面板只用到 theme.fg / theme.bold 包一层文字，返回原文即可。
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      selectEnglishViaPanel(factory({ requestRender: () => undefined }, theme, {}, () => undefined));
    },
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
