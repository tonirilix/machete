import type { DesktopBridge, DraftEdit, Snapshot } from '../../../shared/bridge'
import { INBOX_ID, type Draft } from '../../../shared/library'

export interface DraftEditingState {
  draft: Draft | null
  busy: boolean
  error: string | null
}

const equal = (a: Draft | null, b: Draft | null) => a?.text === b?.text && a?.boardId === b?.boardId

/** One unfinished capture, including the durable boundary with native capture.
 * Writes are serialized and conditional on the last observed collection revision.
 * A conflicting native append is rebased onto local typing before the next write.
 */
export class DraftEditing {
  private state: DraftEditingState = { draft: null, busy: false, error: null }
  private listeners = new Set<() => void>()
  private snapshot: Snapshot | null = null
  private durable: Draft | null = null
  private pending: DraftEdit | null = null
  private quitting = false
  private idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>()
  private terminal: {
    action: 'save' | 'discard'
    resolve: (draft: Draft | null) => void
  } | null = null

  constructor(
    private bridge: Pick<DesktopBridge, 'editDraft'>,
    private onSnapshot: (snapshot: Snapshot) => void = () => {},
  ) {}

  getState = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(update: Partial<DraftEditingState>) {
    this.state = { ...this.state, ...update, ...(this.quitting ? { busy: true } : {}) }
    this.listeners.forEach((listener) => listener())
  }

  receive(snapshot: Snapshot) {
    this.accept(snapshot)
    void this.flush()
  }

  private accept(snapshot: Snapshot, acknowledged?: DraftEdit) {
    if (this.snapshot && snapshot.revision <= this.snapshot.revision) return
    let local = this.state.draft
    const remote = snapshot.library.draft
    const newlyObservedWrite = Boolean(
      this.pending &&
      snapshot.draftWriteId === this.pending.id &&
      snapshot.draftWriteId !== this.snapshot?.draftWriteId,
    )
    const completedGeneration = newlyObservedWrite && this.pending?.action !== 'update'
    const reconciliationBase = newlyObservedWrite ? this.pending?.draft : this.durable
    const boardUnchanged = local?.boardId === reconciliationBase?.boardId
    if (!this.snapshot || !local || !remote || completedGeneration) {
      local = remote && { ...remote }
    } else if (
      (remote.text !== this.durable?.text || newlyObservedWrite) &&
      (!acknowledged || acknowledged.action !== 'update')
    ) {
      // The first snapshot proving our pending write applied uses that exact
      // write as its base. Subsequent captures use the newer durable snapshot,
      // which already includes any previously observed captured suffix.
      const candidate = reconciliationBase
      const base =
        candidate &&
        (remote.text === candidate.text ||
          (candidate.text
            ? remote.text.startsWith(`${candidate.text}\n\n`)
            : remote.text.length > 0))
          ? candidate
          : null
      if (base && remote.text !== base.text) {
        const suffix = remote.text.slice(base.text.length + (base.text ? 2 : 0))
        local = { ...local, text: local.text ? `${local.text}\n\n${suffix}` : suffix }
      } else if (!base && equal(local, this.durable)) {
        local = { ...remote }
      }
    }
    if (local && remote && !completedGeneration && boardUnchanged) {
      local = { ...local, boardId: remote.boardId }
    }
    if (local && !snapshot.library.boards.some((board) => board.id === local!.boardId)) {
      local = { ...local, boardId: INBOX_ID }
    }
    this.snapshot = snapshot
    this.durable = remote && { ...remote }
    this.publish({ draft: local })
    if ((completedGeneration || !local) && this.terminal && !acknowledged) {
      const terminal = this.terminal
      this.terminal = null
      this.publish({ busy: false })
      // A successor capture must stay open; the old completion must not invoke
      // the editor's navigation callback when its delayed response arrives.
      terminal.resolve(completedGeneration && !remote ? this.pending!.draft! : null)
    }
    this.onSnapshot(snapshot)
  }

  change(draft: Draft) {
    if (!this.state.draft || this.state.busy) return
    this.publish({ draft: { ...draft }, error: null })
    void this.flush()
  }

  whenIdle(): Promise<void> {
    if (this.state.error) return Promise.reject(new Error(this.state.error))
    if (!this.pending && !this.terminal && equal(this.state.draft, this.durable)) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.idleWaiters.add({ resolve, reject })
      void this.flush()
    })
  }

  async prepareToQuit(): Promise<void> {
    this.quitting = true
    this.publish({ busy: true })
    try {
      await this.whenIdle()
    } catch (error) {
      this.quitting = false
      this.publish({ busy: Boolean(this.terminal) })
      throw error
    }
  }

  cancelQuit() {
    this.quitting = false
    this.publish({ busy: Boolean(this.terminal) })
  }

  private settleIdle() {
    if (this.state.error) {
      for (const waiter of this.idleWaiters) waiter.reject(new Error(this.state.error))
    } else if (!this.pending && !this.terminal && equal(this.state.draft, this.durable)) {
      for (const waiter of this.idleWaiters) waiter.resolve()
    } else return
    this.idleWaiters.clear()
  }

  retry() {
    this.publish({ error: null })
    void this.flush()
  }

  save(): Promise<Draft | null> {
    return this.finish('save')
  }
  discard(): Promise<Draft | null> {
    return this.finish('discard')
  }

  private finish(action: 'save' | 'discard'): Promise<Draft | null> {
    if (this.quitting || this.terminal || !this.state.draft) return Promise.resolve(null)
    this.publish({ busy: true, error: null })
    return new Promise((resolve) => {
      this.terminal = { action, resolve }
      void this.flush()
    })
  }

  private async flush(): Promise<void> {
    if (this.pending || !this.snapshot || this.state.error || !this.state.draft) return
    if (!this.terminal && equal(this.state.draft, this.durable)) return
    const terminalForRequest = this.terminal
    const request: DraftEdit = {
      id: crypto.randomUUID(),
      revision: this.snapshot.revision,
      action: this.terminal?.action ?? 'update',
      draft: { ...this.state.draft },
    }
    this.pending = request
    try {
      const result = await this.bridge.editDraft(request)
      this.accept(result.snapshot, result.accepted ? request : undefined)
      if (
        result.accepted &&
        request.action !== 'update' &&
        this.terminal === terminalForRequest &&
        terminalForRequest
      ) {
        const terminal = this.terminal
        this.terminal = null
        this.publish({ busy: false })
        terminal?.resolve(request.draft!)
      }
    } catch (error) {
      this.publish({
        busy: false,
        error: error instanceof Error ? error.message : 'Could not keep your draft. Try again.',
      })
      const terminal = this.terminal
      this.terminal = null
      terminal?.resolve(null)
    } finally {
      this.pending = null
      // Coalesce typing while preserving the latest value and any captured suffix.
      void this.flush()
      this.settleIdle()
    }
  }
}
