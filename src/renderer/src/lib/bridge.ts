import type { DesktopBridge, Snapshot } from '../../../shared/bridge'
import { draftEditSchema } from '../../../shared/draft-edit-schema'
import {
  applyCommand,
  backupSchema,
  createLibrary,
  DOUBLE_SHIFT_SHORTCUT,
  exportBackup,
  librarySchema,
  restoreBackup,
  type Library,
} from '../../../shared/library'

// The browser preview uses its own collection. The desktop app always uses IPC.
export function createBrowserBridge(): DesktopBridge {
  // Keep collections saved by the browser preview before the rename.
  const key = 'cliptoboards.browser-preview.v1'
  let library: Library | undefined
  let revision = 0
  let draftWriteId: string | null = null

  function current(): Library {
    if (!library) {
      const saved = localStorage.getItem(key)
      library = saved ? librarySchema.parse(JSON.parse(saved)) : createLibrary()
    }
    return library
  }

  function snapshot(): Snapshot {
    return { library: structuredClone(current()), shortcutError: null, revision, draftWriteId }
  }

  function save(next: Library): Snapshot {
    localStorage.setItem(key, JSON.stringify(next))
    library = next
    revision++
    return snapshot()
  }

  return {
    getState: async () => snapshot(),
    editDraft: async (input) => {
      const request = draftEditSchema.parse(input)
      if (request.revision !== revision) return { accepted: false, snapshot: snapshot() }
      const command =
        request.action === 'discard'
          ? { type: 'discard-draft' as const }
          : request.action === 'save'
            ? { type: 'save-draft' as const, ...request.draft! }
            : { type: 'update-draft' as const, ...request.draft! }
      const next = applyCommand(current(), command)
      localStorage.setItem(key, JSON.stringify(next))
      library = next
      revision++
      draftWriteId = request.id
      if (request.action === 'update') return { accepted: true, revision, draftWriteId }
      return { accepted: true, snapshot: snapshot() }
    },
    execute: async (command) => save(applyCommand(current(), command)),
    capture: async (fromClipboard) => {
      if (!fromClipboard && current().draft) return snapshot()
      let text = ''
      if (fromClipboard) {
        try {
          text = await navigator.clipboard.readText()
        } catch {
          throw new Error(
            'Clipboard access is unavailable here. Create a new clip and paste your text.',
          )
        }
      }
      return save(
        applyCommand(current(), {
          type: fromClipboard && text.length ? 'append-capture' : 'begin-capture',
          text,
        }),
      )
    },
    copy: async (text) => navigator.clipboard.writeText(text),
    selectionAccess: async () => ({ supported: false, granted: false }),
    hide: async () => {},
    exportCollection: async () => {
      const blob = new Blob([JSON.stringify(exportBackup(current()), null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `machete-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return true
    },
    importCollection: () =>
      new Promise((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'
        input.addEventListener('cancel', () => resolve(null), { once: true })
        input.addEventListener(
          'change',
          async () => {
            try {
              const file = input.files?.[0]
              if (!file) return resolve(null)
              if (file.size > 64 * 1024 * 1024)
                throw new Error('This collection file is too large.')
              const backup = backupSchema.safeParse(JSON.parse(await file.text()))
              if (!backup.success) throw new Error('This is not a supported Machete collection.')
              if (
                !confirm(
                  'Replace your current boards, clips, Trash, and draft with this collection?',
                )
              ) {
                return resolve(null)
              }
              resolve(save(restoreBackup(current(), backup.data)))
            } catch (error) {
              reject(error)
            }
          },
          { once: true },
        )
        input.click()
      }),
    onBeforeQuit: () => () => {},
    onOpen: () => () => {},
  }
}

function getBridge(): DesktopBridge {
  if (window.machete) return window.machete
  if (import.meta.env.DEV) return createBrowserBridge()
  throw new Error('The desktop connection is unavailable. Please restart Machete.')
}

export const bridge = getBridge()
export const isDesktop = Boolean(window.machete)

export function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : 'Something went wrong. Please try again.'
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function shortcutLabel(shortcut: string) {
  if (shortcut === DOUBLE_SHIFT_SHORTCUT) return '⇧ ⇧'
  return shortcut
    .replace(/CommandOrControl|Command|Cmd/gi, '⌘')
    .replace(/Control|Ctrl/gi, '⌃')
    .replace(/Shift/gi, '⇧')
    .replace(/Alt|Option/gi, '⌥')
    .replace(/Space/gi, 'Space')
    .replaceAll('+', '')
}
