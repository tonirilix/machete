import type { OpenRequest } from '../shared/bridge'
import { MAX_CLIP_LENGTH } from '../shared/library'
import type { SelectionResult } from './selection'
import type { LibraryStore } from './store'

type Source = 'selection' | 'clipboard' | 'empty'
interface Presentation {
  ready(): Promise<void>
  // Focus must happen synchronously once readiness and pending reads settle.
  show(mode: OpenRequest['mode'], notice?: string): void
}

/** Owns capture ordering, duplicate selection requests, and shutdown draining. */
export class CaptureController {
  private queue: Promise<void> = Promise.resolve()
  private reads: Promise<void> = Promise.resolve()
  private selection: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly store: Pick<LibraryStore, 'execute' | 'whenIdle'>,
    private readonly sources: {
      selection(): Promise<SelectionResult>
      clipboard(): Promise<string>
    },
    private readonly presentation: Presentation,
  ) {}

  request(source: Source, present = true): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (source === 'selection' && this.selection) return this.selection
    // Acquisition is independent of persistence/presentation. A prior capture
    // must not focus Machete before a newly requested selection has been read.
    // Serialize readers too: clipboard reads cannot overlap native Copy fallback.
    const read = this.reads.then(() => this.read(source))
    this.reads = read.then(
      () => {},
      () => {},
    )
    const task = this.queue.then(() => this.capture(source, read, present))
    // A failed request must not poison later requests or shutdown.
    this.queue = task.catch(() => {})
    if (source === 'selection') {
      this.selection = task.finally(() => {
        this.selection = undefined
      })
      return this.selection
    }
    return task
  }

  async stop(): Promise<void> {
    this.stopped = true
    // Native Copy must finish restoring the clipboard before the app exits.
    await Promise.all([this.reads, this.queue])
    await this.store.whenIdle()
  }

  private async read(source: Source) {
    if (this.stopped) return undefined
    if (source === 'selection') return this.sources.selection()
    return {
      status: 'captured' as const,
      text: source === 'clipboard' ? await this.sources.clipboard() : '',
    }
  }

  private async show(mode: OpenRequest['mode'], notice?: string) {
    await this.presentation.ready()
    // Include readers added during readiness or while another reader settles.
    let pending: Promise<void>
    do {
      pending = this.reads
      await pending
    } while (pending !== this.reads)
    if (!this.stopped) this.presentation.show(mode, notice)
  }

  private async capture(
    source: Source,
    read: Promise<SelectionResult | undefined>,
    present: boolean,
  ): Promise<void> {
    try {
      const result = await read
      if (!result || this.stopped) return
      if (result.status === 'permission-required') {
        if (present) await this.show('settings')
        return
      }
      const text = result.status === 'captured' ? result.text : ''
      const notice = result.status === 'captured' ? undefined : selectionNotice(result.status)
      if (text.length > MAX_CLIP_LENGTH) throw new Error('The copied text is too large to capture.')
      if (source === 'selection') {
        if (result.status !== 'captured' || !text.trim()) {
          if (present) await this.show('browse', notice ?? selectionNotice('no-selection'))
          return
        }
        await this.store.execute({ type: 'save-capture', text })
        if (present) await this.show('saved')
        return
      }
      await this.store.execute({ type: text.length ? 'append-capture' : 'begin-capture', text })
      if (present) await this.show('capture', notice)
    } catch (error) {
      if (source !== 'selection') throw error
      if (!this.stopped) {
        await this.show(
          'browse',
          error instanceof Error ? error.message : 'Selection capture failed.',
        )
      }
    }
  }
}

function selectionNotice(status: SelectionResult['status']): string {
  switch (status) {
    case 'no-selection':
      return 'No selected text found. Select text in another app and try again, or use Capture clipboard.'
    case 'source-changed':
      return 'The active app changed during capture. Select your text and try again.'
    case 'too-large':
      return 'The selected text is too large to capture.'
    case 'keys-held':
      return 'Release the shortcut keys, then try capturing again.'
    case 'clipboard-unavailable':
      return 'The clipboard could not be preserved safely. Copy the selection yourself and use Capture clipboard.'
    case 'clipboard-busy':
      return 'The clipboard changed during capture. Please try again.'
    case 'restore-failed':
      return 'The previous clipboard could not be restored after Copy. No clip was saved.'
    default:
      return 'Could not read the selected text. Copy it yourself and use Capture clipboard.'
  }
}
