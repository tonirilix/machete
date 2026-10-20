import {
  Archive,
  Circle,
  Folder,
  Inbox,
  Layers2,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings2,
  Trash2,
} from 'lucide-react'
import type { Board, Library } from '../../../shared/library'
import { INBOX_ID } from '../../../shared/library'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface Props {
  library: Library
  active: string
  capturing: boolean
  onNavigate: (id: string) => void
  onCapture: () => void
  onCreateBoard: () => void
  onRenameBoard: (board: Board) => void
  onDeleteBoard: (board: Board) => void
  onSettings: () => void
}

export function LibrarySidebar({
  library,
  active,
  capturing,
  onNavigate,
  onCapture,
  onCreateBoard,
  onRenameBoard,
  onDeleteBoard,
  onSettings,
}: Props) {
  const count = (id: string) =>
    library.clips.filter((clip) =>
      id === 'trash'
        ? clip.deletedAt !== null
        : clip.deletedAt === null && (id === 'all' || clip.boardId === id),
    ).length
  const nav = (id: string, name: string, Icon: typeof Inbox) => (
    <button
      aria-label={name}
      aria-current={active === id && !capturing ? 'page' : undefined}
      className={cn('sidebar-link', active === id && !capturing && 'active')}
      onClick={() => onNavigate(id)}
    >
      <Icon className="size-4" />
      <span className="flex-1 text-left">{name}</span>
      <span className="nav-count">{count(id)}</span>
    </button>
  )
  return (
    <aside className="sidebar flex w-44 shrink-0 flex-col border-r p-3">
      <Button className="mb-6 mt-2 w-full justify-start shadow-sm" onClick={onCapture}>
        <Plus /> {library.draft ? 'Resume draft' : 'New clip'}
      </Button>
      <nav aria-label="Library navigation" className="space-y-1">
        {nav('all', 'All clips', Layers2)}
        {nav(INBOX_ID, 'Inbox', Inbox)}
      </nav>
      <div className="mb-2 mt-7 flex items-center justify-between pl-2">
        <span className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground">
          YOUR BOARDS
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Create board"
              onClick={onCreateBoard}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add a board</TooltipContent>
        </Tooltip>
      </div>
      <nav aria-label="Boards" className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {library.boards
          .filter((board) => board.id !== INBOX_ID)
          .map((board) => (
            <div
              key={board.id}
              className={cn(
                'group flex items-center rounded-lg',
                active === board.id && !capturing && 'bg-sidebar-accent',
              )}
            >
              <button
                className={cn(
                  'sidebar-link min-w-0 flex-1',
                  active === board.id && !capturing && 'active',
                )}
                onClick={() => onNavigate(board.id)}
              >
                <Folder className="size-4 shrink-0" />
                <span className="truncate text-left">{board.name}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="mr-1 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
                    aria-label={`Options for ${board.name}`}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => onRenameBoard(board)}>
                    <Pencil />
                    Rename board
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => onDeleteBoard(board)}>
                    <Trash2 />
                    Delete board
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        {library.boards.length === 1 && (
          <button
            onClick={onCreateBoard}
            className="mt-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-left text-xs leading-5 text-muted-foreground hover:bg-accent"
          >
            <Archive className="size-4 shrink-0" />A home for every
            <br />
            little thing.
          </button>
        )}
      </nav>
      <div className="mt-4 space-y-1 border-t pt-3">
        {nav('trash', 'Trash', Trash2)}
        <button className="sidebar-link" onClick={onSettings}>
          <Settings2 className="size-4" />
          Settings
        </button>
        <div className="mt-3 flex items-center gap-1.5 px-2 text-[10px] text-muted-foreground">
          <Circle className="size-1.5 fill-primary text-primary" /> Saved on this Mac
        </div>
      </div>
    </aside>
  )
}
