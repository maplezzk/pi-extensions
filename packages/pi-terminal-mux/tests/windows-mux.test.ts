import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { commandTerminator, weztermActivateArgs } from "../src/backends/wezterm.ts";
import { powershellEscape } from "../src/shell.ts";
import { herdrSourceFlag } from "../src/backends/herdr.ts";
import {
  resolveSendInterpreter,
  sendScriptExtension,
  buildSendScriptContent,
  buildMuxInvocation,
} from "../src/surface.ts";

// U-001：Windows WezTerm 命令提交终止符
describe("commandTerminator (U-001)", () => {
  test("win32 使用 CR", () => {
    assert.equal(commandTerminator("win32"), "\r");
  });
  test("POSIX 平台使用 LF", () => {
    assert.equal(commandTerminator("darwin"), "\n");
    assert.equal(commandTerminator("linux"), "\n");
  });
  test("命令正文不被改写（仅追加终止符）", () => {
    // 验证终止符决策可作为 ops.send 的 payload 追加而不改动正文
    const raw = "Write-Host hi";
    assert.equal(raw + commandTerminator("win32"), "Write-Host hi\r");
    assert.equal(raw + commandTerminator("darwin"), "Write-Host hi\n");
  });
});

// U-002：长命令解释器选择
describe("resolveSendInterpreter (U-002)", () => {
  test("省略 interpreter 时保持 Bash 默认值", () => {
    assert.equal(resolveSendInterpreter(), "bash");
  });
  test("显式 PowerShell 时保持调用方选择", () => {
    assert.equal(resolveSendInterpreter("powershell"), "powershell");
  });
});

describe("sendScriptExtension (U-002)", () => {
  test("Bash 使用 .sh 扩展名", () => {
    assert.equal(sendScriptExtension("bash"), ".sh");
  });
  test("PowerShell 使用 .ps1 扩展名", () => {
    assert.equal(sendScriptExtension("powershell"), ".ps1");
  });
});

describe("buildSendScriptContent (U-002)", () => {
  test("Bash 脚本含 shebang、preamble 与 command，使用 LF 分隔", () => {
    const content = buildSendScriptContent(
      "bash",
      "export MY_FLAG=1",
      "echo hello",
    );
    assert.equal(content, "#!/bin/bash\nexport MY_FLAG=1\necho hello\n");
  });
  test("Bash 无 preamble 时仍以 shebang 开头", () => {
    assert.equal(buildSendScriptContent("bash", undefined, "echo hi"), "#!/bin/bash\necho hi\n");
  });
  test("PowerShell 脚本无 shebang，preamble 与 command 以 CRLF 分隔", () => {
    const content = buildSendScriptContent(
      "powershell",
      "$env:MY_FLAG = '1'",
      "Write-Host hello",
    );
    assert.equal(content, "$env:MY_FLAG = '1'\r\nWrite-Host hello\r\n");
  });
  test("PowerShell 无 preamble 时不写 shebang", () => {
    assert.equal(
      buildSendScriptContent("powershell", undefined, "Write-Host hi"),
      "Write-Host hi\r\n",
    );
  });
});

describe("buildMuxInvocation (U-002)", () => {
  test("Bash 使用 bash <script.sh> 并做 shell 转义", () => {
    assert.equal(buildMuxInvocation("bash", "/tmp/a b.sh"), "bash '/tmp/a b.sh'");
  });
  test("PowerShell 使用 powershell.exe -File <script.ps1> 并做 PowerShell 单引号转义", () => {
    assert.equal(
      buildMuxInvocation("powershell", "/tmp/a b.ps1"),
      "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File '/tmp/a b.ps1'",
    );
  });
});

describe("powershellEscape (U-002)", () => {
  test("普通路径加单引号", () => {
    assert.equal(powershellEscape("/tmp/x"), "'/tmp/x'");
  });
  test("单引号路径按 PowerShell 规则双写转义", () => {
    assert.equal(powershellEscape("/tmp/o'k.ps1"), "'/tmp/o''k.ps1'");
  });
});

// U-003：herdr 读屏 source 映射
describe("herdrSourceFlag (U-003)", () => {
  test("recent_unwrapped 映射为 recent-unwrapped", () => {
    assert.equal(herdrSourceFlag("recent_unwrapped"), "recent-unwrapped");
  });
  test("recent 与 visible 原样保留", () => {
    assert.equal(herdrSourceFlag("recent"), "recent");
    assert.equal(herdrSourceFlag("visible"), "visible");
  });
});

// U-004：WezTerm 分屏可选激活
// 默认不激活由 createSplit 的 `if (options?.activate)` 守卫保证（activate 缺省为 false），
// 这里验证 activate:true 时构造的 CLI 参数正确，且该参数数组仅用于激活。
describe("weztermActivateArgs (U-004)", () => {
  test("activate:true 时对新 pane id 发出 activate-pane", () => {
    assert.deepEqual(weztermActivateArgs("7"), ["cli", "activate-pane", "--pane-id", "7"]);
  });
});
