import { randomUUID } from 'node:crypto'

export interface DraftDrainRequest {
  id: string
  registrationId: string
}

/** The renderer may hold coalesced typing that has not reached the store yet. */
export class DraftQuitDrain {
  private registrationId: string | null = null
  private pending: {
    request: DraftDrainRequest
    resolve: () => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  } | null = null

  constructor(private send: (request: DraftDrainRequest) => void) {}

  register(registrationId: string, active: boolean) {
    if (!active && this.registrationId !== registrationId) return
    this.registrationId = active ? registrationId : null
    if (this.pending && this.pending.request.registrationId !== this.registrationId) {
      this.complete(
        this.pending.request,
        'The draft editor disconnected. Please try quitting again.',
      )
    }
  }

  disconnect() {
    if (this.registrationId) this.register(this.registrationId, false)
  }

  drain(): Promise<void> {
    // Startup can quit before React has installed a handler; there is no local typing yet.
    if (!this.registrationId) return Promise.resolve()
    if (this.pending) return Promise.reject(new Error('Draft shutdown is already in progress.'))
    const request = { id: randomUUID(), registrationId: this.registrationId }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.complete(request, 'The draft editor did not respond. Your app has stayed open.')
      }, 10_000)
      this.pending = { request, resolve, reject, timeout }
      try {
        this.send(request)
      } catch (error) {
        this.complete(
          request,
          error instanceof Error ? error.message : 'Could not reach the draft editor.',
        )
      }
    })
  }

  complete(request: DraftDrainRequest, error?: string) {
    const pending = this.pending
    if (
      !pending ||
      request.id !== pending.request.id ||
      request.registrationId !== pending.request.registrationId
    ) {
      throw new Error('This draft shutdown response is no longer current.')
    }
    clearTimeout(pending.timeout)
    this.pending = null
    if (error) pending.reject(new Error(error))
    else pending.resolve()
  }
}
