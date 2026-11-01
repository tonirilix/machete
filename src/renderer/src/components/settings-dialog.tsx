import { useEffect, useState } from 'react'
import { Download, HardDrive, Keyboard, MousePointer2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DEFAULT_SHORTCUT, DOUBLE_SHIFT_SHORTCUT } from '../../../shared/library'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { bridge, errorMessage, isDesktop, shortcutLabel } from '@/lib/bridge'
import type { SelectionAccess } from '../../../shared/bridge'

interface Props {
  shortcut: string
  onClose: () => void
  onShortcut: (shortcut: string) => Promise<boolean>
  onImported: () => Promise<void>
  onAccessChanged: () => Promise<void>
}

export function SettingsDialog({
  shortcut,
  onClose,
  onShortcut,
  onImported,
  onAccessChanged,
}: Props) {
  const [pending, setPending] = useState(shortcut)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [access, setAccess] = useState<SelectionAccess | null>(null)

  useEffect(() => {
    let mounted = true
    let previous: SelectionAccess | null = null
    const refresh = () => {
      void bridge
        .selectionAccess()
        .then(async (value) => {
          if (!mounted) return
          setAccess(value)
          if (
            !previous ||
            previous.granted !== value.granted ||
            previous.supported !== value.supported
          ) {
            previous = value
            await onAccessChanged()
          }
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    const interval = window.setInterval(() => {
      if (!document.hidden && document.hasFocus()) refresh()
    }, 2000)
    return () => {
      mounted = false
      window.removeEventListener('focus', refresh)
      window.clearInterval(interval)
    }
  }, [onAccessChanged])

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[calc(100vh-3rem)] max-w-[420px] gap-6 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Make yourself at home</DialogTitle>
          <DialogDescription>A few things to keep Machete close by.</DialogDescription>
        </DialogHeader>
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Keyboard className="size-4 text-muted-foreground" />
            Capture shortcut
          </h2>
          {access?.supported && (
            <Select
              value={pending === DOUBLE_SHIFT_SHORTCUT ? 'double-shift' : 'combination'}
              onValueChange={(value) => {
                setRecording(false)
                setPending(
                  value === 'double-shift'
                    ? DOUBLE_SHIFT_SHORTCUT
                    : shortcut === DOUBLE_SHIFT_SHORTCUT
                      ? DEFAULT_SHORTCUT
                      : shortcut,
                )
              }}
            >
              <SelectTrigger aria-label="Capture trigger" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="double-shift">Double Shift</SelectItem>
                <SelectItem value="combination">Key combination</SelectItem>
              </SelectContent>
            </Select>
          )}
          {pending === DOUBLE_SHIFT_SHORTCUT ? (
            <p className="text-xs leading-5 text-muted-foreground">
              Tap the same Shift key twice quickly, releasing it each time. Typing, other modifiers,
              or a click between taps cancels capture.
            </p>
          ) : (
            <>
              <button
                className="flex h-11 w-full items-center justify-between rounded-lg border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Record capture shortcut"
                onClick={() => setRecording(true)}
                onKeyDown={(event) => {
                  if (!recording) return
                  event.preventDefault()
                  event.stopPropagation()
                  if (event.key === 'Escape') return setRecording(false)
                  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return
                  if (!event.metaKey && !event.ctrlKey && !event.altKey) return
                  const key =
                    event.code === 'Space'
                      ? 'Space'
                      : event.key.length === 1
                        ? event.key.toUpperCase()
                        : event.key
                  const modifiers = [
                    event.metaKey && 'CommandOrControl',
                    event.ctrlKey && !event.metaKey && 'Control',
                    event.altKey && 'Alt',
                    event.shiftKey && 'Shift',
                  ].filter(Boolean)
                  setPending([...modifiers, key].join('+'))
                  setRecording(false)
                }}
              >
                <span className="text-muted-foreground">
                  {recording
                    ? 'Press your key combination…'
                    : access?.supported === false
                      ? 'Capture clipboard'
                      : 'Capture selected text'}
                </span>
                <kbd>{recording ? '…' : shortcutLabel(pending)}</kbd>
              </button>
              <p className="text-xs leading-5 text-muted-foreground">
                {isDesktop
                  ? 'Click above to record a different shortcut.'
                  : 'Global shortcuts are available in the desktop app.'}
              </p>
            </>
          )}
          {pending !== shortcut && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (await onShortcut(pending)) toast.success('Shortcut updated')
                })
              }
            >
              Save shortcut
            </Button>
          )}
        </section>
        {access?.supported && (
          <section className="space-y-3 border-t pt-5">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <MousePointer2 className="size-4 text-muted-foreground" />
              Capture selected text
            </h2>
            <p className="text-xs leading-5 text-muted-foreground">
              {access.granted
                ? 'Enabled. Select text in another app and press your capture shortcut. Each selection is saved as a new clip in Inbox.'
                : 'Allow Machete in System Settings → Privacy & Security → Accessibility. Then select text in another app and press your capture shortcut.'}
            </p>
            <p className="text-[11px] leading-5 text-muted-foreground">
              Reads and saves selections only when you invoke capture. Manual drafts stay separate.
            </p>
            {!access.granted && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setAccess(await bridge.selectionAccess(true))
                  })
                }
              >
                Enable selection capture
              </Button>
            )}
          </section>
        )}
        <section className="space-y-3 border-t pt-5">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <HardDrive className="size-4 text-muted-foreground" />
            Your collection
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            Your clips stay on this Mac. Export a copy to keep a backup or take them somewhere new.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (await bridge.exportCollection()) toast.success('Collection exported')
                })
              }
            >
              <Download />
              Export
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const imported = await bridge.importCollection()
                  if (imported) {
                    await onImported()
                    toast.success('Collection imported')
                    onClose()
                  }
                })
              }
            >
              <Upload />
              Import
            </Button>
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">
            Import replaces your current collection. You’ll be asked to confirm.
          </p>
        </section>
        <div className="flex items-center justify-between border-t pt-4 text-[11px] text-muted-foreground">
          <span>Machete</span>
          <span>Version 0.1.0</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
