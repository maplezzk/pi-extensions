/** Extract package directories published by matrix or dedicated release workflow jobs. */
export function collectPublishedPackageDirectories(workflow) {
  const matrixDirectories = [...workflow.matchAll(/-\s*dir:\s*(packages\/[\w-]+)/g)].map((match) => match[1]);
  const dedicatedDirectories = [...workflow.matchAll(/^\s*working-directory:\s*(packages\/[\w-]+)\s*$/gm)].map((match) => match[1]);
  return [...new Set([...matrixDirectories, ...dedicatedDirectories])];
}
