/**
 * 通用模型发现插件
 *
 * 读取 models.json 中带 "discoverModels": true 的 provider，请求
 * GET {baseUrl}/models 自动发现模型并注册，无需手写 models 数组。
 *
 * 配置方式（二选一）：
 * 1. pi 终端内执行 /config:model-discovery，交互式添加/删除/重新发现 provider（推荐）；
 * 2. 直接编辑 ~/.pi/agent/models.json：
 * {
 *   "providers": {
 *     "llm-proxy": {
 *       "name": "LLM Proxy",
 *       "baseUrl": "http://127.0.0.1:9000/pi/v1",
 *       "apiKey": "sk-1234",
 *       "api": "openai-completions",
 *       "discoverModels": true
 *     }
 *   }
 * }
 *
 * 行为约定：
 * - 首次发现成功后，模型列表持久化到 ~/.pi/agent/extensions/pi-models-discovery/cache.json；
 *   之后每次启动直接读缓存注册，不请求网络。配置指纹
 *   （baseUrl+api+apiKey+headers+compat）变化时缓存自动失效，重新走网络发现。
 * - /config:model-discovery-refresh 强制重新拉取所有发现 provider 并更新缓存；
 *   /model 打开时触发的在线 refreshModels 同样走网络并同步更新缓存。
 * - baseUrl / api 由扩展显式转发（pi 的 extension 组合层要求），
 *   apiKey / name / headers / compat 不写回注册配置，由 pi 的 models.json 层回落生效。
 * - provider 级 compat 会被合并进每个发现的模型（pi 的 models.json provider 级 compat
 *   不作用于 extension 注册的模型，故在此转发）。
 * - 同一 baseUrl+apiKey+headers 的多个 provider 共享一次 /models 请求。
 * - 发现失败：该 provider 保留 models.json 手写 models（如有，作为离线回退），
 *   并通过 notify 显式警告，不静默降级；单个 provider 失败不影响其他 provider 注册。
 * - 注册 refreshModels：打开 /model 触发在线刷新时重新发现；
 *   离线初始化（allowNetwork=false）返回上次成功列表（含缓存），尚无成功记录时抛错，
 *   以免空列表清掉 models.json 手写 models。
 * - 发现模型默认声明 thinkingLevelMap { xhigh: "xhigh", max: "max" }，让 xhigh/max 出现在
 *   /thinking；标准档位缺省沿用 pi 的 provider 默认映射。这是对所有发现模型一刀切的默认值，
 *   上游不认这些值时用 models.json 的 provider.modelOverrides 按 model.id 覆盖。
 * - 发现请求的 apiKey 解析仅支持字面量与 $ENV_VAR/${ENV_VAR} 插值；
 *   "!command" 形式的 apiKey 跳过发现（显式警告），pi 发起聊天请求时仍由 pi 自身解析。
 * - /config:model-discovery 命令对 models.json 的修改立即生效（registerProvider 运行时可直接调用）；
 *   直接手编 models.json 后需 /reload 扩展生效。
 * - 本插件不使用 console.*：所有用户可见消息走 ctx.ui.notify；
 *   加载期（无 ctx）产生的消息收集到 pendingNotices，session_start 时统一 flush。
 */

import type { Api } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NOTICE_TAG_COLOR, createTranslator, installNoticeRenderer, loadCatalog, notifyWithSource, type NoticeColor, type NoticeSource } from "pi-extensions-i18n";
import { openDiscoveryPanel, type PanelProvider } from "./config-panel.ts";

const i18n = createTranslator(loadCatalog(new URL("../locales/index.json", import.meta.url)));

const FETCH_TIMEOUT_MS = 5000;
const DISCOVERY_MARKER = "discoverModels";
const LOG_PREFIX = "[model-discovery]";
/** 本扩展的提示标签；短且唯一，便于在会话里定位来源。 */
const NOTICE_TAG = "models";
/** 提示标签颜色：所有扩展统一用弱化色，来源靠 tag 文本区分，不靠颜色。 */
const NOTICE_COLOR: NoticeColor = NOTICE_TAG_COLOR;
/** 本扩展的提示来源。 */
const NOTICE_SOURCE: NoticeSource = { tag: NOTICE_TAG, color: NOTICE_COLOR };


