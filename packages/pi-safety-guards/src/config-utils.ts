/**
 * Maven 拦截插件配置的纯函数（不依赖 pi 运行时，便于单元测试）。
 *
 * 用于解析"拦截 mvn 后提示使用的 Java 构建/测试 skill 名"，
 * 把优先级判断抽成纯函数，与文件/环境读取解耦。
 */

/**
 * 依据优先级（配置文件 > 环境变量 > 默认值）解析 javaSkill。
 * @param fileValue config.json 里的值
 * @param envValue 环境变量 PI_JAVA_SKILL 的值
 * @param defaultValue 内置默认值（java-build）
 */
export function resolveJavaSkill(
  fileValue: string | null | undefined,
  envValue: string | null | undefined,
  defaultValue: string,
): string {
  if (fileValue) return fileValue;
  if (envValue) return envValue;
  return defaultValue;
}
