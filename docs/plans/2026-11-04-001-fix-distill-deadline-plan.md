# 工具结果提炼的共享重试与等待期限

## 目标与边界

目标：单项提炼不能因为忽略取消的模型/鉴权Promise无限挂起，混合错误不能把两份重试额度相加。仅修改pi-distill；不截断主Agent任务、不重执行原工具、不改认证来源或部署。公开包不包含个人路径、私有服务或历史用户数据。

需求检查：保留现有timeoutSeconds、timeoutRetryCount、errorRetryCount字段及各类上限；总额外重试上限取两者较大值。默认1/1由最多3次完整提炼变为最多2次，这是有意的兼容性变化，双语README和配置面板说明必须写清。一次提炼的模型等待总期限为timeoutSeconds乘允许总尝试数，JSON修复占当前尝试时间，不额外延长。使用单调时钟，拒绝迟到结果及迟到鉴权后的新请求；上游取消是尽力而为，不承诺已发请求不计费。

复用检查：pi-model-request提供鉴权、provider会话头和completion包装，继续使用；它没有等待期限API。pi-tool-supervisor的条件超时是私有实现，不跨包导入或复制整套框架。本次不修改共享请求器，不重新实现鉴权。

## Terms

- 尝试：一次完整提炼，内部可有一次既有JSON-only修复。
- 共享重试额度：timeoutRetryCount和errorRetryCount中较大值；每类自身上限同时有效。
- 等待期限：仅一项工具结果提炼的模型等待，不是主Agent整轮或原工具业务执行期限。
- 迟到：尝试已取消/超时后才返回的鉴权或模型响应。

## Requirements

- R-1：不响应AbortSignal的模型Promise在尝试期限后也必须释放等待；总期限内按额度停止，保留原工具事实和失败诊断。
- R-2：鉴权挂起同样有界；到期后鉴权即使成功，也不得新增completion请求。
- R-3：普通异常与超时共享总额度，同时保持各类0禁用及单类重试后成功的既有行为；默认混合失败最多2次完整提炼。
- R-4：父任务取消后立即停止等待和重试；迟到响应不得被采用或触发JSON修复。JSON-only修复失败/超时不得重新发送完整工具输出。
- R-5：正常、RAW、JSON修复和原输出限制保持，默认配置键/值不变；双语文档、面板和诊断说明准确表达共享额度及总期限。

## TASK-distill-deadline

状态：implementation_verified；首次审查反馈已由主Agent闭合，Git交付待完成。独立任务worktree；主Agent负责全部写入和测试。修改范围：packages/pi-distill/src/index.ts、tests/bash-output-summary.test.ts、locales/index.json、README.md、README.zh-CN.md及本计划。

1. 在现有公开processToolResult测试中增加受控时钟的未响应取消、鉴权迟到、混合错误、父取消及JSON修复期限场景，先记录RED。断言原结果、尝试数、请求边界和迟到不再调用；不启动真实Agent、模型或网络。
2. summarizeOutputWithRetries以单调时钟生成总deadline，重试共用上限；Promise竞争强制返回，取消真实子信号，finally清理timer/listener。通过现有请求器的completion边界检查到期/取消，防止迟到鉴权再发请求、迟到响应进入解析；显式保留JSON修复阶段语义。需求R-1～R-4。
3. 文档/面板说明共享上限和兼容变化；所有新增用户可见消息有中英catalog。不新增配置键、不改默认值或依赖。需求R-5。
4. 运行受影响测试、包typecheck及仓库要求的npm run check。首次只读需求/架构/测试/安全审查一次，主Agent修反馈并定向补验，不复审；提交push创建PR，按当前有效授权及真实检查结果判断合并。

## E2E

E2E Required: not_applicable。Evidence publication: not_applicable。

本任务是模型适配器的取消/重试控制，没有产品页面或业务操作链路。验证从公开processToolResult进入真实提炼编排、共享鉴权包装、JSON协议和原结果回退，外部模型/鉴权与时钟受控，属于集成验证，不冒称真实模型语义、UI或部署E2E；不为满足形式启动真实模型任务或生成虚构业务验收。

## 交付判据

保留所有RED和失败。当前代码的必要检查通过、首次审查问题有处置、实际PR/head/CI可回读；本机既有WIP不覆盖。npm发布由release-please维护，不手动发版；不安装或部署消费者，不把源码合并说成现场恢复。

## 当前证据与处置

基线：原结果提炼文件51项通过。新增5场景的RED全部为实际行为断言失败：不协作调用未释放、混合错误出现第3次调用、父取消未返回、JSON修复挂起未返回。修复后新增5项通过。

全文件首次回归55通过/1失败：原超时用例只接受替身的“provider aborted”，现在由本地期限先返回明确“Distillation model attempt timed out”。保留原用例、请求次数和原文断言，只将错误断言收紧为新精确诊断，不删除或放宽失败场景。包typecheck已通过。所有旧失败日志保留。

仓库要求的 `npm run check` 已完整通过（类型、所有工作区测试、包与策略检查），没有失败。完整原始日志保留在本机执行记录，不提交个人路径或历史业务材料。

## 首次审查反馈与主Agent处置

完成唯一一次只读审查，3个reviewer承担6个单元（需求、架构、测试质量、测试成本、安全、代码规范）。R-3指出期限后rejection可能先于timer回调，误按普通异常额度重试；主Agent依据单调期限重新分类并补两种0禁用配置。测试反馈另促成JSON修复前的期限检查，并补较大非对称额度、JSON修复剩余时间及父取消后的迟到响应。新增定点RED为6通过/3失败，修正后9项全部通过。保留原审查和全部失败，未再次review，不冒称最终反馈修复已独立复审。

审查中一名reviewer误执行一次只读git status（空输出），没有写入；偏离与原始返回均保存。包复用、认证来源、配置默认值、公开可移植边界未改变。

反馈后再次完成必要的 `npm run check`，全部工作区和策略检查通过；代码与测试已验证，无再次审查。
