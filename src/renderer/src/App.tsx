import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Check,
  ClipboardPlus,
  Copy,
  Inbox,
  Layers2,
  LoaderCircle,
  Plus,
  Search,
  SearchX,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { Snapshot } from '../../shared/bridge'
import {
  INBOX_ID,
  selectedText,
  visibleClips,
  type Board,
  type Command,
  type Draft,
} from '../../shared/library'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ClipCard } from '@/components/clip-card'
import { ClipEditor } from '@/components/clip-editor'
import { LibrarySidebar } from '@/components/library-sidebar'
import { SettingsDialog } from '@/components/settings-dialog'
import { bridge, errorMessage, isDesktop, shortcutLabel } from '@/lib/bridge'
import { cn } from '@/lib/utils'

type Mode = { type: 'browse' } | { type: 'capture' } | { type: 'edit'; clipId: string }
type Confirmation = {
  title: string
  description: string
  label: string
  action: () => Promise<boolean>
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>({ type: 'browse' })
  const [captureRevision, setCaptureRevision] = useState(0)
  const [active, setActive] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [anchor, setAnchor] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [boardPrompt, setBoardPrompt] = useState<{ board?: Board; name: string } | null>(null)
  const [boardBusy, setBoardBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const search = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setSnapshot(await bridge.getState())
      setLoadError(null)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    void load()
    return bridge.onOpen((request) => {
      setSnapshot(request.snapshot)
      setMode({ type: request.mode === 'capture' ? 'capture' : 'browse' })
      if (request.mode === 'capture') setCaptureRevision((revision) => revision + 1)
      setSettings(request.mode === 'settings')
      if (request.notice) toast.error(request.notice, { id: 'capture-notice' })
      setSelected([])
    })
  }, [load])

  const run = useCallback(async (command: Command) => {
    try {
      const result = await bridge.execute(command)
      setSnapshot(result)
      return result
    } catch (error) {
      toast.error(errorMessage(error), { id: 'operation-error' })
      return null
    }
  }, [])

  const library = snapshot?.library
  const clips = useMemo(
    () => (library ? visibleClips(library, active, query) : []),
    [library, active, query],
  )
  const selectedVisible = selected.filter((id) => clips.some((clip) => clip.id === id))

  function navigate(id: string) {
    setActive(id)
    setMode({ type: 'browse' })
    setSelected([])
    setAnchor(null)
    setQuery('')
  }

  async function capture(fromClipboard = false) {
    try {
      setSnapshot(await bridge.capture(fromClipboard))
      setCaptureRevision((revision) => revision + 1)
      setMode({ type: 'capture' })
      setSelected([])
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  async function copy(ids = selectedVisible) {
    const text = selectedText(clips, ids)
    if (!text) return
    try {
      await bridge.copy(text)
      toast.success(ids.length === 1 ? 'Copied. Take it anywhere.' : `${ids.length} clips copied`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  async function trash(ids: string[]) {
    if (!ids.length) return
    if (await run({ type: 'trash-clips', ids })) {
      setSelected([])
      toast.success(ids.length === 1 ? 'Moved to Trash' : `${ids.length} clips moved to Trash`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void run({ type: 'restore-clips', ids })
          },
        },
      })
    }
  }

  function select(id: string, event?: MouseEvent) {
    if (event?.shiftKey && anchor) {
      const start = clips.findIndex((clip) => clip.id === anchor)
      const end = clips.findIndex((clip) => clip.id === id)
      if (start >= 0 && end >= 0) {
        const range = clips
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .map((clip) => clip.id)
        setSelected(event.metaKey || event.ctrlKey ? [...new Set([...selected, ...range])] : range)
        return
      }
    }
    if (!event || event.metaKey || event.ctrlKey) {
      setSelected((current) =>
        current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
      )
    } else {
      setSelected([id])
    }
    setAnchor(id)
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.matches('input, textarea') || target.isContentEditable)
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void capture()
        return
      }
      if (mod && event.key.toLowerCase() === 'k' && mode.type === 'browse') {
        event.preventDefault()
        search.current?.focus()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (mode.type !== 'browse') setMode({ type: 'browse' })
        else if (selected.length) setSelected([])
        else if (query) setQuery('')
        else void bridge.hide()
        return
      }
      if (typing || mode.type !== 'browse') return
      if (mod && event.key.toLowerCase() === 'c' && selectedVisible.length) {
        if (window.getSelection()?.toString()) return
        event.preventDefault()
        void copy()
        return
      }
      if (mod && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        setSelected(clips.map((clip) => clip.id))
        return
      }
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && clips.length) {
        event.preventDefault()
        const current = clips.findIndex((clip) => clip.id === anchor)
        const index =
          event.key === 'ArrowDown'
            ? Math.min(current + 1, clips.length - 1)
            : Math.max(current - 1, 0)
        setSelected([clips[index].id])
        setAnchor(clips[index].id)
        document
          .querySelector(`[data-clip-id="${CSS.escape(clips[index].id)}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }
      if (
        ['Backspace', 'Delete'].includes(event.key) &&
        selectedVisible.length &&
        active !== 'trash'
      ) {
        event.preventDefault()
        void trash(selectedVisible)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  async function saveClip(draft: Draft) {
    const result = await run(
      mode.type === 'edit'
        ? { type: 'edit-clip', id: mode.clipId, ...draft }
        : { type: 'save-draft', ...draft },
    )
    if (result) {
      navigate(draft.boardId)
      toast.success(mode.type === 'edit' ? 'Clip updated' : 'A good little thing, saved.')
    }
  }

  function deleteBoard(board: Board) {
    setConfirmation({
      title: `Delete “${board.name}”?`,
      description: 'Its clips will move to Inbox. Anything in Trash will stay in Trash.',
      label: 'Delete board',
      action: async () => {
        const result = await run({ type: 'delete-board', id: board.id })
        if (result && active === board.id) navigate(INBOX_ID)
        return Boolean(result)
      },
    })
  }

  if (!snapshot)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <Layers2 className="size-8 text-primary" />
        {loadError ? (
          <>
            <p className="max-w-sm text-sm text-muted-foreground">{loadError}</p>
            <Button variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </>
        ) : (
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        )}
      </div>
    )

  const state = snapshot.library
  const currentBoard = state.boards.find((board) => board.id === active)
  const title =
    active === 'all' ? 'All clips' : active === 'trash' ? 'Trash' : (currentBoard?.name ?? 'Inbox')
  const editingClip =
    mode.type === 'edit' ? state.clips.find((clip) => clip.id === mode.clipId) : null
  const editor =
    mode.type === 'capture'
      ? state.draft
      : editingClip
        ? { text: editingClip.text, boardId: editingClip.boardId }
        : null
  const isTrashed = active === 'trash'

  return (
    <div className="app-shell flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header
        className={cn(
          'titlebar flex h-[54px] shrink-0 items-center justify-between border-b pr-5',
          isDesktop ? 'pl-[90px]' : 'pl-5',
        )}
      >
        <div className="flex items-center gap-2.5">
          <span className="brand-mark">
            <Layers2 className="size-4" />
          </span>
          <span className="text-[13px] font-semibold tracking-[-0.03em]">
            cliptoboards<span className="text-primary">.</span>
          </span>
        </div>
        <button
          className="no-drag flex items-center gap-2 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:bg-accent"
          onClick={() => setSettings(true)}
          aria-label="Open shortcut settings"
        >
          <span className="hidden sm:inline">Always within reach</span>
          <kbd>{shortcutLabel(state.settings.shortcut)}</kbd>
        </button>
      </header>
      {snapshot.shortcutError && (
        <button
          onClick={() => setSettings(true)}
          className="flex items-center gap-2 border-b bg-amber-50 px-4 py-2 text-left text-xs text-amber-900"
        >
          <AlertCircle className="size-4 shrink-0" />
          {snapshot.shortcutError}
          <ArrowRight className="ml-auto size-4 shrink-0" />
        </button>
      )}
      <div className="flex min-h-0 flex-1">
        <LibrarySidebar
          library={state}
          active={active}
          capturing={mode.type !== 'browse'}
          onNavigate={navigate}
          onCapture={() => void capture()}
          onCreateBoard={() => setBoardPrompt({ name: '' })}
          onRenameBoard={(board) => setBoardPrompt({ board, name: board.name })}
          onDeleteBoard={deleteBoard}
          onSettings={() => setSettings(true)}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {editor && mode.type !== 'browse' ? (
            <ClipEditor
              key={mode.type === 'edit' ? mode.clipId : `capture:${captureRevision}`}
              initial={editor}
              boards={state.boards}
              editing={mode.type === 'edit'}
              onChange={(draft) => {
                if (mode.type === 'capture') void run({ type: 'update-draft', ...draft })
              }}
              onSave={saveClip}
              onBack={() => setMode({ type: 'browse' })}
              onDiscard={async () => {
                if (mode.type === 'edit' || (await run({ type: 'discard-draft' })))
                  setMode({ type: 'browse' })
              }}
            />
          ) : (
            <>
              <div className="shrink-0 px-6 pb-4 pt-6">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div>
                    <h1 className="text-xl font-semibold tracking-[-0.04em]">{title}</h1>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isTrashed
                        ? 'A second chance for the things you let go.'
                        : 'The good bits, all in one place.'}
                    </p>
                  </div>
                  {isTrashed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!state.clips.some((clip) => clip.deletedAt !== null)}
                      onClick={() =>
                        setConfirmation({
                          title: 'Empty Trash?',
                          description:
                            'These clips will be permanently removed. This can’t be undone.',
                          label: 'Empty Trash',
                          action: async () => Boolean(await run({ type: 'empty-trash' })),
                        })
                      }
                    >
                      <Trash2 />
                      Empty Trash
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => void capture(true)}>
                      <ClipboardPlus />
                      <span className="hidden min-[650px]:inline">Capture clipboard</span>
                      <span className="min-[650px]:hidden">Capture</span>
                    </Button>
                  )}
                </div>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={search}
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value)
                      setSelected([])
                      setAnchor(null)
                    }}
                    placeholder={active === 'all' ? 'Find something useful…' : `Search ${title}…`}
                    aria-label="Search clips"
                    className="h-10 rounded-lg border-border/80 bg-card pl-9 pr-12 text-xs shadow-none"
                  />
                  {query ? (
                    <Button
                      className="absolute right-1 top-1"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Clear search"
                      onClick={() => setQuery('')}
                    >
                      <X className="size-3.5" />
                    </Button>
                  ) : (
                    <kbd className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                      ⌘ K
                    </kbd>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between px-6 pb-3 text-[10px] font-medium text-muted-foreground">
                <span>
                  {clips.length} {clips.length === 1 ? 'CLIP' : 'CLIPS'}
                  {query && ' FOUND'}
                </span>
                <span>Newest first</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6" aria-label="Saved clips">
                {clips.length ? (
                  <div className="space-y-3">
                    {clips.map((clip) => (
                      <ClipCard
                        key={clip.id}
                        clip={clip}
                        boards={state.boards}
                        selected={selectedVisible.includes(clip.id)}
                        onSelect={(event) => select(clip.id, event)}
                        onToggle={() => select(clip.id)}
                        onCopy={() => void copy([clip.id])}
                        onEdit={() => setMode({ type: 'edit', clipId: clip.id })}
                        onTrash={() => void trash([clip.id])}
                        onRestore={() => {
                          void run({ type: 'restore-clips', ids: [clip.id] })
                          setSelected([])
                        }}
                        onMove={(boardId) => {
                          void run({ type: 'move-clips', ids: [clip.id], boardId })
                          setSelected([])
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full min-h-64 flex-col items-center justify-center pb-10 text-center">
                    <div className="empty-illustration mb-7">
                      <div />
                      <div />
                      {query ? <SearchX /> : isTrashed ? <Trash2 /> : <Inbox />}
                    </div>
                    <h2 className="text-base font-medium tracking-tight">
                      {query
                        ? 'Nothing here just yet.'
                        : isTrashed
                          ? 'Nothing left behind.'
                          : 'Keep the good bits.'}
                    </h2>
                    <p className="mt-2 max-w-60 text-xs leading-6 text-muted-foreground">
                      {query
                        ? 'Try a different word or look in another board.'
                        : isTrashed
                          ? 'Deleted clips will wait here until you’re sure.'
                          : 'A useful command. A link for later. A thought you don’t want to lose.'}
                    </p>
                    {!query && !isTrashed && (
                      <Button
                        variant="outline"
                        className="mt-6"
                        size="sm"
                        onClick={() => void capture()}
                      >
                        <Plus />
                        Save your first clip
                        <ArrowRight className="ml-1 size-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <footer className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-t bg-card/50 px-6 py-2">
                {selectedVisible.length ? (
                  <>
                    <button
                      onClick={() => setSelected([])}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <Check className="size-3.5 text-primary" />
                      {selectedVisible.length} selected
                      <X className="size-3" />
                    </button>
                    <div className="flex gap-1">
                      {isTrashed ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            void run({ type: 'restore-clips', ids: selectedVisible })
                            setSelected([])
                          }}
                        >
                          <Undo2 />
                          Restore
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Move selected clips to Trash"
                            onClick={() => void trash(selectedVisible)}
                          >
                            <Trash2 />
                          </Button>
                          <Button size="sm" onClick={() => void copy()}>
                            <Copy />
                            Copy
                            {selectedVisible.length > 1 ? ` ${selectedVisible.length} clips` : ''}
                          </Button>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-[10px] text-muted-foreground">
                      A little less scattered.
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      <kbd>⌘ N</kbd>
                      <span className="ml-1.5">New clip</span>
                    </span>
                  </>
                )}
              </footer>
            </>
          )}
        </main>
      </div>

      {settings && (
        <SettingsDialog
          shortcut={state.settings.shortcut}
          onClose={() => setSettings(false)}
          onShortcut={async (shortcut) => Boolean(await run({ type: 'set-shortcut', shortcut }))}
          onImported={async () => {
            await load()
            navigate('all')
          }}
        />
      )}

      <Dialog
        open={Boolean(boardPrompt)}
        onOpenChange={(open) => {
          if (!open && !boardBusy) setBoardPrompt(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {boardPrompt?.board ? 'Rename board' : 'A place for your clips'}
            </DialogTitle>
            <DialogDescription>
              {boardPrompt?.board
                ? 'Give this collection a new name.'
                : 'Group a few useful things under a familiar name.'}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!boardPrompt || boardBusy) return
              setBoardBusy(true)
              void run(
                boardPrompt.board
                  ? { type: 'rename-board', id: boardPrompt.board.id, name: boardPrompt.name }
                  : { type: 'create-board', name: boardPrompt.name },
              )
                .then((result) => {
                  if (result) {
                    if (!boardPrompt.board) navigate(result.library.boards.at(-1)!.id)
                    setBoardPrompt(null)
                  }
                })
                .finally(() => setBoardBusy(false))
            }}
          >
            <label htmlFor="board-name" className="mb-2 block text-xs font-medium">
              Board name
            </label>
            <Input
              id="board-name"
              autoFocus
              maxLength={60}
              placeholder="e.g. Everyday, Reading, Side project"
              value={boardPrompt?.name ?? ''}
              onChange={(event) =>
                setBoardPrompt((current) =>
                  current ? { ...current, name: event.target.value } : null,
                )
              }
            />
            <DialogFooter className="mt-5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setBoardPrompt(null)}
                disabled={boardBusy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={boardBusy || !boardPrompt?.name.trim()}>
                {boardPrompt?.board ? 'Save name' : 'Create board'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open && !confirmBusy) setConfirmation(null)
        }}
      >
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirmBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={confirmBusy}
              onClick={(event) => {
                event.preventDefault()
                if (!confirmation) return
                setConfirmBusy(true)
                void confirmation
                  .action()
                  .then((success) => {
                    if (success) setConfirmation(null)
                  })
                  .finally(() => setConfirmBusy(false))
              }}
            >
              {confirmation?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
