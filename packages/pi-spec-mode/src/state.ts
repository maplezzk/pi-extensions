/**
 * spec 模式状态机（纯函数，不依赖 pi API）
 *
 * 状态模型：phase = 当前活动阶段；status = 该阶段的状态。
 * 批准语义：approvedSha256 绑定批准时文档哈希；approvalKind 区分
 * human（用户明确批准）与 accepted-by-profile（quick 模式自动推进）。
 */

export type Profile = "strict" | "quick";
export type Phase =
  | "requirements"
  | "design"
  | "tasks"
  | "implementation"
  | "verification"
  | "complete";
export type Status = "drafting" | "awaiting_approval" | "in_progress" | "done";
export type Artifact = "requirements" | "design" | "tasks" | "verification";

export const ARTIFACTS: Artifact[] = [
  "requirements",
  "design",
  "tasks",
  "verification",
];

/** 上游顺序：越靠前越上游；revise 只允许回退到已开始的阶段或更早。 */
export const STAGE_ORDER: Phase[] = [
  "requirements",
  "design",
  "tasks",
  "implementation",
  "verification",
  "complete",
];

export interface ArtifactRecord {
  /** 最近一次 submit 时文档哈希 */
  sha256?: string;
  /** 批准时绑定的文档哈希 */
  approvedSha256?: string;
  approvalKind?: "human" | "accepted-by-profile";
  approvedAt?: string;
}

export interface StateFile {
  schema: "pi-spec-mode/v1";
  id: string;
  title: string;
  profile: Profile;
  phase: Phase;
  status: Status;
  revision: number;
  artifacts: Record<Artifact, ArtifactRecord>;
  activeTask: string | null;
  completedTasks: string[];
}

export type SpecTransitionEvent =
  | { type: "submit"; sha256: string }
  | { type: "approve" }
  | { type: "revise"; artifact: Artifact }
  | { type: "task_done"; taskId: string }
  | { type: "all_tasks_done" };

export type TransitionResult =
  | { ok: true; state: StateFile }
  | { ok: false; error: string };

export const ARTIFACT_FOR_PHASE: Record<string, Artifact | null> = {
  requirements: "requirements",
  design: "design",
  tasks: "tasks",
  implementation: null,
  verification: "verification",
  complete: null,
};

export function createState(
  slug: string,
  title: string,
  profile: Profile,
): StateFile {
  return {
    schema: "pi-spec-mode/v1",
    id: slug,
    title,
    profile,
    phase: "requirements",
    status: "drafting",
    revision: 1,
    artifacts: {
      requirements: {},
      design: {},
      tasks: {},
      verification: {},
    },
    activeTask: null,
    completedTasks: [],
  };
}

export function parseStatusKey(state: StateFile): string {
  return `${state.phase}.${state.status}`;
}

/**
 * 当前阶段允许通过 write/edit 修改的文档；返回 null 表示该阶段不允许
 * 用普通写入工具改任何文档（执行阶段只允许 tasks.md 记录，见 policy.ts）。
 */
export function computeWriteArtifact(state: StateFile): Artifact | null {
  if (state.phase === "requirements" && state.status === "drafting")
    return "requirements";
  if (state.phase === "design" && state.status === "drafting") return "design";
  if (state.phase === "tasks" && state.status === "drafting") return "tasks";
  if (state.phase === "implementation") return "tasks";
  if (state.phase === "verification" && state.status === "drafting")
    return "verification";
  return null;
}

function stageIndex(phase: Phase): number {
  return STAGE_ORDER.indexOf(phase);
}

function cloneState(state: StateFile): StateFile {
  return {
    ...state,
    artifacts: {
      requirements: { ...state.artifacts.requirements },
      design: { ...state.artifacts.design },
      tasks: { ...state.artifacts.tasks },
      verification: { ...state.artifacts.verification },
    },
    completedTasks: [...(state.completedTasks ?? [])],
  };
}

function bump(state: StateFile): StateFile {
  state.revision += 1;
  return state;
}

/** 清除从 artifact 开始的所有下游（含 artifact 自身）批准记录。 */
function clearDownstream(
  state: StateFile,
  artifact: Artifact,
): StateFile {
  const idx = ARTIFACTS.indexOf(artifact);
  for (let i = idx; i < ARTIFACTS.length; i++) {
    state.artifacts[ARTIFACTS[i]] = {};
  }
  return state;
}

function clearAndJump(
  state: StateFile,
  phase: Phase,
  status: Status,
): StateFile {
  state.phase = phase;
  state.status = status;
  state.activeTask = null;
  state.completedTasks = [];
  return state;
}

