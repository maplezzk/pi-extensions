import { createTranslator, loadCatalog } from "pi-extensions-i18n";

/** 清爽模式的文案翻译器；catalog 位于包内 locales/index.json。 */
export const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));
