import { DOUBLE_SHIFT_SHORTCUT } from '../shared/library'
import type { LibraryStore } from './store'

export interface ShortcutRegistration {
  register(shortcut: string, callback: () => void): boolean
  unregister(shortcut: string): void
  isRegistered(shortcut: string): boolean
}

interface Listener {
  shortcut: string
  adapter: ShortcutRegistration
}

/** Owns listener lifetime and commits shortcut preferences only after registration. */
export class ShortcutController {
  private queue: Promise<void> = Promise.resolve()
  private active: Listener | undefined
  private listeners = new Set<Listener>()
  private stopped = false
  private error: string | null = null

  constructor(
    private readonly store: Pick<LibraryStore, 'getShortcut' | 'execute'>,
    private readonly adapters: {
      electron: ShortcutRegistration
      doubleShift: ShortcutRegistration
    },
    private readonly trigger: () => void,
  ) {}

  get shortcutError(): string | null {
    return this.error
  }

  start(): Promise<void> {
    return this.enqueue(() => this.restore())
  }

  /** Retry the saved preference when Accessibility permission becomes available. */
  recover(): Promise<void> {
    return this.enqueue(() => this.restore())
  }

  change(shortcut: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return
      if (this.active?.shortcut === shortcut && this.registered(this.active)) return
      const next = this.register(shortcut)
      if (!next) throw new Error(shortcutMessage(shortcut, false))
      try {
        await this.store.execute({ type: 'set-shortcut', shortcut })
      } catch (error) {
        this.remove(next)
        throw error
      }
      // stop() already removed both listeners if persistence was in flight.
      if (this.stopped) return
      this.commit(next)
    })
  }

  stop(): Promise<void> {
    this.stopped = true
    this.active = undefined
    for (const listener of this.listeners) this.remove(listener)
    return this.queue
  }

  private enqueue(operation: () => Promise<void> | void): Promise<void> {
    const task = this.queue.then(operation)
    this.queue = task.catch(() => {})
    return task
  }

  private restore(): void {
    if (this.stopped) return
    const shortcut = this.store.getShortcut()
    if (this.active?.shortcut === shortcut && this.registered(this.active)) {
      this.error = null
      return
    }
    const listener = this.register(shortcut)
    if (listener) this.commit(listener)
    else this.error = shortcutMessage(shortcut, true)
  }

  private registered(listener: Listener): boolean {
    return listener.adapter.isRegistered(listener.shortcut)
  }

  private register(shortcut: string): Listener | undefined {
    const adapter =
      shortcut === DOUBLE_SHIFT_SHORTCUT ? this.adapters.doubleShift : this.adapters.electron
    const listener = { shortcut, adapter }
    try {
      if (
        !adapter.register(shortcut, () => {
          // Adapters may deliver callbacks queued before replacement or teardown.
          if (!this.stopped && this.active === listener) this.trigger()
        })
      ) {
        return undefined
      }
    } catch {
      return undefined
    }
    this.listeners.add(listener)
    return listener
  }

  private commit(listener: Listener): void {
    const previous = this.active
    this.active = listener
    if (previous) {
      // A retry for the same unregistered shortcut reuses its adapter key.
      if (previous.shortcut === listener.shortcut) this.listeners.delete(previous)
      else this.remove(previous)
    }
    this.error = null
  }

  private remove(listener: Listener): void {
    if (!this.listeners.delete(listener)) return
    if (this.active === listener) this.active = undefined
    listener.adapter.unregister(listener.shortcut)
  }
}

function shortcutMessage(shortcut: string, startup: boolean): string {
  if (shortcut === DOUBLE_SHIFT_SHORTCUT) {
    return startup
      ? 'Enable Accessibility in Settings to use Double Shift.'
      : 'Double Shift requires macOS Accessibility access. Enable selection capture in Settings first.'
  }
  return startup
    ? 'Your capture shortcut is unavailable. Choose a different one in Settings.'
    : 'That shortcut is unavailable. Try another key combination.'
}
