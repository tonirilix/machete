import { describe, expect, it, vi, afterEach } from 'vitest'
import { DraftQuitDrain } from '../src/main/draft-quit-drain'
import { LibraryStore } from '../src/main/store'
import type { DraftEdit, DraftEditResult, Snapshot } from '../src/shared/bridge'
import { DraftEditing } from '../src/renderer/src/lib/draft-editing'

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function harness(
  persist?: Parameters<typeof LibraryStore.inMemory>[0],
  initial = 'original',
) {
  const store = LibraryStore.inMemory(persist)
  await store.execute({ type: 'begin-capture', text: initial })
  const snapshot = (): Snapshot => ({
    library: store.getState(),
    revision: store.getRevision(),
    draftWriteId: store.getDraftWriteId(),
    shortcutError: null,
  })
  const calls: {
    request: DraftEdit
    result?: DraftEditResult
    resolve: (result: DraftEditResult) => void
    reject: (error: Error) => void
  }[] = []
  const editing = new DraftEditing({
    editDraft: (request) =>
      new Promise((resolve, reject) => {
        calls.push({ request, resolve, reject })
      }),
  })
  editing.receive(snapshot())
  async function commit(index: number, deliver = true) {
    const call = calls[index]
    const result = await store.editDraft(call.request)
    call.result = {
      accepted: result.accepted,
      snapshot: {
        library: result.library,
        revision: result.revision,
        draftWriteId: result.draftWriteId,
        shortcutError: null,
      },
    }
    if (deliver) {
      call.resolve(call.result)
      await settle()
    }
  }
  async function append(text: string) {
    await store.execute({ type: 'append-capture', text })
    editing.receive(snapshot())
  }
  return { store, editing, calls, commit, append, snapshot }
}

