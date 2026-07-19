import { createTranslator, loadCatalog } from "pi-extensions-i18n";

export const i18n = createTranslator(loadCatalog(new URL("../locales/mux.json", import.meta.url)));
