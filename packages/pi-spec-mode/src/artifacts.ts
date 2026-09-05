/**
 * 文档校验器（纯函数）
 *
 * 约定：硬错误（errors）阻止提交；警告（warnings）放行但展示给用户。
 * 机器字段约定：REQ-<n> / TASK-<kebab> / Depends on / Acceptance / Verification。
 */

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const VAGUE_TERMS = [
  "快速",
  "友好",
  "适当",
  "用户友好",
  "流畅",
  "fast",
  "user-friendly",
  "appropriate",
  "efficient",
];

const TEMPLATE_PLACEHOLDER = /\[[^\]]*\]/;

export function extractRequirementIds(md: string): string[] {
  const ids = new Set<string>();
  const re = /^#{2,4}\s+(REQ-\d+)\b/gm;
  for (const m of md.matchAll(re)) ids.add(m[1]);
  return [...ids];
}

export function validateRequirements(md: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!md.trim()) errors.push("requirements.md 为空");

  const reqIds = extractRequirementIds(md);
  if (reqIds.length === 0)
    errors.push("未找到 REQ-<n> 标题（如 ### REQ-001 需求名）");

  const earsLines = md
    .split("\n")
    .filter((l) => /^\s*(1\.|2\.|3\.|4\.|5\.|6\.|7\.|8\.|9\.|\*|-)\s+(WHEN|IF|WHILE|WHERE)\b/.test(l));
  if (earsLines.length === 0 && reqIds.length > 0)
    errors.push("没有 WHEN/IF 开头的验收标准行");
  if (reqIds.length > 0 && !/acceptance|验收/i.test(md))
    warnings.push("文档未标注 Acceptance 段落");

  if (reqIds.length > 0) {
    const noShall = earsLines.filter((l) => !/SHALL\b/i.test(l));
    if (noShall.length > 0)
      warnings.push(`${noShall.length} 条验收标准未使用 SHALL（EARS 规范）`);
  }

  const vague = VAGUE_TERMS.filter((t) => md.includes(t));
  if (vague.length > 0)
    warnings.push(`出现不可测量词：${vague.join("、")}`);

  if (TEMPLATE_PLACEHOLDER.test(md))
    warnings.push("内容可能含未填写的模板占位符");

  if (!/out of scope|范围外|非目标|不做/i.test(md))
    warnings.push("缺少 Out of Scope 声明");

  return { errors, warnings };
}

export function extractTaskIds(md: string): string[] {
  const ids = new Set<string>();
  const re = /^#{2,4}\s+(TASK-[A-Za-z0-9_-]+)\b/gm;
  for (const m of md.matchAll(re)) ids.add(m[1]);
  return [...ids];
}

interface TaskMeta {
  id: string;
  dependsOn: string[];
  references: string[];
  hasAcceptance: boolean;
  hasVerification: boolean;
}

function parseTasks(md: string): TaskMeta[] {
  const lines = md.split("\n");
  const tasks: TaskMeta[] = [];
  let current: TaskMeta | null = null;

  for (const line of lines) {
    const header = line.match(/^#{2,4}\s+(TASK-[A-Za-z0-9_-]+)\b/);
    if (header) {
      if (current) tasks.push(current);
      current = {
        id: header[1],
        dependsOn: [],
        references: [],
        hasAcceptance: false,
        hasVerification: false,
      };
      continue;
    }
    if (!current) continue;
    if (/depends on/i.test(line)) {
      for (const m of line.matchAll(/TASK-[A-Za-z0-9_-]+/g)) {
        if (m[0] !== current.id) current.dependsOn.push(m[0]);
      }
    }
    for (const m of line.matchAll(/REQ-\d+/g)) current.references.push(m[0]);
    if (/acceptance/i.test(line)) current.hasAcceptance = true;
    if (/verification/i.test(line)) current.hasVerification = true;
  }
  if (current) tasks.push(current);
  return tasks;
}

/** 依赖环检测：DFS 三色标记。 */
function findCycle(
  tasks: TaskMeta[],
): string | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map<string, 0 | 1 | 2>();

  const visit = (id: string, path: string[]): string | null => {
    color.set(id, 1);
    path.push(id);
    const node = byId.get(id);
    if (!node) return null;
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) continue;
      const c = color.get(dep) ?? 0;
      if (c === 1) return `依赖环：${[...path, dep].join(" -> ")}`;
      if (c === 0) {
        const cycle = visit(dep, path);
        if (cycle) return cycle;
      }
    }
    path.pop();
    color.set(id, 2);
    return null;
  };

  for (const t of tasks) {
    if ((color.get(t.id) ?? 0) === 0) {
      const cycle = visit(t.id, []);
      if (cycle) return cycle;
    }
  }
  return null;
}

