import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRequirements,
  validateDesign,
  validateTasks,
  validateVerification,
  validateArtifact,
  extractRequirementIds,
  extractTaskIds,
} from "../src/artifacts.ts";

const GOOD_REQ = `# Requirements: 示例

### REQ-001 登录

**User Story:** 作为用户，我想登录，以便使用系统。

**Acceptance Criteria:**
1. WHEN 用户提交有效凭据 THEN 系统 SHALL 建立会话
2. WHEN 凭据无效 THEN 系统 SHALL 提示错误

## Out of Scope
- 注册

## Glossary
`;

const BAD_REQ = `# Requirements

没有需求编号
`;

describe("requirements 校验", () => {
  test("合格文档零错误（可能有警告）", () => {
    const r = validateRequirements(GOOD_REQ);
    assert.deepEqual(r.errors, []);
  });

  test("无 REQ-ID 报错", () => {
    const r = validateRequirements(BAD_REQ);
    assert.ok(r.errors.some((e) => e.includes("REQ")));
  });

  test("空文档报错", () => {
    const r = validateRequirements("");
    assert.ok(r.errors.length > 0);
  });

  test("EARS 缺 SHALL 给警告", () => {
    const md = `### REQ-001 登录

**Acceptance Criteria:**
1. WHEN 用户提交 THEN 系统 建立会话
`;
    const r = validateRequirements(md);
    assert.deepEqual(r.errors, []);
    assert.ok(r.warnings.some((w) => w.includes("SHALL")));
  });

  test("模糊词给警告", () => {
    const md = `${GOOD_REQ}\n\n系统应当快速响应用户请求\n`;
    const r = validateRequirements(md);
    assert.ok(r.warnings.some((w) => w.includes("不可测量")));
  });

  test("无 Out of Scope 给警告", () => {
    const md = GOOD_REQ.replace(/## Out of Scope[\s\S]*?## Glossary/, "## Glossary");
    const r = validateRequirements(md);
    assert.ok(r.warnings.some((w) => w.includes("Out of Scope")));
  });

  test("提取 REQ ID 去重", () => {
    assert.deepEqual(
      extractRequirementIds(`${GOOD_REQ}\n### REQ-001 重复`),
      ["REQ-001"],
    );
  });
});

describe("design 校验", () => {
  const design = (refs: string) => `# Design

## Architecture
组件划分

## Testing Strategy
单元测试

映射：${refs}
`;

  test("覆盖全部需求则无硬错误", () => {
    const r = validateDesign(design("REQ-001"), ["REQ-001"]);
    assert.deepEqual(r.errors, []);
  });

  test("未覆盖的需求报错", () => {
    const r = validateDesign(design("REQ-002"), ["REQ-001", "REQ-002"]);
    assert.ok(r.errors.some((e) => e.includes("REQ-001")));
  });

  test("缺少测试策略报错", () => {
    const md = design("REQ-001").replace("## Testing Strategy", "## 其他");
    const r = validateDesign(md, ["REQ-001"]);
    assert.ok(r.errors.some((e) => e.includes("Testing")));
  });
});

describe("tasks 校验", () => {
  const reqIds = ["REQ-001", "REQ-002"];

  const fullTasks = `# Tasks

### TASK-a · 任务A
- Status: todo
- Depends on: none
- Requirements: REQ-001, REQ-002
- Acceptance: 可观察
- Verification: npm test
`;

  test("合格任务无硬错误", () => {
    const r = validateTasks(fullTasks, reqIds);
    assert.deepEqual(r.errors, []);
  });

  test("重复 ID 报错", () => {
    const md = `${fullTasks}\n### TASK-a · 任务A2\n- Acceptance: x\n- Verification: y\n`;
    const r = validateTasks(md, reqIds);
    assert.ok(r.errors.some((e) => e.includes("重复")));
  });

  test("依赖不存在报错", () => {
    const md = fullTasks.replace("Depends on: none", "Depends on: TASK-nope");
    const r = validateTasks(md, reqIds);
    assert.ok(r.errors.some((e) => e.includes("TASK-nope")));
  });

  test("依赖环报错", () => {
    const md = `# Tasks

### TASK-a · A
- Depends on: TASK-b
- Acceptance: x
- Verification: y

### TASK-b · B
- Depends on: TASK-a
- Acceptance: x
- Verification: y
`;
    const r = validateTasks(md, reqIds);
    assert.ok(r.errors.some((e) => e.includes("依赖环")));
  });

  test("Must Have 无覆盖报错", () => {
    const r = validateTasks(fullTasks, ["REQ-999"]);
    assert.ok(r.errors.some((e) => e.includes("REQ-999")));
  });

  test("缺 Acceptance/Verification 给警告", () => {
    const md = fullTasks.replace("- Acceptance: 可观察\n", "");
    const r = validateTasks(md, reqIds);
    assert.ok(r.warnings.some((w) => w.includes("TASK-a")));
  });

  test("提取 TASK ID", () => {
    assert.deepEqual(extractTaskIds(fullTasks), ["TASK-a"]);
  });
});

describe("verification 校验", () => {
  test("有结论与命令通过", () => {
    const r = validateVerification("# Verification\n\n结论：PASS\n命令：npm test\n");
    assert.deepEqual(r.errors, []);
  });

  test("缺结论报错", () => {
    const r = validateVerification("# Verification\n\n跑了 npm test\n");
    assert.ok(r.errors.some((e) => e.includes("结论")));
  });

  test("缺命令依据报错", () => {
    const r = validateVerification("# Verification\n\n结论：PASS\n");
    assert.ok(r.errors.some((e) => e.includes("命令")));
  });
});

describe("validateArtifact 路由", () => {
  test("requirements 路由不依赖其他文档", () => {
    const r = validateArtifact("requirements", GOOD_REQ, "");
    assert.deepEqual(r.errors, []);
  });

  test("tasks 路由使用 requirements 的需求列表", () => {
    const tasks = `# Tasks

### TASK-a · A
- Acceptance: x
- Verification: y
- Requirements: REQ-001
`;
    const r = validateArtifact("tasks", tasks, GOOD_REQ);
    assert.deepEqual(r.errors, []);
  });
});
