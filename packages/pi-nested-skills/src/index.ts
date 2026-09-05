import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { createTranslator, loadCatalog } from "pi-extensions-i18n";
import { loadConfig, type LoadedNestedSkillsConfig } from "./config.ts";
import { scanSkillRoots, type NestedSkill, type SkillScanResult } from "./skills.ts";

const messages = loadCatalog(new URL("../locales/index.json", import.meta.url));
const i18n = createTranslator(messages);

const COMMAND_NAME = "skills";
const COMMAND_ALIASES = [COMMAND_NAME] as const;
const SKILL_COMMAND_PREFIX = "skill:";
const INPUT_SOURCES = new Set(["interactive", "rpc"]);

type SkillCommandContext = ExtensionCommandContext;

interface SkillCandidate {
  alias: string;
  skill: NestedSkill;
}

interface SkillIndex {
  readonly skills: NestedSkill[];
  readonly skillPaths: string[];
  readonly warnings: SkillScanResult["warnings"];
  readonly aliases: Map<string, NestedSkill>;
  readonly names: Map<string, NestedSkill | null>;
}

/** 将扫描结果转换为稳定的别名索引，并标记 frontmatter name 冲突。 */
function buildSkillIndex(scan: SkillScanResult): SkillIndex {
  const aliases = new Map<string, NestedSkill>();
  const names = new Map<string, NestedSkill | null>();

  for (const skill of scan.skills) {
    const alias = skillAlias(skill);
    if (!aliases.has(alias)) aliases.set(alias, skill);

    const existing = names.get(skill.skillName);
    if (existing === undefined) names.set(skill.skillName, skill);
    else if (existing !== skill) names.set(skill.skillName, null);
  }

  return {
    skills: scan.skills,
    skillPaths: scan.skillPaths,
    warnings: scan.warnings,
    aliases,
    names,
  };
}

/** 返回用户输入和补全展示使用的别名，不改变 frontmatter 中的原生技能名称。 */
export function skillAlias(skill: Pick<NestedSkill, "packName" | "skillDir">): string {
  return skill.skillDir ? `${skill.packName}:${skill.skillDir}` : skill.packName;
}

/** 将 /skill:pack.path、/pack:path 等形式解析为一个已扫描技能。 */
export function resolveSkillAlias(raw: string, index: Pick<SkillIndex, "aliases" | "names">): NestedSkill | undefined {
  const candidates = new Set<string>();
  const addCandidate = (candidate: string): void => {
    const normalized = candidate.trim();
    if (normalized) candidates.add(normalized);
  };

  addCandidate(raw);
  if (raw.startsWith(SKILL_COMMAND_PREFIX)) {
    const body = raw.slice(SKILL_COMMAND_PREFIX.length);
    addCandidate(body);

    // /skill:pack.path.to.skill 使用第一个点分隔技能包和嵌套路径。
    const firstDot = body.indexOf(".");
    if (firstDot > 0) addCandidate(`${body.slice(0, firstDot)}:${body.slice(firstDot + 1)}`);
  } else {
    // 也接受不带 skill: 前缀的点号路径，方便旧别名和手工输入互通。
    const firstDot = raw.indexOf(".");
    if (firstDot > 0) addCandidate(`${raw.slice(0, firstDot)}:${raw.slice(firstDot + 1)}`);
  }

  for (const candidate of candidates) {
    const direct = index.aliases.get(candidate);
    if (direct) return direct;
  }

  // /skill:<frontmatter name> 交给索引映射；冲突名称不猜测，避免调用错误技能。
  if (!raw.startsWith(SKILL_COMMAND_PREFIX)) return undefined;
  const named = index.names.get(raw.slice(SKILL_COMMAND_PREFIX.length));
  return named ?? undefined;
}

/** 将原生 /skill:<name> 调用交给 Pi 自己展开，避免复制技能正文展开逻辑。 */
export function transformSkillInput(
  text: string,
  index: Pick<SkillIndex, "aliases" | "names">,
): string | undefined {
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;

  const skill = resolveSkillAlias(match[1], index);
  if (!skill || index.names.get(skill.skillName) !== skill) return undefined;

  const args = match[2]?.trim();
  return `/skill:${skill.skillName}${args ? ` ${args}` : ""}`;
}

function skillCandidates(index: SkillIndex): SkillCandidate[] {
  return [...index.aliases.entries()].map(([alias, skill]) => ({ alias, skill }));
}

function nativeSkillValue(alias: string): string {
  const separator = alias.indexOf(":");
  return separator === -1
    ? `${SKILL_COMMAND_PREFIX}${alias}`
    : `${SKILL_COMMAND_PREFIX}${alias.slice(0, separator)}.${alias.slice(separator + 1)}`;
}