/** 用户可见消息（级别与 ctx.ui.notify 的 type 对齐）；供通知中继与无 ctx 的收集队列共用 */
interface Notice {
	level: "info" | "warning" | "error";
	message: string;
}

/** 用户可见消息的统一出口：带来源标签与颜色（有 UI 传入 ctx 时），否则交给外部回调转发 */
type NoticeSink = (notice: Notice, ctx?: CommandCtx) => void;

/** models.json 中 provider 条目的读取形态（含发现标记） */
interface DiscoveryProviderEntry {
	id: string;
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	/** 发现标记；面板关闭发现时写 false（实际会删掉这个键）。 */
	discoverModels?: boolean;
}

interface ModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
		context_window?: number;
		contextWindow?: number;
		max_tokens?: number;
		maxTokens?: number;
	}>;
}

/** 持久化缓存中单个 provider 的条目 */
interface CachedProviderEntry {
	fingerprint: string;
	fetchedAt: string;
	models: ProviderModelConfig[];
}

interface CacheFile {
	version: 1;
	providers: Record<string, CachedProviderEntry>;
}

/** 与 pi dist/utils/json.js 的 stripJsonComments 一致：去 // 行注释与尾随逗号，保留字符串字面量 */
function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

function modelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

function cachePath(): string {
	return join(getAgentDir(), "extensions", "pi-models-discovery", "cache.json");
}

/** 缓存失效指纹：provider 配置中影响发现结果的字段 */
function providerFingerprint(entry: DiscoveryProviderEntry): string {
	return JSON.stringify([
		entry.baseUrl ?? "",
		entry.api ?? "",
		entry.apiKey ?? "",
		entry.headers ?? {},
		entry.compat ?? {},
	]);
}

/** 读取模型缓存；文件不存在视为空缓存，损坏则显式警告并视为空缓存（不静默降级） */
async function readCache(notices: Notice[]): Promise<CacheFile> {
	let raw: string;
	try {
		raw = await readFile(cachePath(), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			notices.push({
				level: "warning",
				message: `${LOG_PREFIX} ${i18n.t("cacheReadFailed", { reason: err instanceof Error ? err.message : String(err) })}`,
			});
		}
		return { version: 1, providers: {} };
	}
	try {
		const parsed = JSON.parse(raw) as CacheFile;
		if (parsed && typeof parsed === "object" && parsed.providers && typeof parsed.providers === "object") {
			return { version: 1, providers: parsed.providers };
		}
		throw new Error("unexpected cache shape");
	} catch (err) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${i18n.t("cacheReadFailed", { reason: err instanceof Error ? err.message : String(err) })}`,
		});
		return { version: 1, providers: {} };
	}
}

/** 发现成功后持久化模型列表；写失败仅警告（不影响本次注册） */
async function persistCachedModels(
	entry: DiscoveryProviderEntry,
	models: ProviderModelConfig[],
	notices: Notice[],
): Promise<void> {
	try {
		const cache = await readCache([]);
		cache.providers[entry.id] = {
			fingerprint: providerFingerprint(entry),
			fetchedAt: new Date().toISOString(),
			models,
		};
		await mkdir(dirname(cachePath()), { recursive: true });
		await writeFile(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
	} catch (err) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${entry.id}: ${i18n.t("cacheWriteFailed", { reason: err instanceof Error ? err.message : String(err) })}`,
		});
	}
}

