# Design 写法

## 结构

```markdown
# Design: <标题>

## Architecture
组件划分、数据流、关键技术决定

## Testing Strategy
单元/集成/E2E 验证方式
```

## 规则

- 每条 REQ 都必须在文档中被引用（REQ-xxx），没有孤儿需求。
- 引用真实存在的文件或符号；如果引用未来要创建的文件，标注"待创建"。
- 技术决定写明取舍（选项、选择、理由）。
- 必须包含 Testing/Verification 策略，否则 validator 判硬错误。