export function validateDesign(
  md: string,
  reqIds: string[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!md.trim()) errors.push("design.md 为空");

  const referenced = new Set(reqIds.filter((id) => md.includes(id)));
  const missing = reqIds.filter((id) => !referenced.has(id));
  if (missing.length > 0)
    errors.push(`以下需求在设计中没有映射：${missing.join(", ")}`);

  const hasArchitecture = /architecture|架构/i.test(md);
  const hasTestStrategy = /testing strategy|验证策略|验证方式/i.test(md);
  if (!hasArchitecture) warnings.push("设计缺少 Architecture 章节");
  if (!hasTestStrategy) errors.push("设计缺少 Testing/Verification 策略");

  if (TEMPLATE_PLACEHOLDER.test(md))
    warnings.push("内容可能含未填写的模板占位符");

  return { errors, warnings };
}

export function validateTasks(
  md: string,
  reqIds: string[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!md.trim()) errors.push("tasks.md 为空");

  const taskIds = extractTaskIds(md);
  if (taskIds.length === 0) {
    errors.push("未找到 TASK-<id> 标题（如 ### TASK-auth-client · 标题）");
    return { errors, warnings };
  }

  const tasks = parseTasks(md);

  const seen = new Set<string>();
  for (const t of tasks) {
    if (seen.has(t.id)) errors.push(`任务 ID 重复：${t.id}`);
    seen.add(t.id);
  }

  const byId = new Set(taskIds);
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep))
        errors.push(`${t.id} 依赖不存在：${dep}`);
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) errors.push(cycle);

  const allReferences = new Set(tasks.flatMap((t) => t.references));
  const uncovered = reqIds.filter((id) => !allReferences.has(id));
  if (uncovered.length > 0)
    errors.push(`以下 Must Have 需求没有任务覆盖：${uncovered.join(", ")}`);

  for (const t of tasks) {
    if (!t.hasAcceptance)
      warnings.push(`${t.id} 缺少 Acceptance 验收标注`);
    if (!t.hasVerification)
      warnings.push(`${t.id} 缺少 Verification 验证标注`);
    if (t.dependsOn.length === 0)
      warnings.push(`${t.id} 未声明 Depends on（无依赖可忽略）`);
  }

  return { errors, warnings };
}

export function validateVerification(md: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!md.trim()) errors.push("verification.md 为空");

  const hasVerdict = /PASS|通过|失败|FAIL|结论|verdict/i.test(md);
  if (!hasVerdict)
    errors.push("缺少结论（PASS/FAIL 或 通过/失败）");

  const hasCommand = /(命令|command|手动检查|manual|\b(npm|pnpm|yarn|mvn|\.\/gradlew|cargo|go test|pytest)\b)/i.test(md);
  if (!hasCommand)
    errors.push("缺少验证命令或手动检查依据");

  const hasFailures = /失败项|failures|blocker|阻塞/i.test(md);
  if (!hasFailures) warnings.push("未说明失败项或阻塞（有则填，无则忽略）");

  return { errors, warnings };
}

export function validateArtifact(
  artifact: "requirements" | "design" | "tasks" | "verification",
  md: string,
  requirementsMd: string,
): ValidationResult {
  const reqIds = extractRequirementIds(requirementsMd);
  switch (artifact) {
    case "requirements":
      return validateRequirements(md);
    case "design":
      return validateDesign(md, reqIds);
    case "tasks":
      return validateTasks(md, reqIds);
    case "verification":
      return validateVerification(md);
  }
}
