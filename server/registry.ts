import host from '@ext/host'

import { terminal } from '@opencroft/server'
import type { DockerContext } from './docker'

interface DockerRegistry {
  host: string
  usernameSecret: string
  passwordSecret: string
}

interface DockerNodeData {
  registries?: DockerRegistry[]
}

const loggedIn = new Set<string>()

function imageHostname(image: string): string | null {
  const slash = image.indexOf('/')
  if (slash === -1) {
    return null
  }
  const first = image.slice(0, slash)
  if (first.includes('.') || first.includes(':') || first === 'localhost') {
    return first
  }
  return null
}

async function decryptSecret(name: string): Promise<string> {
  const value = await host.secrets.resolve(name)
  if (value === null) {
    throw new Error(`Secret "${name}" not found in any Secrets Store`)
  }
  return value
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function ctxKey(ctx: DockerContext): string {
  const c = ctx as Record<string, unknown>
  return JSON.stringify({ type: c.type, distro: c.distro, host: c.host })
}

export async function ensureRegistryLogin(ctx: DockerContext, dockerNodeId: string, image: string): Promise<void> {
  const registryHost = imageHostname(image)
  if (!registryHost) {
    return
  }
  const node = await host.graph.getNode(dockerNodeId)
  if (!node) {
    return
  }
  const data = node.data as DockerNodeData
  const registry = (data.registries ?? []).find((r) => r.host === registryHost)
  if (!registry?.usernameSecret || !registry.passwordSecret) {
    return
  }
  const cacheKey = `${ctxKey(ctx)}|${registryHost}|${registry.usernameSecret}|${registry.passwordSecret}`
  if (loggedIn.has(cacheKey)) {
    return
  }
  const username = await decryptSecret(registry.usernameSecret)
  const password = await decryptSecret(registry.passwordSecret)
  const script = `printf %s ${shellQuote(password)} | docker login ${shellQuote(registryHost)} -u ${shellQuote(username)} --password-stdin`
  await terminal.exec(ctx, script)
  loggedIn.add(cacheKey)
}