function createAutocompleteProvider(
  current: AutocompleteProvider,
  index: SkillIndex,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      const match = beforeCursor.match(/^\/([^\s]*)$/);
      if (!match) return base;

      const query = match[1].startsWith(SKILL_COMMAND_PREFIX)
        ? match[1].slice(SKILL_COMMAND_PREFIX.length)
        : match[1];
      const items = fuzzyFilter(
        skillCandidates(index),
        query,
        ({ alias, skill }) => `${alias} ${skill.skillName} ${skill.description}`,
      ).map(({ alias, skill }): AutocompleteItem => ({
        value: nativeSkillValue(alias),
        label: alias,
        description: skill.description || skill.skillName,
      }));

      if (items.length === 0) return base;
      const existingValues = new Set((base?.items ?? []).map((item) => item.value));
      const merged = [
        ...(base?.items ?? []),
        ...items.filter((item) => !existingValues.has(item.value)),
      ];
      return { prefix: beforeCursor, items: merged };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function commandItems(index: SkillIndex): AutocompleteItem[] {
  return skillCandidates(index).map(({ alias, skill }) => ({
    value: alias,
    label: alias,
    description: skill.description || skill.skillName,
  }));
}

function formatSkillsMessage(index: SkillIndex): string {
  const lines = [i18n.t("title")];
  const grouped = new Map<string, NestedSkill[]>();
  for (const skill of index.skills) {
    const skills = grouped.get(skill.packName) ?? [];
    skills.push(skill);
    grouped.set(skill.packName, skills);
  }

  for (const [pack, skills] of grouped) {
    lines.push(`### ${pack}\n`);
    for (const skill of skills) {
      const description = skill.description ? ` - ${skill.description}` : "";
      const alias = skillAlias(skill);
      const indent = "  ".repeat(Math.max(skill.depth - 1, 0));
      lines.push(`${indent}- \`/${alias}\` ${description}`);
    }
    lines.push("");
  }

  lines.push("---", i18n.t("footer"));
  return lines.join("\n");
}

function registerSkillsCommand(pi: ExtensionAPI, index: SkillIndex): void {
  const command = {
    description: i18n.t("commandDescription"),
    getArgumentCompletions: (): AutocompleteItem[] => commandItems(index),
    handler: async (_args: string, _ctx: SkillCommandContext) => {
      await pi.sendUserMessage(formatSkillsMessage(index), { deliverAs: "followUp" });
    },
  };

  for (const name of COMMAND_ALIASES) pi.registerCommand(name, command);
}

function notifyDiagnostics(ctx: ExtensionContext, loaded: LoadedNestedSkillsConfig, index: SkillIndex): void {
  if (!ctx.hasUI) return;
  for (const warning of loaded.warnings) {
    ctx.ui.notify(i18n.t("configWarning", { reason: warning }), "warning");
  }
  for (const warning of index.warnings) {
    ctx.ui.notify(
      i18n.t("scanWarning", { path: warning.path, reason: warning.reason }),
      "warning",
    );
  }
  if (loaded.explicit && index.skills.length === 0) {
    ctx.ui.notify(
      i18n.t("noSkills", { roots: loaded.config.skillRoots.join(", ") || i18n.t("noRoots") }),
      "warning",
    );
  }
}

/** 注册递归技能别名，同时把实际技能正文交给 Pi 原生技能加载和展开流程。 */
export default function nestedSkillsExtension(pi: ExtensionAPI): void {
  const loaded = loadConfig();
  const scan = scanSkillRoots(loaded.config.skillRoots);
  const index = buildSkillIndex(scan);

  pi.on("resources_discover", () => ({
    // 每个 SKILL.md 单独交给原生 loader，绕过“父目录含 SKILL.md 后停止递归”的规则，
    // 同时保留 Pi 原生的 frontmatter 校验、正文展开和资源来源信息。
    skillPaths: index.skillPaths,
  }));

  pi.on("input", (event) => {
    if (!INPUT_SOURCES.has(event.source)) return { action: "continue" as const };
    const transformed = transformSkillInput(event.text, index);
    if (!transformed) return { action: "continue" as const };
    return {
      action: "transform" as const,
      text: transformed,
      images: event.images,
    };
  });

  pi.on("session_start", (_event, ctx) => {
    notifyDiagnostics(ctx, loaded, index);
    if (index.aliases.size === 0) return;
    ctx.ui.addAutocompleteProvider((current) => createAutocompleteProvider(current, index));
  });

  registerSkillsCommand(pi, index);
}

export { buildSkillIndex, createAutocompleteProvider, formatSkillsMessage };
export type { SkillIndex };
export * from "./config.ts";
export * from "./skills.ts";
