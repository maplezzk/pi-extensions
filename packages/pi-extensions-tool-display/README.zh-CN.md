# pi-extensions-tool-display

`pi-extensions-tool-display` 是 Pi 扩展共享的工具结果展示协议和组件工具包。

它提供：

- 结果渲染 middleware 的注册、注销和状态判断；
- Pi 展示宿主尚未加载时的 pending 注册队列；
- 安全识别组件，以及把审计面板追加到原始工具结果后的通用组件组合。

它不是一个独立的 Pi 扩展，不注册工具、命令或 entry renderer。通常由 `pi-distill`、`pi-tool-supervisor` 等扩展作为运行时依赖使用。

## 设计边界

这个包只负责展示协议和通用组件组合。具体业务的审计数据提取、文案、状态和布局仍由调用方维护，避免把不同扩展耦合在一起。

## 开发

```bash
npm test
npm run typecheck
```

## 许可证

[MIT](../../LICENSE)
