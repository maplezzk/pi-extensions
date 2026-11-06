/**
 * 判定模型的选择项换算：把「可用模型列表」变成可选项，再由面板把选中的值写回配置。
 *
 * 与 UI 解耦：面板只负责拿列表、显示选项、把结果写回配置，这里的规则可以独立测试。
 */

/** 选择列表里第一项固定是「复用当前会话模型」，所以这里要能识别它。 */
export interface ModelChoice {
  /** 选择项的展示文本。 */
  label: string;
  /** 选择该项时写入配置的 model 值；空字符串表示复用当前会话模型。 */
  value: string;
}

/** 把模型标识拼成配置里使用的 `provider/modelId`。 */
export function modelReference(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * 造出选择列表：第一项是「复用当前会话模型」，其余是 `provider/modelId`。
 * 同一个模型只出现一次，避免动态发现重复注册时选项里出现两行一样的模型。
 */
export function buildModelChoices(
  models: ReadonlyArray<{ provider: string; id: string }>,
  reuseLabel: string,
): ModelChoice[] {
  const seen = new Set<string>();
  const choices: ModelChoice[] = [{ label: reuseLabel, value: "" }];
  for (const model of models) {
    const reference = modelReference(model);
    if (seen.has(reference)) continue;
    seen.add(reference);
    choices.push({ label: reference, value: reference });
  }
  return choices;
}

/** 配置值对应的展示文本：空值表示复用当前会话模型。 */
export function formatModelValue(value: string, reuseLabel: string): string {
  return value === "" ? reuseLabel : value;
}