/** 删除 provider 时同步移除其缓存条目 */
async function removeCachedModels(id: string, notices: Notice[]): Promise<void> {
	try {
		const cache = await readCache([]);
		if (!(id in cache.providers)) return;
		delete cache.providers[id];
		await mkdir(dirname(cachePath()), { recursive: true });
		await writeFile(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, "utf-8");
	} catch (err) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${id}: ${i18n.t("cacheWriteFailed", { reason: err instanceof Error ? err.message : String(err) })}`,
		});
	}
}

/** 读取 models.json 完整内容（保留所有顶层字段与其他 provider 原样） */
async function readModelsFile(): Promise<{ data: Record<string, unknown>; error: string | null }> {
	let raw: string;
	try {
		raw = await readFile(modelsJsonPath(), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { data: {}, error: null };
		}
		return { data: {}, error: i18n.t("readFailed", { reason: err instanceof Error ? err.message : String(err) }) };
	}
	try {
		const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
		return { data: parsed, error: null };
	} catch (err) {
		return { data: {}, error: i18n.t("parseFailed", { reason: err instanceof Error ? err.message : String(err) }) };
	}
}

/** 写回 models.json；写前备份到 models.json.discovery-bak。注意：注释与键序格式不被保留 */
async function writeModelsFile(data: Record<string, unknown>): Promise<{ backup: string }> {
	const path = modelsJsonPath();
	const backup = `${path}.discovery-bak`;
	try {
		await writeFile(backup, await readFile(path, "utf-8"), "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(i18n.t("backupFailed", { reason: err instanceof Error ? err.message : String(err) }));
		}
	}
	await writeFile(path, `${JSON.stringify(data, null, 4)}\n`, "utf-8");
	return { backup };
}

/** 从完整 models.json 数据中筛出带发现标记的 provider */
function pickDiscoveryProviders(data: Record<string, unknown>): DiscoveryProviderEntry[] {
	const rawProviders = (data.providers ?? {}) as Record<string, Record<string, unknown>>;
	const providers: DiscoveryProviderEntry[] = [];
	for (const [id, value] of Object.entries(rawProviders)) {
		if (value?.[DISCOVERY_MARKER] !== true) continue;
		providers.push({
			id,
			name: typeof value.name === "string" ? value.name : undefined,
			baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : undefined,
			apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
			api: typeof value.api === "string" ? value.api : undefined,
			headers:
				value.headers && typeof value.headers === "object"
					? (value.headers as Record<string, string>)
					: undefined,
			compat:
				value.compat && typeof value.compat === "object"
					? (value.compat as Record<string, unknown>)
					: undefined,
		});
	}
	return providers;
}

/**
 * 解析发现请求用的配置值：字面量、$ENV_VAR / ${ENV_VAR} 插值、$$ 与 $! 转义。
 * 不执行 "!command"（由 pi 请求时自行处理），遇到时返回 error。
 */
function resolveEnvValue(raw: string): { value: string | null; error: string | null } {
	if (raw.startsWith("!")) {
		return { value: null, error: i18n.t("commandValueUnsupported") };
	}
	const missing: string[] = [];
	const value = raw
		.replace(/\$\$|\$!|\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braceName, plainName) => {
			if (match === "$$") return "\0DOLLAR\0";
			if (match === "$!") return "\0BANG\0";
			const name = (braceName ?? plainName) as string;
			const envValue = process.env[name];
			if (envValue === undefined) {
				missing.push(name);
				return "";
			}
			return envValue;
		})
		.replaceAll("\0DOLLAR\0", "$")
		.replaceAll("\0BANG\0", "!");
	if (missing.length > 0) {
		return { value: null, error: i18n.t("envMissing", { names: missing.join(", ") }) };
	}
	return { value, error: null };
}

export function buildModel(
	id: string,
	name: string | undefined,
	contextWindow: number | undefined,
	maxTokens: number | undefined,
	providerCompat: Record<string, unknown> | undefined,
): ProviderModelConfig {
	return {
		id,
		name: name ?? id,
		reasoning: true,
		// xhigh/max 必须给非 null 值才会出现在 /thinking（缺省键等同不支持）；
		// 标准档位保持缺省，仍走 pi 的 provider 默认映射，语义不变。
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindow ?? 1_000_000,
		maxTokens: maxTokens ?? 65_536,
		compat: {
			supportsDeveloperRole: false,
			...providerCompat,
		},
	};
}

/** 请求 {baseUrl}/models 并解析为模型配置；失败抛错（错误信息带原因） */
async function fetchModels(
	entry: DiscoveryProviderEntry,
	notices: Notice[],
): Promise<ProviderModelConfig[]> {
	if (!entry.baseUrl) {
		throw new Error(i18n.t("missingBaseUrl"));
	}
	const headers: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(entry.headers ?? {})) {
		const resolved = resolveEnvValue(rawValue);
		if (resolved.error) {
			notices.push({
				level: "warning",
				message: `${LOG_PREFIX} ${i18n.t("headerSkipped", { id: entry.id, key, reason: resolved.error })}`,
			});
			continue;
		}
		if (resolved.value !== null) headers[key] = resolved.value;
	}
	if (entry.apiKey !== undefined) {
		const resolved = resolveEnvValue(entry.apiKey);
		if (resolved.error) {
			throw new Error(`apiKey ${resolved.error}`);
		}
		if (resolved.value) {
			headers.Authorization = `Bearer ${resolved.value}`;
		}
	}
	const url = `${entry.baseUrl.replace(/\/+$/, "")}/models`;
	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (err) {
		throw new Error(i18n.t("fetchFailed", { url, reason: err instanceof Error ? err.message : String(err) }));
	}
	if (!response.ok) {
		throw new Error(i18n.t("fetchHttpError", { url, status: response.status }));
	}
	const payload = (await response.json()) as ModelsResponse | Array<ModelsResponse["data"] extends (infer T)[] ? T : never>;
	const entries = Array.isArray(payload) ? payload : (payload.data ?? []);
	const models = entries
		.filter((m): m is typeof m & { id: string } => typeof m?.id === "string" && m.id.length > 0)
		.map((m) =>
			buildModel(
				m.id,
				m.name,
				m.context_window ?? m.contextWindow,
				m.max_tokens ?? m.maxTokens,
				entry.compat,
			),
		);
	if (models.length === 0) {
		throw new Error(i18n.t("emptyModelList", { url }));
	}
	return models;
}

/** 共享 /models 请求的缓存：同一 baseUrl+apiKey+headers 只拉一次 */
type FetchCache = Map<string, Promise<ProviderModelConfig[]>>;

function fetchWithCache(cache: FetchCache, entry: DiscoveryProviderEntry, notices: Notice[]): Promise<ProviderModelConfig[]> {
	const cacheKey = `${entry.baseUrl}\n${entry.apiKey ?? ""}\n${JSON.stringify(entry.headers ?? {})}`;
	let pending = cache.get(cacheKey);
	if (!pending) {
		pending = fetchModels(entry, notices);
		cache.set(cacheKey, pending);
	}
	return pending;
}

/** refreshModels 闭包共享的最近成功列表（缓存命中时即为缓存内容） */
interface LastModelsState {
	lastModels: ProviderModelConfig[];
}

/**
 * 构造 refreshModels：离线初始化返回最近成功列表（无记录则抛错，避免清空手写 models）；
 * 在线刷新强制重拉、更新最近列表并持久化缓存。
 */
function createRefreshModels(entry: DiscoveryProviderEntry, notices: Notice[], state: LastModelsState) {
	return async (context: { allowNetwork: boolean }) => {
		if (!context.allowNetwork) {
			if (state.lastModels.length === 0) {
				throw new Error(i18n.t("offlineNoCache"));
			}
			return state.lastModels;
		}
		const refreshed = await fetchModels(entry, notices);
		state.lastModels = refreshed;
		await persistCachedModels(entry, refreshed, notices);
		return refreshed;
	};
}

/** 校验 baseUrl/api 齐备；缺失时推入警告并返回 false */
function validateEntry(entry: DiscoveryProviderEntry, notices: Notice[]): entry is DiscoveryProviderEntry & { baseUrl: string; api: string } {
	if (!entry.baseUrl || !entry.api) {
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${entry.id}: ${i18n.t("missingConfig", { field: !entry.baseUrl ? "baseUrl" : "api" })}`,
		});
		return false;
	}
	return true;
}

