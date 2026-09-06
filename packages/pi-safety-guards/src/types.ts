export type RuleAction = "warn" | "confirm" | "block";
export type Detector = "disk-format" | "fork-bomb" | "in-place-edit" | "home-root" | "root-search";
export type RuleMessage = string | { "zh-CN": string; "en-US": string };

export type RuleMatch =
  | { commands: readonly string[] }
  | { detector: Detector }
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
