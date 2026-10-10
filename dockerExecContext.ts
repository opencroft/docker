// Shared by extension.ts (server exposeOutput) and src/client.tsx (client exposeOutput) so the
// 'application' node's instance-terminal-* handle builds an identical docker-exec context in both
// places. Keep this file framework-free (no @opencroft/client, @opencroft/server or React imports) so it can be bundled into
// both the server and client entry points.

export interface DockerExecNodeData {
  workingDir?: unknown
  terminalUser?: unknown
  terminalShell?: unknown
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function buildDockerExecContext(
  via: Record<string, unknown>,
  contextName: string | undefined,
  containerId: string,
  nodeData: DockerExecNodeData,
): Record<string, unknown> {
  const cwd = nonEmptyString(nodeData.workingDir)
  const user = nonEmptyString(nodeData.terminalUser)
  const shell = nonEmptyString(nodeData.terminalShell)
  return {
    type: 'docker-exec',
    via,
    contextName,
    containerId,
    ...(cwd ? { cwd } : {}),
    ...(user ? { user } : {}),
    ...(shell ? { shell } : {}),
  }
}
