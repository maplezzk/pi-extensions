# pi-spec 可靠性验证记录

## 结论

实现与可自动执行的确定性验证通过。**不等同于真实模型端到端或人工验收完成**。所有修改未提交，未合并、发布或切换安装。

## 本轮实现

- npm 包名 `@maplezzk/pi-spec`，目录及展示名 `pi-spec`；持久化 schema 与 session key 保持 v1 兼容。
- 确认前后核查规格身份、revision 和文档 SHA；落盘成功后才更新内存。恢复损坏状态明确阻断；工具恢复只撤销本扩展可观察到的差量。
- 任务定义冻结；进度仅来自当前状态与当前执行轮的新 DONE，不扫描历史标记。
- 包内五阶段双语 procedure 为唯一方法正文；context 事件每次请求只保留当前正文一份及短状态。正文缺失补载，旧方法移除，只触碰自有 custom 消息。
- 待批仅等批准或 revise；complete 不再构造文档；方法资源失败阻断。全局只保留 `configure-pi-spec` 操作入口，旧 `/skill:spec-mode` 已移除并写明迁移。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| 新上下文回归 RED | 3 个入口用例先失败，原因均为缺少 context handler |
| 包级 check | 105/105 测试，类型检查、npm pack dry-run 通过 |
| 全仓 check | 12 个包，1249/1249 测试，类型检查、本机解耦和包登记门禁通过 |
| 技能静态验证 | validate_skill.py 通过 |
| 打包资源 | 含五个 procedures/*.json 和根 SKILL.md；无旧 skills 目录 |
| git diff --check | 通过 |

全仓检查使用临时 `PI_CODING_AGENT_DIR`，避免宿主配置污染；无须修改或合并其他包。最终检查日志：`/tmp/pi-spec-final-check.log`。

## 实际 Pi 宿主验证

使用独立临时项目、独立配置目录、显式扩展路径、本地确定性 OpenAI-compatible HTTP provider；不读取或覆盖用户真实模型凭证与安装配置。确定性 provider 按测试脚本返回工具调用，**不是语言模型遵循率测试**。

### RPC

Pi **0.80.10**（声明支持版本）34 项检查通过：strict/quick 全链路、确认期间改文档拒绝批准、任务必须人工确认协议、当前方法仅一份、阶段切换清旧方法、inactive/waiting 无 submit、实现 bash 权限、DONE 后验证、complete 无伪文档、revise 不重放 DONE、新 session/恢复/进程重启、真实 compact 后方法补回、目标丢失清工具及 stop 恢复。

证据：`/tmp/pi-spec-rpc-64nasu5v/result.json`、`requests.json`、`events.json`。

Pi **0.85.1** 额外烟测 33 项通过（未含后补的进程重启项）；这不修改本包 peerDependencies，也不单凭烟测承诺支持该版本。证据：`/tmp/pi-spec-rpc-ly6r45uv/result.json`。

### TUI

Pi **0.80.10** 在真实 PTY TUI 的 6 项检查通过：profile selector、进度 Widget、提交待批、显示绑定文档路径的确认对话框、Ctrl+C 取消后仍待批、`/reload` 恢复待批状态。

证据：`/tmp/pi-spec-rpc-xdrls9e7/result.json`、`tui.raw`、`tui.txt`。

Pi **0.85.1** 同样 6 项通过，证据：`/tmp/pi-spec-rpc-87r_kro4/result.json`。

TUI 检查确实启动终端 UI，未用 RPC 冒充。确认取消由脚本按键驱动；RPC 的确认响应也由脚本驱动，不能称作真实人工批准。

### 测试脚本与前置失败

临时脚本：`/tmp/pi-spec-rpc-smoke.py`、`/tmp/pi-spec-tui-smoke.py`，入参是待测包 `index.ts` 的绝对路径；通过 PATH 选择 0.80.10 的本地 Pi CLI。

- RPC 初次 compact 被宿主以 `Nothing to compact (session too small)` 拒绝；调整隔离 fixture 的 keepRecentTokens 后通过，没有修改产品行为。
- TUI 初次在启动未完成时发送命令；随后改为等待 ready footer。
- 另一次 Esc 和下一条命令连续写入导致按键合并，测试意外选中确认；改用 Ctrl+C 并等待对话框关闭后验证通过。只发生在临时测试规格，没有用户产物或批准受影响。

## 未验证与残留

- **NOT_RUN：真实模型完整端到端及提示遵循质量**。本轮全部模型响应来自确定性测试 provider。
- **NOT_RUN：真实用户人工审批及真实 TUI 树导航完整矩阵**。树导航逻辑由入口回归测试覆盖；真实宿主已验证 new/switch/restart/reload，不把这些说成实际 `/tree` 验收。
- 本轮未做独立 reviewer 审查；按用户要求主 Agent 实现和自检。
- 安装时曾报告 5 个依赖漏洞（2 moderate、3 high），本轮未自动升级。
- 不承诺跨进程完整事务隔离；外部同时修改工具集的不可观察归属歧义已在 README 说明。
- npm scope 发布权限未核验，本轮不发布。
