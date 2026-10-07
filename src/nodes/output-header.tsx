import { Button, StatusIndicator } from '@ext/ui'

// The line above every Application tab's terminal (Deploy, Logs and Terminal): what is shown, in
// one line, and at most one thing to do about it.

export type Indicator = 'success' | 'warning' | 'destructive' | 'secondary'

export interface HeaderAction {
  label: string
  onClick: () => void
}

export interface HeaderState {
  indicator: Indicator
  title: string
  detail?: string
  action?: HeaderAction
}

export function OutputHeader({ indicator, title, detail, action }: HeaderState) {
  return (
    <div className='flex items-center gap-2 px-2 py-1 border-b text-[10px] text-muted-foreground shrink-0'>
      <StatusIndicator variant={indicator} />
      <span className='font-medium text-foreground shrink-0'>{title}</span>
      <span className='truncate flex-1 min-w-0' title={detail}>
        {detail}
      </span>
      {action ? (
        <Button variant='ghost' size='sm' className='h-5 text-[10px] px-1.5 shrink-0' onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </div>
  )
}
