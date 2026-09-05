import { analyzeShellCommand } from "./shell-command-utils";

const MAVEN_COMMANDS = new Set(["mvn", "mvnDebug", "mvnw", "mvnd", "maven"]);

/** 判断 Bash 中是否存在实际执行的 Maven 命令，包括 wrapper 与嵌套 Shell。 */
export function containsMavenCommand(command: string): boolean {
  return analyzeShellCommand(command).commands.some(({ name }) => MAVEN_COMMANDS.has(name));
}