/**
 * 对单个 provider 执行模型发现并注册（成功带 models，失败保留手写回退）。
 * 启动期缓存未命中时与 /config:model-discovery、/config:model-discovery-refresh 命令共用；
 * 运行期调用立即生效，无需 /reload。
 * 成功时持久化模型缓存；返回发现的模型列表（失败为 null），消息写入 notices。
 * 注意：本函数不再主动输出“发现成功”信息；调用方按需自行 notify，
 * 避免启动期自动打印模型列表占用会话空间。
 */
async function discoverAndRegister(
	pi: ExtensionAPI,
	entry: DiscoveryProviderEntry,
	fetchCache: FetchCache,
	notices: Notice[],
): Promise<{ count: number; models: ProviderModelConfig[] } | null> {
	if (!validateEntry(entry, notices)) return null;
	const state: LastModelsState = { lastModels: [] };
	const refreshModels = createRefreshModels(entry, notices, state);
	try {
		const models = await fetchWithCache(fetchCache, entry, notices);
		state.lastModels = models;
		pi.registerProvider(entry.id, {
			baseUrl: entry.baseUrl,
			api: entry.api as Api,
			models,
			refreshModels,
		});
		await persistCachedModels(entry, models, notices);
		return { count: models.length, models };
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		notices.push({
			level: "warning",
			message: `${LOG_PREFIX} ${i18n.t("discoveryFailed", { id: entry.id, reason })}`,
		});
		pi.registerProvider(entry.id, {
			baseUrl: entry.baseUrl,
			api: entry.api as Api,
			refreshModels,
		});
		return null;
	}
}

