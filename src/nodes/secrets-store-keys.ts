import { useGraphNodes } from '@opencroft/client/canvas'
import { useMemo } from 'react'

// Core's Secrets Store node, in the qualified form (`<owner>.<extension>.<type>`)
// graph data carries another extension's node type.
const SECRETS_STORE_NODE_TYPE = 'builtin.core.core-secrets-store'

interface SecretsStoreNode {
  type?: string
  data?: { secretKeys?: string[] }
}

/** Every key held by a Secrets Store node on the open canvas, sorted and de-duplicated. */
export function useSecretsStoreKeys(): string[] {
  const nodes = useGraphNodes() as SecretsStoreNode[]
  return useMemo(() => {
    const keys = new Set<string>()
    for (const n of nodes) {
      if (n.type !== SECRETS_STORE_NODE_TYPE) {
        continue
      }
      for (const key of n.data?.secretKeys ?? []) {
        keys.add(key)
      }
    }
    return [...keys].sort()
  }, [nodes])
}
