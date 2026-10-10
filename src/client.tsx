import type { ExtensionHandle, ResolvedContext } from '@opencroft/client/canvas'
import { defineExtension } from '@opencroft/client/extension'

import { buildDockerExecContext } from '../dockerExecContext'
import {
  ApplicationInspector,
  ApplicationNode,
  ApplicationTerminalTab,
  ApplicationVolumesTab,
  applicationContextMenuItems,
} from './nodes/application'
import { ApplicationDeployTab, ApplicationLogsTab } from './nodes/application-output'
import { type DockerData, DockerInspector, DockerInventoryTab, DockerNode, DockerVolumesTab } from './nodes/docker'
import { type VolumeData, VolumeInspector, VolumeNode } from './nodes/volume'

const DOCKER_HANDLES: ExtensionHandle[] = [
  { id: 'ctx-in', handleType: 'builtin.core.terminal-context', role: 'target', label: 'Host' },
  { id: 'context-in', handleType: 'builtin.core.terminal-context', role: 'target', label: 'Context' },
  { id: 'docker-out', handleType: 'docker-context', role: 'source', label: 'Docker' },
]

const APP_HANDLES: ExtensionHandle[] = [
  { id: 'docker-in', handleType: 'docker-context', role: 'target', label: 'Docker' },
  { id: 'volumes-in', handleType: 'volume-mount', role: 'target', label: 'Volumes' },
  {
    id: 'instance-terminal-',
    handleType: 'builtin.core.terminal-context',
    role: 'source',
    label: 'Terminal',
    dynamic: true,
  },
]

const VOLUME_HANDLES: ExtensionHandle[] = [
  { id: 'vol-out', handleType: 'volume-mount', role: 'source', label: 'Volume' },
]

/** The node's wired inputs, keyed by target handle id, as the host passes them to `exposeOutput`. */
type Contexts = Record<string, ResolvedContext>

export default defineExtension({
  manifest: {},
  handleTypes: [
    { id: 'docker-context', label: 'Docker Context', color: 'oklch(0.75 0.14 240)' },
    { id: 'volume-mount', label: 'Volume Mount', color: 'oklch(0.7 0.15 50)' },
  ],
  nodes: [
    {
      type: 'docker',
      name: 'Docker',
      category: 'Infrastructure',
      icon: 'Container',
      accent: 'oklch(0.75 0.14 240)',
      handles: DOCKER_HANDLES,
      defaultData: { contextName: '', registries: [] },
      component: DockerNode,
      inspector: DockerInspector,
      inspectorTabs: [
        { id: 'inventory', label: 'Containers', icon: 'Container', component: DockerInventoryTab },
        { id: 'volumes', label: 'Volumes', icon: 'HardDrive', component: DockerVolumesTab },
      ],
      exposeOutput: (handleId: string, data: unknown, _type: string, _nodeId: string, contexts?: Contexts) => {
        if (handleId !== 'docker-out') {
          return undefined
        }
        // `contexts` is absent on a host older than this argument.
        const target = contexts?.['context-in']?.value as Record<string, unknown> | undefined
        const exec = (contexts?.['ctx-in']?.value as Record<string, unknown> | undefined) ?? { type: 'local' }
        const base = target ?? exec
        return { ...base, contextName: (data as DockerData).contextName }
      },
    },
    {
      type: 'application',
      name: 'Application',
      category: 'Applications',
      icon: 'AppWindow',
      accent: 'var(--primary)',
      handles: APP_HANDLES,
      defaultData: {
        name: '',
        image: '',
        ports: '',
        env: '',
        command: '',
        restart: '',
        replicas: 1,
        containerName: '',
        workingDir: '',
        terminalUser: '',
        terminalShell: '',
        buildContext: '',
        buildDockerfile: '',
        gpu: false,
        requirementMemory: '',
        requirementCpu: '',
        init: false,
        readOnly: false,
        dependsOn: '',
        groupAdd: '',
        securityOpts: '',
        tmpfs: '',
        healthcheckTest: '',
        healthcheckInterval: '',
        healthcheckTimeout: '',
        healthcheckRetries: 0,
        healthcheckStartPeriod: '',
        proxyDomain: '',
        proxyEntrypoint: '',
        proxyTls: false,
        proxyBasicAuth: '',
        proxyPort: 0,
        exposeHostDocker: false,
        copyDockerBinaries: false,
        secrets: '',
        namedVolumes: '',
      },
      component: ApplicationNode,
      inspector: ApplicationInspector,
      inspectorTabs: [
        { id: 'deploy', label: 'Deploy', icon: 'Rocket', fullHeight: true, component: ApplicationDeployTab },
        { id: 'logs', label: 'Logs', icon: 'ScrollText', fullHeight: true, component: ApplicationLogsTab },
        // Kept mounted, so picking another tab leaves the shell running and closing the inspector ends it.
        {
          id: 'terminal',
          label: 'Terminal',
          icon: 'TerminalSquare',
          fullHeight: true,
          keepMounted: true,
          component: ApplicationTerminalTab,
        },
        { id: 'volumes', label: 'Volumes', icon: 'HardDrive', component: ApplicationVolumesTab },
      ],
      contextMenuItems: applicationContextMenuItems,
      exposeOutput: (handleId: string, data: unknown, _type: string, _nodeId: string, contexts?: Contexts) => {
        if (!handleId.startsWith('instance-terminal-')) {
          return undefined
        }
        const containerId = handleId.slice('instance-terminal-'.length)
        const d = data as { workingDir?: unknown; terminalUser?: unknown; terminalShell?: unknown }
        const docker = contexts?.['docker-in']?.value
        if (!docker) {
          return undefined
        }
        const { contextName, ...via } = docker as { contextName?: string } & Record<string, unknown>
        // NOTE: this exposeOutput logic shares buildDockerExecContext (../dockerExecContext) with
        // the server-side implementation in extension.ts (its exposeOutput for the 'application'
        // type, for this same handle) — keep both call sites passing the same arguments.
        return buildDockerExecContext(via, contextName, containerId, d)
      },
    },
    {
      type: 'volume',
      name: 'Volume',
      category: 'Applications',
      icon: 'HardDrive',
      accent: 'oklch(0.7 0.15 50)',
      handles: VOLUME_HANDLES,
      defaultData: { name: '', hostPath: '', containerPath: '', readOnly: false },
      component: VolumeNode,
      inspector: VolumeInspector,
      exposeOutput: (handleId: string, data: unknown) => {
        if (handleId !== 'vol-out') {
          return undefined
        }
        const d = data as VolumeData
        if (!d.hostPath || !d.containerPath) {
          return undefined
        }
        return { hostPath: d.hostPath, containerPath: d.containerPath, readOnly: d.readOnly }
      },
    },
  ],
})