describe('DraftEditing', () => {
  it('keeps unsent typing when a quick capture advances the collection revision', async () => {
    const h = await harness()
    h.editing.change({ text: 'latest manual typing', boardId: 'inbox' })
    await h.store.execute({ type: 'save-capture', text: 'independent selection' })
    h.editing.receive(h.snapshot())
    expect(h.editing.getState().draft?.text).toBe('latest manual typing')
    await h.commit(0)
    expect(h.calls[0].result?.accepted).toBe(false)
    await h.commit(1)
    await h.editing.whenIdle()
    expect(h.store.getState().draft?.text).toBe('latest manual typing')
    expect(h.store.getState().clips.map((clip) => clip.text)).toEqual(['independent selection'])
  })

  it('keeps latest typing and captures when an older acknowledgement arrives last', async () => {
    const h = await harness()
    h.editing.change({ text: 'first edit', boardId: 'inbox' })
    h.editing.change({ text: 'latest edit', boardId: 'inbox' })
    await h.commit(0, false)
    const oldAcknowledgement = h.calls[0].result!
    await h.append('selection')
    expect(h.editing.getState().draft?.text).toBe('latest edit\n\nselection')
    h.calls[0].resolve(oldAcknowledgement)
    await settle()
    expect(h.calls[1].request.draft?.text).toBe('latest edit\n\nselection')
    await h.commit(1)
    // Later unrelated snapshots must not append a captured suffix twice.
    await h.store.execute({ type: 'create-board', name: 'References' })
    h.editing.receive(h.snapshot())
    h.editing.receive(oldAcknowledgement.snapshot)
    expect(h.editing.getState().draft?.text).toBe('latest edit\n\nselection')
    expect(h.store.getState().draft?.text).toBe('latest edit\n\nselection')
    expect(h.calls).toHaveLength(2)
  })

  it('recognizes a pending write in unrelated snapshots without duplicating typed paragraphs', async () => {
    const h = await harness()
    h.editing.change({ text: 'original\n\nmy paragraph', boardId: 'inbox' })
    await h.commit(0, false)
    await h.store.execute({ type: 'create-board', name: 'Another board' })
    h.editing.receive(h.snapshot())
    expect(h.editing.getState().draft?.text).toBe('original\n\nmy paragraph')
    h.calls[0].resolve(h.calls[0].result!)
    await settle()
    expect(h.calls).toHaveLength(1)
  })

  it('keeps identical typed and captured paragraphs as two deliberate pieces of text', async () => {
    const h = await harness()
    h.editing.change({ text: 'original\n\nidentical', boardId: 'inbox' })
    await h.append('identical')
    expect(h.editing.getState().draft?.text).toBe('original\n\nidentical\n\nidentical')
    await h.commit(0)
    await h.commit(1)
    expect(h.store.getState().draft?.text).toBe('original\n\nidentical\n\nidentical')
  })

  it.each(['B', 'B\n\nC'])(
    'keeps the complete captured suffix %j when it reconstructs a deleted prefix',
    async (captured) => {
      const h = await harness(undefined, 'A\n\nB')
      h.editing.change({ text: 'A', boardId: 'inbox' })
      await h.commit(0, false)
      h.editing.change({ text: 'latest A', boardId: 'inbox' })
      await h.append(captured)
      expect(h.editing.getState().draft?.text).toBe(`latest A\n\n${captured}`)
      // A second capture before the acknowledgement must use the newly observed
      // durable base, so the first suffix is neither lost nor appended twice.
      await h.append('D')
      const expected = `latest A\n\n${captured}\n\nD`
      expect(h.editing.getState().draft?.text).toBe(expected)
      h.calls[0].resolve(h.calls[0].result!)
      await settle()
      expect(h.calls[1].request.draft?.text).toBe(expected)
      await h.commit(1)
      expect(h.store.getState().draft?.text).toBe(expected)
    },
  )

  it('conditionally rejects a delayed write that would erase a capture on disk', async () => {
    const h = await harness()
    h.editing.change({ text: 'local typing', boardId: 'inbox' })
    await h.append('captured before write')
    await h.commit(0)
    expect(h.calls[0].result?.accepted).toBe(false)
    expect(h.store.getState().draft?.text).toBe('original\n\ncaptured before write')
    await h.commit(1)
    expect(h.store.getState().draft?.text).toBe('local typing\n\ncaptured before write')
    expect(h.editing.getState().draft).toEqual(h.store.getState().draft)
  })

  it('keeps board choice and saves latest text plus a capture received during save', async () => {
    const h = await harness()
    await h.store.execute({ type: 'create-board', name: 'Commands' })
    h.editing.receive(h.snapshot())
    const boardId = h.store.getState().boards[1].id
    h.editing.change({ text: 'first', boardId })
    h.editing.change({ text: 'final', boardId })
    const saved = h.editing.save()
    await h.commit(0)
    expect(h.calls[1].request.action).toBe('save')
    await h.append('last selection')
    await h.commit(1)
    expect(h.calls[1].result?.accepted).toBe(false)
    await h.commit(2)
    expect(await saved).toEqual({ text: 'final\n\nlast selection', boardId })
    expect(h.store.getState().clips[0]).toMatchObject({ text: 'final\n\nlast selection', boardId })
    expect(h.editing.getState().draft).toBeNull()
    h.editing.receive(h.calls[0].result!.snapshot)
    expect(h.editing.getState().draft).toBeNull()
    expect(h.calls).toHaveLength(3)
  })

  it('discards after pending typing without late acknowledgements resurrecting a draft', async () => {
    const h = await harness()
    h.editing.change({ text: 'unfinished', boardId: 'inbox' })
    const discarded = h.editing.discard()
    await h.commit(0)
    const oldSnapshot = h.calls[0].result!.snapshot
    await h.commit(1)
    expect(await discarded).toBeTruthy()
    h.editing.receive(oldSnapshot)
    expect(h.editing.getState()).toMatchObject({ draft: null, busy: false })
    expect(h.store.getState().draft).toBeNull()
    await h.store.execute({ type: 'begin-capture', text: 'new capture' })
    h.editing.receive(h.snapshot())
    expect(h.editing.getState().draft?.text).toBe('new capture')
  })

  it.each(['save', 'discard'] as const)(
    'preserves the successor capture when an old %s acknowledgement arrives late',
    async (action) => {
      const h = await harness()
      h.editing.change({ text: 'first', boardId: 'inbox' })
      h.editing.change({ text: 'final', boardId: 'inbox' })
      const completed = h.editing[action]()
      await h.commit(0)
      expect(h.calls[1].request).toMatchObject({ action, draft: { text: 'final' } })
      await h.commit(1, false)
      await h.append('new capture')
      expect(h.editing.getState()).toMatchObject({ draft: { text: 'new capture' }, busy: false })
      // Null suppresses the old editor completion/navigation callback.
      expect(await completed).toBeNull()
      h.calls[1].resolve(h.calls[1].result!)
      await settle()
      expect(h.editing.getState().draft?.text).toBe('new capture')
      expect(h.store.getState().draft?.text).toBe('new capture')
      expect(h.calls).toHaveLength(2)
      if (action === 'save') expect(h.store.getState().clips[0].text).toBe('final')
    },
  )

  it.each(['save', 'discard'] as const)(
    'completes %s exactly once when a newer snapshot confirms there is no successor draft',
    async (action) => {
      const h = await harness()
      const completion = vi.fn()
      const finished = h.editing[action]().then((draft) => {
        completion(draft)
        return draft
      })
      await h.commit(0, false)
      await h.store.execute({ type: 'create-board', name: 'Unrelated change' })
      h.editing.receive(h.snapshot())
      expect(await finished).toEqual({ text: 'original', boardId: 'inbox' })
      expect(h.editing.getState()).toMatchObject({ draft: null, busy: false })
      h.calls[0].resolve(h.calls[0].result!)
      await settle()
      expect(completion).toHaveBeenCalledTimes(1)
      expect(h.calls).toHaveLength(1)
    },
  )

  it('keeps a successor save pending when the previous generation acknowledgement arrives', async () => {
    const h = await harness()
    const previous = h.editing.save()
    await h.commit(0, false)
    await h.append('successor')
    expect(await previous).toBeNull()
    h.editing.change({ text: 'edited successor', boardId: 'inbox' })
    const successor = h.editing.save()
    h.calls[0].resolve(h.calls[0].result!)
    await settle()
    expect(h.editing.getState().busy).toBe(true)
    expect(h.calls[1].request).toMatchObject({
      action: 'save',
      draft: { text: 'edited successor' },
    })
    await h.commit(1)
    expect(await successor).toEqual({ text: 'edited successor', boardId: 'inbox' })
    expect(h.store.getState().clips.map((clip) => clip.text)).toEqual([
      'edited successor',
      'original',
    ])
  })

  it('drains coalesced typing through the quit handshake before permitting exit', async () => {
    const h = await harness()
    h.editing.change({ text: 'first', boardId: 'inbox' })
    h.editing.change({ text: 'latest typing', boardId: 'inbox' })
    const exit = vi.fn()
    const quit = new DraftQuitDrain((request) => {
      void h.editing.prepareToQuit().then(
        () => quit.complete(request),
        (error: Error) => quit.complete(request, error.message),
      )
    })
    quit.register(crypto.randomUUID(), true)
    const shutdown = quit.drain().then(exit)
    expect(h.editing.getState().busy).toBe(true)
    await h.commit(0)
    expect(exit).not.toHaveBeenCalled()
    expect(h.calls[1].request.draft?.text).toBe('latest typing')
    await h.commit(1)
    await shutdown
    expect(exit).toHaveBeenCalledOnce()
    expect(h.store.getState().draft?.text).toBe('latest typing')
  })

  it('cancels quit after a failed draft write and permits retry without losing local typing', async () => {
    const h = await harness()
    h.editing.change({ text: 'first', boardId: 'inbox' })
    h.editing.change({ text: 'latest typing', boardId: 'inbox' })
    const exit = vi.fn()
    const quit = new DraftQuitDrain((request) => {
      void h.editing.prepareToQuit().then(
        () => quit.complete(request),
        (error: Error) => quit.complete(request, error.message),
      )
    })
    quit.register(crypto.randomUUID(), true)
    const shutdown = quit.drain().then(exit)
    const failure = expect(shutdown).rejects.toThrow('Disk full')
    h.calls[0].reject(new Error('Disk full'))
    await failure
    expect(exit).not.toHaveBeenCalled()
    expect(h.editing.getState()).toMatchObject({ draft: { text: 'latest typing' }, busy: false })
    h.editing.retry()
    await h.commit(1)
    await quit.drain().then(exit)
    expect(exit).toHaveBeenCalledOnce()
    expect(h.store.getState().draft?.text).toBe('latest typing')
  })

  it('adopts an externally changed board when the local board choice is unchanged', async () => {
    const h = await harness()
    await h.store.execute({ type: 'create-board', name: 'External board' })
    const boardId = h.store.getState().boards[1].id
    // A legacy bridge caller changes the durable board without sending its
    // result through App; native capture supplies the next observed snapshot.
    await h.store.execute({ type: 'update-draft', text: 'original', boardId })
    await h.append('selection')
    expect(h.editing.getState().draft).toEqual({ text: 'original\n\nselection', boardId })
    expect(h.calls).toHaveLength(0)
    h.editing.change({ text: 'new typing', boardId: h.editing.getState().draft!.boardId })
    await h.commit(0)
    expect(h.store.getState().draft).toEqual({ text: 'new typing', boardId })
  })

  it('preserves a local board revert against the proven pending write baseline', async () => {
    const h = await harness()
    await h.store.execute({ type: 'create-board', name: 'Pending board' })
    h.editing.receive(h.snapshot())
    const boardId = h.store.getState().boards[1].id
    h.editing.change({ text: 'original', boardId })
    await h.commit(0, false)
    h.editing.change({ text: 'original', boardId: 'inbox' })
    await h.append('selection')
    expect(h.editing.getState().draft).toEqual({ text: 'original\n\nselection', boardId: 'inbox' })
    h.calls[0].resolve(h.calls[0].result!)
    await settle()
    expect(h.calls[1].request.draft?.boardId).toBe('inbox')
    await h.commit(1)
    expect(h.store.getState().draft).toEqual({ text: 'original\n\nselection', boardId: 'inbox' })
  })

  it('retains failed local edits, exposes retry and reconciles a deleted board', async () => {
    const h = await harness()
    await h.store.execute({ type: 'create-board', name: 'Temporary' })
    h.editing.receive(h.snapshot())
    const boardId = h.store.getState().boards[1].id
    h.editing.change({ text: 'keep me', boardId })
    h.calls[0].reject(new Error('Disk is full'))
    await settle()
    expect(h.editing.getState()).toMatchObject({
      draft: { text: 'keep me', boardId },
      error: 'Disk is full',
    })
    await h.store.execute({ type: 'delete-board', id: boardId })
    h.editing.receive(h.snapshot())
    expect(h.editing.getState().draft).toEqual({ text: 'keep me', boardId: 'inbox' })
    h.editing.retry()
    await h.commit(1)
    expect(h.store.getState().draft).toEqual({ text: 'keep me', boardId: 'inbox' })
    expect(h.editing.getState().error).toBeNull()
  })

  it('retains the draft after failed explicit save and can save again', async () => {
    const h = await harness()
    const save = h.editing.save()
    h.calls[0].reject(new Error('Cannot write'))
    expect(await save).toBeNull()
    expect(h.editing.getState()).toMatchObject({
      draft: { text: 'original' },
      busy: false,
      error: 'Cannot write',
    })
    const retry = h.editing.save()
    await h.commit(1)
    expect(await retry).toEqual({ text: 'original', boardId: 'inbox' })
  })

  it('repeated native captures during pending typing each appear exactly once', async () => {
    const h = await harness()
    h.editing.change({ text: '', boardId: 'inbox' })
    await h.append('one')
    await h.append('two')
    expect(h.editing.getState().draft?.text).toBe('one\n\ntwo')
    await h.commit(0)
    await h.commit(1)
    expect(h.store.getState().draft?.text).toBe('one\n\ntwo')
  })
})

afterEach(() => vi.unstubAllGlobals())

it('uses conditional editing through the normal browser adapter and resumes persisted drafts', async () => {
  const data = new Map<string, string>()
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  })
  vi.stubGlobal('navigator', { clipboard: { readText: async () => 'browser capture' } })
  const { createBrowserBridge } = await import('../src/renderer/src/lib/bridge')
  const bridge = createBrowserBridge()
  const editing = new DraftEditing(bridge)
  editing.receive(await bridge.capture(false))
  editing.change({ text: 'browser typing', boardId: 'inbox' })
  await settle()
  editing.receive(await bridge.capture(true))
  expect(editing.getState().draft?.text).toBe('browser typing\n\nbrowser capture')
  const resumedBridge = createBrowserBridge()
  const resumed = new DraftEditing(resumedBridge)
  resumed.receive(await resumedBridge.getState())
  expect(resumed.getState().draft).toEqual(editing.getState().draft)
  await resumed.save()
  expect((await resumedBridge.getState()).library.clips[0].text).toBe(
    'browser typing\n\nbrowser capture',
  )
})