/** 缓存命中路径：直接用持久化的模型列表注册，不请求网络 */
function registerFromCache(
	pi: ExtensionAPI,
	entry: DiscoveryProviderEntry,
	models: ProviderModelConfig[],
	notices: Notice[],
): void {
	if (!validateEntry(entry, notices)) return;
	const state: LastModelsState = { lastModels: models };
	const refreshModels = createRefreshModels(entry, notices, state);
	pi.registerProvider(entry.id, {
		baseUrl: entry.baseUrl,
		api: entry.api as Api,
		models,
		refreshModels,
	});
}

/**
 * 把带 discoverModels 标记的 provider 转成面板读的形态。
 * 面板不直接碰磁盘，改完由 persistProvider 写回 models.json。
 */
function toPanelProvider(entry: DiscoveryProviderEntry): PanelProvider {
	return {
		id: entry.id,
		baseUrl: entry.baseUrl ?? "",
		api: entry.api ?? "",
		apiKey: entry.apiKey ?? "",
		name: entry.name ?? "",
		enabled: true,
	};
}

/** 读取当前 models.json 里所有带发现标记的 provider，供面板渲染。 */
async function readPanelProviders(): Promise<{ providers: PanelProvider[]; error: string | null }> {
	const { data, error } = await readModelsFile();
	if (error) return { providers: [], error };
	return { providers: pickDiscoveryProviders(data).map(toPanelProvider), error: null };
}

/**
 * 面板改一个 provider 的字段后写回 models.json。
 * 沿用原条目的其余字段（headers/compat 等面板不管的键），只覆盖面板能改的四项。
 */
async function persistProvider(provider: PanelProvider): Promise<{ backup: string }> {
	const { data, error } = await readModelsFile();
	if (error) throw new Error(error);
	const providers = (data.providers ?? {}) as Record<string, Record<string, unknown>>;
	const existing = providers[provider.id];
	if (!existing) throw new Error(i18n.t("panelProviderMissing", { id: provider.id }));
	const entry: Record<string, unknown> = { ...existing, baseUrl: provider.baseUrl, api: provider.api };
	if (provider.enabled) entry[DISCOVERY_MARKER] = true;
	else delete entry[DISCOVERY_MARKER];
	if (provider.apiKey) entry.apiKey = provider.apiKey;
	else delete entry.apiKey;
	if (provider.name) entry.name = provider.name;
	else delete entry.name;
	providers[provider.id] = entry;
	data.providers = providers;
	return writeModelsFile(data);
}

