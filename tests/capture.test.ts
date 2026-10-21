import { describe, expect, it, vi } from 'vitest'
import { CaptureController } from '../src/main/capture'
import { LibraryStore } from '../src/main/store'
import type { SelectionResult } from '../src/main/selection'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function setup(store = LibraryStore.inMemory()) {
  const selection = vi.fn(async (): Promise<SelectionResult> => ({
    status: 'captured',
    text: 'selected',
  }))
  const clipboard = vi.fn(async () => 'copied')
  const present = vi.fn(() => {})
  const ready = vi.fn(async () => {})
  const captures = new CaptureController(store, { selection, clipboard }, { ready, show: present })
  return { captures, store, selection, clipboard, present, ready }
}

describe('capture ownership', () => {
  it('reads selection before presentation and coalesces concurrent triggers', async () => {
    const { captures, selection, store, present } = setup()
    const read = deferred<SelectionResult>()
    selection.mockReturnValue(read.promise)
    const first = captures.request('selection')
    const second = captures.request('selection')
    expect(second).toBe(first)
    await vi.waitFor(() => expect(selection).toHaveBeenCalledOnce())
    expect(present).not.toHaveBeenCalled()
    read.resolve({ status: 'captured', text: '  verbatim\n' })
    await Promise.all([first, second])
    expect(store.getState().draft).toBeNull()
    expect(store.getState().clips.map((clip) => clip.text)).toEqual(['  verbatim\n'])
    expect(present).toHaveBeenCalledExactlyOnceWith('saved', undefined)
  })

  it('reads a new selection before an older clipboard capture takes focus', async () => {
    const write = deferred<void>()
    const persist = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(undefined)
    const { captures, selection, present, store } = setup(LibraryStore.inMemory(persist))
    let frontmost = 'source'
    present.mockImplementation(async () => {
      frontmost = 'Machete'
    })
    selection.mockImplementation(async () => ({ status: 'captured', text: frontmost }))
    const clipboard = captures.request('clipboard')
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    const selected = captures.request('selection')
    write.resolve(undefined)
    await Promise.all([clipboard, selected])
    expect(store.getState().draft?.text).toBe('copied')
    expect(store.getState().clips.map((clip) => clip.text)).toEqual(['source'])
  })

  it('waits for reads requested while presentation is waiting for startup', async () => {
    const { captures, ready, selection, present } = setup()
    const startup = deferred<void>()
    const read = deferred<SelectionResult>()
    ready.mockReturnValue(startup.promise)
    const clipboard = captures.request('clipboard')
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
    selection.mockReturnValue(read.promise)
    const selected = captures.request('selection')
    await vi.waitFor(() => expect(selection).toHaveBeenCalledOnce())
    startup.resolve(undefined)
    await Promise.resolve()
    expect(present).not.toHaveBeenCalled()
    read.resolve({ status: 'captured', text: 'selected before focus' })
    await Promise.all([clipboard, selected])
    expect(present).toHaveBeenCalledTimes(2)
  })

  it('opens permission settings without mutating the draft', async () => {
    const { captures, selection, store, present } = setup()
    selection.mockResolvedValue({ status: 'permission-required', text: '' })
    await captures.request('selection')
    expect(store.getState().draft).toBeNull()
    expect(present).toHaveBeenCalledExactlyOnceWith('settings', undefined)
  })

  it('preserves draft and board on failed selection and appends explicit clipboard text', async () => {
    const { captures, selection, store, present } = setup()
    await store.execute({ type: 'create-board', name: 'Work' })
    const boardId = store.getState().boards[1].id
    await store.execute({ type: 'begin-capture', text: '' })
    await store.execute({ type: 'update-draft', text: 'existing', boardId })
    selection.mockResolvedValue({ status: 'no-selection', text: '' })
    await captures.request('selection')
    expect(store.getState().draft).toEqual({ text: 'existing', boardId })
    expect(present.mock.calls[0]).toEqual(['browse', expect.stringContaining('No selected text')])
    await captures.request('clipboard', false)
    expect(store.getState().draft).toEqual({ text: 'existing\n\ncopied', boardId })
    expect(present).toHaveBeenCalledOnce()
  })

  it('does not publish a failed write and can recover on the next request', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)
    const { captures, store, present } = setup(LibraryStore.inMemory(persist))
    await captures.request('selection')
    expect(store.getState().draft).toBeNull()
    expect(present).toHaveBeenCalledExactlyOnceWith('browse', 'disk full')
    await captures.request('selection')
    expect(store.getState().draft).toBeNull()
    expect(store.getState().clips.map((clip) => clip.text)).toEqual(['selected'])
  })

  it('saves successive shortcut captures separately without changing an existing manual draft', async () => {
    const { captures, store, selection, present } = setup()
    await store.execute({ type: 'begin-capture', text: 'manual draft' })
    await captures.request('selection')
    selection.mockResolvedValue({ status: 'captured', text: 'next selection' })
    await captures.request('selection')
    expect(store.getState().clips.map((clip) => clip.text)).toEqual(['next selection', 'selected'])
    expect(store.getState().draft?.text).toBe('manual draft')
    expect(present).toHaveBeenNthCalledWith(1, 'saved', undefined)
    expect(present).toHaveBeenNthCalledWith(2, 'saved', undefined)
  })

  it.each(['', ' \n\t'])('does not save blank selected text or open a draft (%j)', async (text) => {
    const { captures, store, selection, present } = setup()
    selection.mockResolvedValue({ status: 'captured', text })
    await captures.request('selection')
    expect(store.getState().draft).toBeNull()
    expect(store.getState().clips).toEqual([])
    expect(present).toHaveBeenCalledWith('browse', expect.stringContaining('No selected text'))
  })

  it.each([
    'source-changed',
    'too-large',
    'keys-held',
    'clipboard-unavailable',
    'clipboard-busy',
    'restore-failed',
    'no-selection',
  ] as const)(
    'leaves clips and the manual draft untouched when selection reports %s',
    async (status) => {
      const { captures, store, selection, present } = setup()
      await store.execute({ type: 'begin-capture', text: 'manual draft' })
      selection.mockResolvedValue({ status, text: '' })
      await captures.request('selection')
      expect(store.getState().draft?.text).toBe('manual draft')
      expect(store.getState().clips).toEqual([])
      expect(present).toHaveBeenCalledWith('browse', expect.any(String))
    },
  )

  it('propagates explicit clipboard failures without poisoning the capture queue', async () => {
    const { captures, clipboard, store } = setup()
    clipboard.mockRejectedValueOnce(new Error('clipboard busy'))
    await expect(captures.request('clipboard', false)).rejects.toThrow('clipboard busy')
    await captures.request('clipboard', false)
    expect(store.getState().draft?.text).toBe('copied')
  })

  it('waits for native Copy restoration and cancels queued work on shutdown', async () => {
    const { captures, selection, clipboard, store, present } = setup()
    const copy = deferred<SelectionResult>()
    selection.mockReturnValue(copy.promise)
    const active = captures.request('selection')
    await vi.waitFor(() => expect(selection).toHaveBeenCalledOnce())
    const queued = captures.request('clipboard')
    let drained = false
    const stopped = captures.stop().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    copy.resolve({ status: 'captured', text: 'restored first' })
    await Promise.all([active, queued, stopped, captures.request('selection')])
    expect(drained).toBe(true)
    expect(clipboard).not.toHaveBeenCalled()
    expect(present).not.toHaveBeenCalled()
    expect(store.getState().draft).toBeNull()
  })

  it('drains an already-started persistence operation without showing a window', async () => {
    const write = deferred<void>()
    const persist = vi.fn(() => write.promise)
    const { captures, store, present } = setup(LibraryStore.inMemory(persist))
    const active = captures.request('clipboard')
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    let stopped = false
    const stop = captures.stop().then(() => {
      stopped = true
    })
    expect(stopped).toBe(false)
    write.resolve(undefined)
    await Promise.all([active, stop])
    expect(store.getState().draft?.text).toBe('copied')
    expect(present).not.toHaveBeenCalled()
  })
})
