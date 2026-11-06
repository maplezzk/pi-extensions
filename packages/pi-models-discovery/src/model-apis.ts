import type { Api } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Exact model IDs mapped to Pi API identifiers, including extension-defined APIs. */
export type ModelApis = Record<string, string>;

export function isModelApis(value: unknown): value is ModelApis {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		&& Object.entries(value).every(([id, api]) => id.trim().length > 0
			&& typeof api === "string" && api.trim().length > 0 && api === api.trim());
}

/** Empty panel input clears the mapping; malformed input leaves configuration unchanged. */
export function parseModelApis(value: string): ModelApis | undefined {
	try {
		const parsed: unknown = value.trim() ? JSON.parse(value) : {};
		return isModelApis(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Apply current policy to fresh copies, without putting provider-specific APIs in catalog caches. */
export function applyModelApis(models: ProviderModelConfig[], api: string, overrides: ModelApis = {}): ProviderModelConfig[] {
	return models.map((model) => ({
		...model,
		api: (Object.hasOwn(overrides, model.id) ? overrides[model.id] : api) as Api,
	}));
}