/** 新增 provider 时写入 models.json 的条目。 */
async function persistNewProvider(provider: PanelProvider): Promise<{ backup: string }> {
	const { data, error } = await readModelsFile();
	if (error) throw new Error(error);
	const providers = (data.providers ?? {}) as Record<string, Record<string, unknown>>;
	const entry: Record<string, unknown> = {
		baseUrl: provider.baseUrl,
		api: provider.api,
		[DISCOVERY_MARKER]: true,
	};
	if (provider.apiKey) entry.apiKey = provider.apiKey;
	if (provider.name) entry.name = provider.name;
	providers[provider.id] = entry;
	data.providers = providers;
	return writeModelsFile(data);
}

/** 从 models.json 删掉一个 provider 条目。 */
async function deleteProvider(id: string): Promise<{ backup: string }> {
	const { data, error } = await readModelsFile();
	if (error) throw new Error(error);
	const providers = (data.providers ?? {}) as Record<string, Record<string, unknown>>;
	delete providers[id];
	data.providers = providers;
	return writeModelsFile(data);
}

/**
 * 用 models.json 当前内容重新注册一个 provider，行为与启动期一致：
 * 指纹命中缓存就直接注册缓存里的模型，不请求网络；否则走在线发现。
 */
async function reloadProvider(options: {
	/** 扩展 API，用来注册或注销 provider。 */
	pi: ExtensionAPI;
	/** models.json 中读到的 provider 条目。 */
	entry: DiscoveryProviderEntry;
	/** 本次会话共享的 /models 请求缓存。 */
	fetchCache: FetchCache;
	/** 收集过程中产生的提示，由调用方决定发给谁。 */
	notices: Notice[];
}): Promise<void> {
	const { pi, entry, fetchCache, notices } = options;
	if (entry.discoverModels === false) {
		pi.unregisterProvider(entry.id);
		return;
	}
	const cache = await readCache(notices);
	const cached = cache.providers[entry.id];
	if (
		cached &&
		cached.fingerprint === providerFingerprint(entry) &&
		Array.isArray(cached.models) &&
		cached.models.length > 0
	) {
		registerFromCache(pi, entry, cached.models, notices);
		return;
	}
	await discoverAndRegister(pi, entry, fetchCache, notices);
}

/** 按 id 从 models.json 现读一个 provider 条目；没有发现标记时返回 undefined。 */
async function readProviderEntry(id: string): Promise<DiscoveryProviderEntry | undefined> {
	const { data } = await readModelsFile();
	return pickDiscoveryProviders(data).find((entry) => entry.id === id);
}

