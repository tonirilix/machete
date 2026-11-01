import type { MouseEvent } from 'react'
import {
  Check,
  Code2,
  Copy,
  FileText,
  Folder,
  Link2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { Board, Clip } from '../../../shared/library'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface Props {
  clip: Clip
  boards: Board[]
  selected: boolean
  onSelect: (event?: MouseEvent) => void
  onToggle: () => void
  onCopy: () => void
  onEdit: () => void
  onTrash: () => void
  onRestore: () => void
  onMove: (boardId: string) => void
}

function describe(text: string) {
  try {
    const url = new URL(text.trim())
    if (['https:', 'http:'].includes(url.protocol) && !text.trim().includes('\n')) {
      return { label: url.hostname.replace(/^www\./, ''), Icon: Link2, code: false }
    }
  } catch {
    /* A clip can be any text. */
  }
  if (
    /^(?:\s*[$>]\s|(?:npm|pnpm|yarn|bun|git|docker|curl|ssh|python|npx)\s)/.test(
      text.trimStart(),
    ) ||
    /[{};]\s*\n/.test(text)
  ) {
    return { label: 'Code', Icon: Code2, code: true }
  }
  return { label: 'Text', Icon: FileText, code: false }
}

function savedDate(timestamp: number) {
  const day = new Date(timestamp)
  if (day.toDateString() === new Date().toDateString()) return 'Today'
  return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function ClipCard({
  clip,
  boards,
  selected,
  onSelect,
  onToggle,
  onCopy,
  onEdit,
  onTrash,
  onRestore,
  onMove,
}: Props) {
  const preview = clip.text.slice(0, 2000)
  const { label, Icon, code } = describe(preview)
  const board = boards.find((board) => board.id === clip.boardId)
  const trashed = clip.deletedAt !== null
  return (
    <article
      data-clip-id={clip.id}
      className={cn(
        'clip-card group relative rounded-xl border bg-card transition-colors',
        selected
          ? 'border-primary/40 bg-primary/[0.035] ring-1 ring-primary/10'
          : 'border-border/80 hover:border-primary/25',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Select clip: ${clip.text.slice(0, 60)}`}
          className={cn(
            'size-3.5 transition-opacity',
            !selected && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
        />
      </div>
      <button
        className="block w-full px-4 pb-3 pt-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onSelect}
        onDoubleClick={trashed ? onRestore : onEdit}
        aria-label={`Select ${clip.text.slice(0, 80)}`}
      >
        <span
          className={cn(
            'line-clamp-4 block whitespace-pre-wrap break-words text-[13px] leading-[1.7]',
            code && 'font-mono text-[12px]',
          )}
        >
          {preview}
        </span>
      </button>
      <div className="flex h-10 items-center justify-between border-t border-border/40 px-4">
        <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <Folder className="size-3 shrink-0" />
          <span className="truncate">{board?.name ?? 'Inbox'}</span>
          <span className="px-0.5 opacity-40">·</span>
          <span className="shrink-0">{savedDate(clip.createdAt)}</span>
        </span>
        <div className="-mr-2 flex items-center gap-0.5">
          {trashed ? (
            <Button variant="ghost" size="icon-xs" aria-label="Restore clip" onClick={onRestore}>
              <Undo2 />
            </Button>
          ) : (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="Copy clip" onClick={onCopy}>
                    <Copy className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Copy clip</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label="Clip options">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={onEdit}>
                    <Pencil />
                    Edit clip
                  </DropdownMenuItem>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <Folder className="mr-2 size-4" />
                      Move to board
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuLabel>Choose a board</DropdownMenuLabel>
                      {boards.map((item) => (
                        <DropdownMenuItem key={item.id} onSelect={() => onMove(item.id)}>
                          {item.name}
                          {item.id === clip.boardId && <Check className="ml-auto" />}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onTrash}>
                    <Trash2 />
                    Move to Trash
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>
    </article>
  )
}