export function transition(
  state: StateFile,
  event: SpecTransitionEvent,
): TransitionResult {
  const from = parseStatusKey(state);

  switch (event.type) {
    case "submit": {
      const artifact = ARTIFACT_FOR_PHASE[state.phase];
      if (!artifact) {
        return {
          ok: false,
          error: `submit 只适用于文档阶段，当前：${from}`,
        };
      }
      if (state.status !== "drafting") {
        return { ok: false, error: `只有 drafting 可以提交，当前：${from}` };
      }

      // quick 模式：需求/设计自动推进（accepted-by-profile），任务仍要终审
      if (state.profile === "quick" && state.phase === "requirements") {
        const next = bump(clearAndJump(cloneState(state), "design", "drafting"));
        next.artifacts.requirements = {
          sha256: event.sha256,
          approvedSha256: event.sha256,
          approvalKind: "accepted-by-profile",
          approvedAt: new Date().toISOString(),
        };
        return { ok: true, state: next };
      }
      if (state.profile === "quick" && state.phase === "design") {
        const next = bump(clearAndJump(cloneState(state), "tasks", "drafting"));
        next.artifacts.design = {
          sha256: event.sha256,
          approvedSha256: event.sha256,
          approvalKind: "accepted-by-profile",
          approvedAt: new Date().toISOString(),
        };
        return { ok: true, state: next };
      }

      // strict 与 quick 的 tasks / verification：进入待批
      const next = bump(cloneState(state));
      next.status = "awaiting_approval";
      next.artifacts[artifact] = {
        sha256: event.sha256,
      };
      return { ok: true, state: next };
    }

    case "approve": {
      if (state.status !== "awaiting_approval") {
        return { ok: false, error: `没有待批文档，当前：${from}` };
      }
      const artifact = ARTIFACT_FOR_PHASE[state.phase];
      if (!artifact) {
        return { ok: false, error: `当前阶段无文档可批准：${from}` };
      }
      const record = state.artifacts[artifact];
      if (!record.sha256) {
        return { ok: false, error: `${artifact} 缺少提交指纹，无法批准` };
      }

      const next = bump(cloneState(state));
      next.artifacts[artifact] = {
        ...record,
        approvedSha256: record.sha256,
        approvalKind: "human",
        approvedAt: new Date().toISOString(),
      };

      if (state.phase === "requirements") {
        const s = clearAndJump(next, "design", "drafting");
        return { ok: true, state: s };
      }
      if (state.phase === "design") {
        const s = clearAndJump(next, "tasks", "drafting");
        return { ok: true, state: s };
      }
      if (state.phase === "tasks") {
        // 执行授权
        const s = clearAndJump(next, "implementation", "in_progress");
        return { ok: true, state: s };
      }
      if (state.phase === "verification") {
        const s = clearAndJump(next, "complete", "done");
        return { ok: true, state: s };
      }
      return { ok: false, error: `当前阶段不可批准：${from}` };
    }

    case "revise": {
      const target = event.artifact;
      const currentIdx = stageIndex(state.phase);
      const targetIdx =
        target === "verification" ? 4 : ARTIFACTS.indexOf(target);
      if (targetIdx > currentIdx) {
        return {
          ok: false,
          error: `${target} 阶段尚未开始，无法回退（当前：${from}）`,
        };
      }
      const next = bump(clearDownstream(cloneState(state), target));
      const phase =
        target === "requirements"
          ? "requirements"
          : target === "design"
            ? "design"
            : target === "tasks"
              ? "tasks"
              : "verification";
      const s = clearAndJump(next, phase, "drafting");
      return { ok: true, state: s };
    }

    case "task_done": {
      if (state.phase !== "implementation" || state.status !== "in_progress") {
        return { ok: false, error: `task_done 只在实现执行中有效，当前：${from}` };
      }
      const next = bump(cloneState(state));
      next.activeTask = event.taskId;
      if (!next.completedTasks.includes(event.taskId)) {
        next.completedTasks.push(event.taskId);
      }
      return { ok: true, state: next };
    }

    case "all_tasks_done": {
      if (state.phase !== "implementation" || state.status !== "in_progress") {
        return { ok: false, error: `所有任务完成只在实现执行中有效，当前：${from}` };
      }
      const next = bump(clearAndJump(cloneState(state), "verification", "drafting"));
      next.activeTask = null;
      return { ok: true, state: next };
    }
  }
}

/** 检查下游批准是否因上游哈希失效需要回退；返回新 state 或 null（无变化）。 */
export function invalidateIfStale(
  state: StateFile,
  currentSha: Record<Artifact, string | null>,
): StateFile | null {
  const next = cloneState(state);
  const stages: Array<[Artifact, Phase]> = [
    ["requirements", "requirements"],
    ["design", "design"],
    ["tasks", "tasks"],
  ];
  for (const [artifact, stage] of stages) {
    const rec = next.artifacts[artifact];
    if (!rec.approvedSha256 || currentSha[artifact] === rec.approvedSha256) continue;
    clearDownstream(next, artifact);
    next.phase = stage;
    next.status = "drafting";
    next.activeTask = null;
    next.completedTasks = [];
    return bump(next);
  }

  return null;
}