/** /config:model-discovery 交互式配置命令；旧名称保留为兼容别名。 */
function registerDiscoveryCommand(pi: ExtensionAPI, fetchCache: FetchCache, sink: NoticeSink) {
	/** 面板读 provider 列表、写回 models.json，并把改动即时注册到运行期。 */
	const openPanel = async (ctx: CommandCtx): Promise<void> => {
		const first = await readPanelProviders();
		if (first.error) {
			sink({ level: "error", message: `${LOG_PREFIX} ${first.error}` }, ctx);
			return;
		}
		let providers = first.providers;
		/**
		 * 变更队列。
		 *
		 * SettingsList 的 onChange 是同步回调，无法 await，所以写盘+重新注册按顺序排成一条链；
		 * 面板关闭后等这条链清空，保证最后一次改动已落盘并已注册（不静默丢改动）。
		 */
		let pendingChange: Promise<void> = Promise.resolve();
		/** 把一个变更追加到队尾，保证先后顺序与面板操作一致。 */
		const enqueue = (change: () => Promise<void>): void => {
			pendingChange = pendingChange.then(change);
		};
		await openDiscoveryPanel(ctx, {
			getProviders: () => providers,
			onProviderChange: (provider) => {
				// 面板下一次读到的必须是刚改过的值，所以内存副本同步更新，落盘排队跟上。
				providers = providers.map((current) => (current.id === provider.id ? provider : current));
				enqueue(async () => {
					const notices: Notice[] = [];
					try {
						await persistProvider(provider);
					} catch (err) {
						flushNotices(ctx, [{
							level: "error",
							message: `${LOG_PREFIX} ${err instanceof Error ? err.message : String(err)}`,
						}]);
						return;
					}
					const entry = await readProviderEntry(provider.id);
					if (!entry) {
						pi.unregisterProvider(provider.id);
					} else {
						await reloadProvider({ pi, entry, fetchCache, notices });
					}
					// 面板行上的当前值来自本地副本，网络提示照常发出来，不静默降级。
					flushNotices(ctx, notices);
				});
			},
			onProviderRemoved: (id) => {
				providers = providers.filter((provider) => provider.id !== id);
			},
			onProviderAdd: (provider) => {
				providers = [...providers, provider];
				enqueue(() => addProviderFromPanel({ pi, ctx, provider, fetchCache, sink }));
			},
			actions: {
				rediscover: (provider) => {
					// 也走同一条队列：保证“改字段”与“立即重新发现”不会交叠写盘。
					enqueue(async () => {
						const entry = await readProviderEntry(provider.id) ?? {
							id: provider.id,
							baseUrl: provider.baseUrl,
							api: provider.api,
							apiKey: provider.apiKey || undefined,
							name: provider.name || undefined,
						};
						const notices: Notice[] = [];
						const result = await discoverAndRegister(pi, entry, fetchCache, notices);
						flushNotices(ctx, notices);
						if (result) {
							sink({ level: "info", message: i18n.t("rediscovered", { id: provider.id, count: result.count }) }, ctx);
						}
					});
					return pendingChange;
				},
				remove: async (provider) => {
					/** 删除结果；由队列里的那段代码写入。 */
					let removed = false;
					enqueue(async () => {
						try {
							const { backup } = await deleteProvider(provider.id);
							pi.unregisterProvider(provider.id);
							const notices: Notice[] = [];
							await removeCachedModels(provider.id, notices);
							flushNotices(ctx, notices);
							sink({ level: "info", message: i18n.t("removed", { id: provider.id, backup }) }, ctx);
							removed = true;
						} catch (err) {
							sink({ level: "error", message: `${LOG_PREFIX} ${err instanceof Error ? err.message : String(err)}` }, ctx);
						}
					});
					await pendingChange;
					return removed;
				},
			},
		});
		// 面板已关，但队列里可能还有写盘与重新注册；等它们完成再返回。
		await pendingChange;
	};

	const command = {
		description: i18n.t("commandDescription"),
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			await openPanel(ctx);
		},
	};
	for (const name of ["config:model-discovery", "model-discovery", "pi-model-discovery"] as const) {
		pi.registerCommand(name, command);
	}
}

/** /config:model-discovery-refresh 强制刷新命令；旧名称保留为兼容别名。 */
function registerRefreshCommand(pi: ExtensionAPI, sink: NoticeSink) {
	const command = {
		description: i18n.t("refreshDescription"),
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const { data, error } = await readModelsFile();
			if (error) {
				sink({ level: "error", message: `${LOG_PREFIX} ${error}` }, ctx);
				return;
			}
			const providers = pickDiscoveryProviders(data);
			if (providers.length === 0) {
				sink({ level: "info", message: i18n.t("refreshEmpty") }, ctx);
				return;
			}
			// 每次刷新用新的请求级缓存：同 baseUrl 的 provider 仍共享一次请求，但不复用启动期结果
			const fetchCache: FetchCache = new Map();
			let ok = 0;
			for (const entry of providers) {
				const notices: Notice[] = [];
				const result = await discoverAndRegister(pi, entry, fetchCache, notices);
				for (const notice of notices) sink(notice, ctx);
				if (result) {
					sink(
						{
							level: "info",
							message: `${LOG_PREFIX} ${i18n.t("discoveredInfo", { id: entry.id, count: result.count, models: result.models.map((m) => m.id).join(", ") })}`,
						},
						ctx,
					);
					ok++;
				}
			}
			sink(
				{
					level: ok === providers.length ? "info" : "warning",
					message: i18n.t("refreshDone", { ok, total: providers.length }),
				},
				ctx,
			);
		},
	};
	for (const name of ["config:model-discovery-refresh", "model-discovery-refresh", "pi-model-discovery-refresh"] as const) {
		pi.registerCommand(name, command);
	}
}

