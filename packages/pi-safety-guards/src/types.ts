export type RuleAction = "warn" | "confirm" | "block";
export type RuleMessage = string | { "zh-CN": string; "en-US": string };

/**
 * 匹配器只有下面几种，每种都在 JSON 里写清楚匹配什么，不存在名字到隐藏逻辑的映射。
 * commands：命令名精确相等；commandPrefixes：命令名前缀；commandPattern：原始命令文本正则。
 */
export type RuleMatch =
  | { commands: readonly string[] }
  | { commandPrefixes: readonly string[] }
  | { commandPattern: string }
  | { outsideRoots: readonly string[] }
  | { module: string };

export interface SafetyRule {
  readonly id: string;
  readonly action: RuleAction;
  readonly match: RuleMatch;
  readonly message?: RuleMessage;
}

export interface SafetyConfig {
  readonly rules: readonly SafetyRule[];
}

/** 用户规则模块只接收匹配数据，不接收 Pi 的注册或执行接口。 */
export interface RuleContext {
  readonly command: string;
  readonly cwd: string;
  readonly commands: readonly {
    readonly name: string;
    readonly args: readonly string[];
  }[];
}

export type RuleMatcher = (context: RuleContext) => boolean | Promise<boolean>;
