# pi-extensions-tool-display

`pi-extensions-tool-display` 提供 Pi 工具展示宿主，以及扩展共享的工具结果展示协议和组件工具包。

它提供：

- 结果渲染 middleware 的注册、注销和状态判断；
- Pi 展示宿主尚未加载时的 pending 注册队列；
- 安全识别组件，以及把审计面板追加到原始工具结果后的通用组件组合。

用 `"*"` 注册的结果渲染 middleware 会真的作用到每个扩展注册的工具上：宿主会把这套中间件链路接进自己还没接管的工具，基线保留工具自带的 `renderResult`（没有自带渲染时复刻 Pi 的纯文本预览）。`isResultRenderPipelineActive` 对这些工具也会返回 `true`，调用方不需要再退回「往会话里追加独立 entry」的兜底显示。Pi 自己的内建工具仍由 `registerToolOverrides` 的开关控制。

它同时是一个独立的 Pi 扩展。可以把这个包直接加入 Pi 的 package 列表加载工具展示宿主；`pi-distill`、`pi-tool-supervisor` 的包清单也会声明这个依赖的扩展入口，因此安装功能包时只会加载一个公共宿主，不需要额外安装第二份宿主包。

## 设计边界

这个包负责实际工具展示、展示协议和通用组件组合。具体业务的审计数据提取、文案、状态和布局仍由调用方维护，避免把不同扩展耦合在一起。

内建工具覆盖只替换 Pi 当前已经激活的工具；`registerToolOverrides` 不会启用原本未激活的内建工具。

## 上游引用

本包的展示集成设计用于兼容 MIT 许可的 [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display)，这是 Pi 生态中原始的完整工具展示项目。感谢 MasuRii 的工作。

宿主实现基于 MIT 许可的上游项目，并迁移到本包中统一维护，消费者不再需要额外安装第二个宿主包。

## 安装

如果只需要工具展示宿主，可以直接安装：

```bash
pi install npm:pi-extensions-tool-display
```

安装 `pi-distill` 或 `pi-tool-supervisor` 时，它们的包清单会同时加载这个宿主扩展入口。

## 开发

```bash
npm test
npm run typecheck
```

## 许可证

[MIT](../../LICENSE)