type CommandCtx = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

/** 将收集到的 Notice 逐条经来源包装后 flush 到 UI */
function flushNotices(ctx: CommandCtx, notices: Notice[]): void {
	for (const notice of notices) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: notice.level, message: notice.message });
}

/** /config:model-discovery 新增 provider：写回 models.json 后立刻做首次发现。 */
async function addProviderFromPanel(options: {
	/** 扩展 API。 */
	pi: ExtensionAPI;
	/** 命令上下文，用来发提示。 */
	ctx: CommandCtx;
	/** 面板里填好的新 provider。 */
	provider: PanelProvider;
	/** 本次会话共享的 /models 请求缓存。 */
	fetchCache: FetchCache;
	/** 提示出口。 */
	sink: NoticeSink;
}): Promise<void> {
	const { pi, ctx, provider, fetchCache, sink } = options;
	try {
		const { backup } = await persistNewProvider(provider);
		sink({ level: "info", message: i18n.t("written", { backup }) }, ctx);
	} catch (err) {
		sink({ level: "error", message: `${LOG_PREFIX} ${err instanceof Error ? err.message : err}` }, ctx);
		return;
	}
	const notices: Notice[] = [];
	const result = await discoverAndRegister(
		pi,
		{
			id: provider.id,
			name: provider.name || undefined,
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey || undefined,
			api: provider.api,
		},
		fetchCache,
		notices,
	);
	flushNotices(ctx, notices);
	if (result) {
		sink({ level: "info", message: i18n.t("discovered", { id: provider.id, count: result.count }) }, ctx);
	} else {
		sink({ level: "warning", message: i18n.t("firstFailed", { id: provider.id }) }, ctx);
	}
}

export default async function (pi: ExtensionAPI) {
	// 提示画成会话区里的带底色消息块；渲染器在本包这个模块实例里注册一次。
	installNoticeRenderer(pi);
	// 加载期没有 ctx，消息统一收集，session_start 时 flush（运行期后续追加的也会在下个 session 补发）
	const pendingNotices: Notice[] = [];
	// 有 UI 时走统一来源包装；无 UI 时退到日志前缀，不静默丢掉提示
	const sink: NoticeSink = (notice, ctx) => {
		if (ctx) notifyWithSource({ ctx, source: NOTICE_SOURCE, level: notice.level, message: notice.message });
		else pendingNotices.push(notice);
	};
	const { data, error } = await readModelsFile();
	if (error) {
		pendingNotices.push({ level: "warning", message: `${LOG_PREFIX} ${error}` });
	}
	const providers = pickDiscoveryProviders(data);
	const fetchCache: FetchCache = new Map();

	if (providers.length > 0) {
		const cache = await readCache(pendingNotices);
		for (const entry of providers) {
			const cached = cache.providers[entry.id];
			if (
				cached &&
				cached.fingerprint === providerFingerprint(entry) &&
				Array.isArray(cached.models) &&
				cached.models.length > 0
			) {
				registerFromCache(pi, entry, cached.models, pendingNotices);
			} else {
				await discoverAndRegister(pi, entry, fetchCache, pendingNotices);
				// 启动期缓存未命中时保持静默，不打印模型列表
			}
		}
	}

	registerDiscoveryCommand(pi, fetchCache, sink);
	registerRefreshCommand(pi, sink);

	pi.on("session_start", (_event, ctx) => {
		for (const notice of pendingNotices.splice(0)) {
			notifyWithSource({ ctx, source: NOTICE_SOURCE, level: notice.level, message: notice.message });
		}
	});
}
