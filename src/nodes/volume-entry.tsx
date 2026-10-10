import { Button } from '@opencroft/client/ui'
import { HardDrive } from 'lucide-react'
import type { ComponentType } from 'react'

export interface VolumeEntryAction {
  icon: ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  disabled?: boolean
}

export interface VolumeEntryProps {
  name: string
  created: string
  action: VolumeEntryAction
  subtitle?: string
}

export function VolumeEntryRow({ name, created, action, subtitle }: VolumeEntryProps) {
  const Icon = action.icon
  return (
    <div className='flex flex-col gap-0.5 px-2 py-1.5 text-xs bg-muted/30'>
      <div className='flex items-center gap-1.5'>
        <HardDrive className='h-3 w-3 shrink-0 text-muted-foreground' />
        <span className='font-medium truncate flex-1'>{name}</span>
        <Button
          variant='ghost'
          size='sm'
          className='h-6 w-6 p-0'
          title={action.label}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          <Icon className='h-3 w-3' />
        </Button>
      </div>
      <div className='flex gap-3 text-[10px] text-muted-foreground pl-4'>
        <span>{created || '—'}</span>
        {subtitle ? <span className='truncate'>{subtitle}</span> : null}
      </div>
    </div>
  )
}
