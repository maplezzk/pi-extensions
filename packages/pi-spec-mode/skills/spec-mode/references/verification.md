# Verification 写法

需要明确的结论与证据：

```markdown
# Verification

## 结论
PASS / FAIL

## 命令与结果
- `npm test <scope>`：退出码 0，X 通过
- `npm run build`：退出码 0

## 失败项
- （无则写"无"）
```

## 规则

- 命令必须真实执行过，不能编造退出码与输出摘要。
- 失败项、阻塞项如实列出。
- 无自动化验证时，写明手动检查步骤与结果。
