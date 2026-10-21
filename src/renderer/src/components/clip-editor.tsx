import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  ClipboardPlus,
  CornerDownLeft,
  FileText,
  LoaderCircle,
  Trash2,
} from 'lucide-react'
import { DraftEditing } from '@/lib/draft-editing'
import type { Board, Draft } from '../../../shared/library'
import { MAX_CLIP_LENGTH } from '../../../shared/library'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Props {
  initial: Draft
  boards: Board[]
  editing: boolean
  onChange: (draft: Draft) => void
  onSave: (draft: Draft) => Promise<void>
  onDiscard: () => Promise<void>
  onBack: () => void
  value?: Draft
  busy?: boolean
  error?: string | null
  onRetry?: () => void
  onAppendClipboard?: () => Promise<void>
}

export function ClipEditor({
  initial,
  boards,
  editing,
  onChange,
  onSave,
  onDiscard,
  onBack,
  value,
  busy = false,
  error,
  onRetry,
  onAppendClipboard,
}: Props) {
  const [local, setLocal] = useState(initial)
  const { text, boardId } = value ?? local
  function change(draft: Draft) {
    if (!value) setLocal(draft)
    onChange(draft)
  }
  const [saving, setSaving] = useState(false)
  const [appending, setAppending] = useState(false)
  const locked = busy || saving || appending
  const textarea = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textarea.current?.focus()
    textarea.current?.setSelectionRange(initial.text.length, initial.text.length)
  }, [])

  const actualBoard = boards.some((board) => board.id === boardId) ? boardId : 'inbox'

  async function save() {
    if (locked || !text.trim()) return
    setSaving(true)
    try {
      await onSave({ text, boardId: actualBoard })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={editing ? 'Edit clip' : 'Capture clip'}
    >
      <div className="flex items-center gap-3 border-b px-6 py-5">
        <Button size="icon-sm" variant="ghost" aria-label="Back to library" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <div>
          <h1 className="text-[17px] font-semibold tracking-tight">
            {editing ? 'Edit clip' : 'A little worth keeping'}
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {editing
              ? 'Make it useful for next time.'
              : 'Write or append clipboard text, then save as one clip.'}
          </p>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {onAppendClipboard ? (
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={locked}
              onClick={async () => {
                setAppending(true)
                try {
                  await onAppendClipboard()
                } finally {
                  setAppending(false)
                }
              }}
            >
              {appending ? <LoaderCircle className="animate-spin" /> : <ClipboardPlus />}
              Append clipboard
            </Button>
          ) : (
            <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <FileText className="size-3.5" /> Plain text
            </span>
          )}
          <Select
            disabled={locked}
            value={actualBoard}
            onValueChange={(value) => {
              change({ text, boardId: value })
            }}
          >
            <SelectTrigger className="h-8 w-auto min-w-28 text-xs" aria-label="Save to board">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {boards.map((board) => (
                <SelectItem key={board.id} value={board.id}>
                  {board.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Textarea
          ref={textarea}
          aria-label="Clip text"
          placeholder="Drop something useful here…"
          disabled={locked}
          value={text}
          maxLength={MAX_CLIP_LENGTH}
          className="min-h-56 flex-1 resize-none rounded-xl border-border/80 bg-card p-4 font-mono text-[13px] leading-7 shadow-none focus-visible:ring-2"
          onChange={(event) => {
            change({ text: event.target.value, boardId: actualBoard })
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void save()
            }
          }}
        />
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>
            {editing
              ? 'Changes are saved when you say so.'
              : 'Your draft stays here until you save or discard it.'}
          </span>
          <span className="shrink-0 pl-3 tabular-nums">
            {text.length.toLocaleString()} characters
          </span>
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 px-6 pb-4 text-xs text-destructive"
        >
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
      <footer className="flex items-center justify-between border-t bg-card/50 px-6 py-4">
        <Button variant="ghost" size="sm" onClick={() => void onDiscard()} disabled={locked}>
          {editing ? <ArrowLeft /> : <Trash2 />} {editing ? 'Cancel' : 'Discard draft'}
        </Button>
        <Button
          aria-label={editing ? 'Save changes' : 'Save clip'}
          onClick={() => void save()}
          disabled={!text.trim() || locked}
        >
          {saving ? <LoaderCircle className="animate-spin" /> : <ArrowUpRight />}
          {editing ? 'Save changes' : 'Save clip'}
          <span aria-hidden="true" className="ml-2 flex items-center text-[10px] opacity-60">
            ⌘<CornerDownLeft className="size-3" />
          </span>
        </Button>
      </footer>
    </section>
  )
}

export function DraftEditor({
  editing,
  boards,
  onBack,
  onSaved,
  onDiscarded,
  onAppendClipboard,
}: {
  editing: DraftEditing
  boards: Board[]
  onBack: () => void
  onSaved: (draft: Draft) => void
  onDiscarded: () => void
  onAppendClipboard: () => Promise<void>
}) {
  const state = useSyncExternalStore(editing.subscribe, editing.getState)
  if (!state.draft) return null
  return (
    <ClipEditor
      initial={state.draft}
      value={state.draft}
      boards={boards}
      editing={false}
      busy={state.busy}
      error={state.error}
      onRetry={() => editing.retry()}
      onAppendClipboard={onAppendClipboard}
      onChange={(draft) => editing.change(draft)}
      onSave={async () => {
        const saved = await editing.save()
        if (saved && !editing.getState().draft) onSaved(saved)
      }}
      onDiscard={async () => {
        if ((await editing.discard()) && !editing.getState().draft) onDiscarded()
      }}
      onBack={onBack}
    />
  )
}
