/**
 * 斜杠命令的动作模型（纯函数，不依赖 pi API）
 *
 * 无参数菜单和 Tab 补全共用同一份「当前状态下合法动作」的判定，
 * 避免两处各写一套条件后分叉。展示文案由绑定层按 actions.<kind>.* 渲染。
 */

import {
  ARTIFACTS,
  STAGE_ORDER,
  type Artifact,
  type Phase,
  type Status,
} from "./state.ts";

export type SpecActionKind =
  | "new"
  | "use"
  | "status"
  | "approve"
  | "revise"
  | "continue"
  | "stop";

export interface SpecAction {
  kind: SpecActionKind;
  /** 可直接执行的 /spec 参数；需要二级参数的动作只给出动作名。 */
  args: string;
}

/** 需要二级参数的动作名单：类型与运行时判断共用的唯一真相源。 */
const ARGUMENT_ACTION_NAMES = ["use", "revise"] as const;

/** 带二级参数的动作：选中后还要再给一个规格名或阶段名。 */
export type ArgumentActionKind = (typeof ARGUMENT_ACTION_NAMES)[number];

/** 运行时查询集合；键类型有意为 string，因为判断函数的输入是用户键入的任意参数词。 */
const ARGUMENT_ACTION_SET: ReadonlySet<string> = new Set<string>(ARGUMENT_ACTION_NAMES);

/** 判断参数词是否需要二级参数；补全据此插入尾随空格。 */
export function isArgumentAction(kind: string): kind is ArgumentActionKind {
  return ARGUMENT_ACTION_SET.has(kind);
}

/** 执行前必须先核对磁盘状态与批准指纹的动作名单。 */
const PREPARE_ACTION_NAMES = ["status", "approve", "revise", "continue"] as const;

/** 需要前置校验的动作：菜单与快捷子命令共用同一份名单，避免条件分叉。 */
export type PrepareActionKind = (typeof PREPARE_ACTION_NAMES)[number];

/** 运行时查询集合；键类型有意为 string，因为判断函数的输入是用户键入的任意参数词。 */
const PREPARE_ACTION_SET: ReadonlySet<string> = new Set<string>(PREPARE_ACTION_NAMES);

/** 判断参数词是否需要在执行前核对磁盘状态与批准指纹。 */
export function requiresPrepare(kind: string): kind is PrepareActionKind {
  return PREPARE_ACTION_SET.has(kind);
}

const AWAITING_APPROVAL = "awaiting_approval";
const IMPLEMENTATION = "implementation";
const IN_PROGRESS = "in_progress";

/** 批准后进入的下一阶段；当前阶段无后继时返回 null。 */
export function nextPhase(phase: Phase): Phase | null {
  const index = STAGE_ORDER.indexOf(phase);
  if (index < 0 || index >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[index + 1];
}

/**
 * 已开始、因而可以回退重开的文档阶段。
 * 与 state.ts 中 revise 事件的合法性判定保持一致：目标不得晚于当前阶段。
 */
export function revisableArtifacts(phase: Phase): Artifact[] {
  const current = STAGE_ORDER.indexOf(phase);
  if (current < 0) return [];
  return ARTIFACTS.filter((artifact) => STAGE_ORDER.indexOf(artifact) <= current);
}

/** 一级补全写入编辑器的值；需要二级参数的动作带上尾随空格。 */
export function completionValue(kind: SpecActionKind): string {
  return isArgumentAction(kind) ? `${kind} ` : kind;
}

/** 把二级候选拼成可直接执行的 /spec 参数，避免补全与命令各拼一套。 */
export function argumentValue(kind: SpecActionKind, value: string): string {
  return `${kind} ${value}`;
}

/**
 * 当前状态下用户可以执行的动作，顺序即菜单顺序，首项为推荐动作。
 * 无法读取磁盘规格清单时按「没有规格」处理，不猜测不存在的目标。
 */
export function availableActions(input: {
  blocked: boolean;
  active: { phase: Phase; status: Status } | null;
  hasSpecs: boolean;
}): SpecAction[] {
  const actions: SpecAction[] = [];
  const use: SpecAction = { kind: "use", args: "use" };

  if (input.blocked) {
    if (input.hasSpecs) actions.push(use);
    actions.push({ kind: "stop", args: "stop" });
    return actions;
  }

  if (!input.active) {
    actions.push({ kind: "new", args: "new" });
    if (input.hasSpecs) actions.push(use);
    return actions;
  }

  const { phase, status } = input.active;
  if (status === AWAITING_APPROVAL) actions.push({ kind: "approve", args: "approve" });
  if (phase === IMPLEMENTATION && status === IN_PROGRESS) {
    actions.push({ kind: "continue", args: "continue" });
  }
  actions.push({ kind: "status", args: "status" });
  if (revisableArtifacts(phase).length > 0) actions.push({ kind: "revise", args: "revise" });
  actions.push({ kind: "stop", args: "stop" });
  return actions;
}
