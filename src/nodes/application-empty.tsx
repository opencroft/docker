import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@opencroft/client/ui'
import { Container, LoaderCircle, Rocket, Unplug } from 'lucide-react'

import { type AppData, deployBlocker, useDockerNodeId, useNodeActionRunner } from './application'

/** Why an Application's Deploy, Logs or Terminal tab has nothing to show. */
export type ApplicationEmptyReason = 'no-docker' | 'not-deployed' | 'no-container' | 'checking'

/** What the tab would show once there is something: it finishes each description. */
export type ApplicationTabSubject = 'output' | 'logs' | 'shell'

const SUBJECT_TEXT: Record<ApplicationTabSubject, string> = {
  output: 'its output',
  logs: 'its logs',
  shell: 'a shell in it',
}

function DeployButton({ nodeId }: { nodeId: string }) {
  const { busy, runAction } = useNodeActionRunner(nodeId)
  return (
    <Button size='sm' onClick={() => runAction('deploy', 'Deploy')} disabled={busy}>
      <Rocket className='size-3.5' />
      {busy ? 'Deploying…' : 'Deploy'}
    </Button>
  )
}

/**
 * The one empty state of the Deploy, Logs and Terminal tabs: an icon, a title, one line on what
 * to do, the container it is about as a second line, and Deploy where deploying is the answer.
 * With no Docker node wired, that is what every tab says, whatever else is also missing.
 */
export function ApplicationEmpty({
  nodeId,
  data,
  reason,
  subject,
  container,
}: {
  nodeId: string
  data: AppData
  reason: ApplicationEmptyReason
  subject: ApplicationTabSubject
  container?: string
}) {
  const what = SUBJECT_TEXT[subject]
  const blocker = deployBlocker(data, Boolean(useDockerNodeId(nodeId)))
  const shown = blocker === 'no-docker' && reason !== 'checking' ? 'no-docker' : reason
  const deployHint =
    blocker === 'no-source'
      ? `Set an image or a build context, then deploy to see ${what} here.`
      : `Deploy the application to see ${what} here.`
  const content = {
    'no-docker': {
      Icon: Unplug,
      title: 'No Docker node',
      description: `Connect a Docker node to the Docker input to see ${what} here.`,
    },
    'not-deployed': { Icon: Rocket, title: 'Not deployed', description: deployHint },
    'no-container': { Icon: Container, title: 'No container', description: deployHint },
    checking: { Icon: LoaderCircle, title: 'Checking…', description: undefined },
  }[shown]
  const offerDeploy = blocker === null && (shown === 'not-deployed' || shown === 'no-container')
  return (
    <Empty className='h-full p-6'>
      <EmptyHeader>
        <EmptyMedia variant='icon'>
          <content.Icon className={shown === 'checking' ? 'animate-spin' : undefined} />
        </EmptyMedia>
        <EmptyTitle>{content.title}</EmptyTitle>
        {content.description ? <EmptyDescription>{content.description}</EmptyDescription> : null}
        {container && shown !== 'no-docker' ? (
          <EmptyDescription className='max-w-full truncate font-mono text-xs'>{container}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {offerDeploy ? (
        <EmptyContent>
          <DeployButton nodeId={nodeId} />
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
