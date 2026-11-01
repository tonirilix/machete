import { describe, expect, it, vi } from 'vitest'
import { ShortcutController, type ShortcutRegistration } from '../src/main/shortcuts'
import { LibraryStore } from '../src/main/store'
import { DEFAULT_SHORTCUT, DOUBLE_SHIFT_SHORTCUT } from '../src/shared/library'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function adapter() {
  const callbacks = new Map<string, () => void>()
  const register = vi.fn((shortcut: string, callback: () => void) => {
    callbacks.set(shortcut, callback)
    return true
  })
  const unregister = vi.fn((shortcut: string) => {
    callbacks.delete(shortcut)
  })
  const isRegistered = vi.fn((shortcut: string) => callbacks.has(shortcut))
  return { callbacks, register, unregister, isRegistered } satisfies ShortcutRegistration & {
    callbacks: Map<string, () => void>
  }
}

function setup(store = LibraryStore.inMemory()) {
  const electron = adapter()
  const doubleShift = adapter()
  const trigger = vi.fn()
  const shortcuts = new ShortcutController(store, { electron, doubleShift }, trigger)
  return { store, shortcuts, electron, doubleShift, trigger }
}

const combination = 'CommandOrControl+Shift+J'

describe('shortcut lifecycle', () => {
  it('reads only the committed shortcut during recovery without cloning the collection', async () => {
    const write = deferred()
    const persist = vi.fn(() => write.promise)
    const store = LibraryStore.inMemory(persist)
    const { shortcuts } = setup(store)
    const clones = vi.spyOn(store, 'getState')
    await shortcuts.start()
    const change = shortcuts.change(combination)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    expect(store.getShortcut()).toBe(DEFAULT_SHORTCUT)
    expect(clones).not.toHaveBeenCalled()
    write.resolve()
    await change
    clones.mockClear()
    await shortcuts.recover()
    expect(store.getShortcut()).toBe(combination)
    expect(clones).not.toHaveBeenCalled()
  })

  it('registers the saved preference once and suppresses callbacks after teardown', async () => {
    const { shortcuts, electron, trigger } = setup()
    await shortcuts.start()
    const callback = electron.callbacks.get(DEFAULT_SHORTCUT)!
    await shortcuts.start()
    expect(electron.register).toHaveBeenCalledOnce()
    callback()
    expect(trigger).toHaveBeenCalledOnce()
    await shortcuts.stop()
    callback()
    await shortcuts.recover()
    await shortcuts.change(combination)
    expect(trigger).toHaveBeenCalledOnce()
    expect(electron.callbacks.size).toBe(0)
  })

  it.each(['rejected', 'thrown'])(
    'keeps the saved working shortcut when registration is %s',
    async (failure) => {
      const { shortcuts, electron, store, trigger } = setup()
      await shortcuts.start()
      if (failure === 'rejected') electron.register.mockReturnValueOnce(false)
      else
        electron.register.mockImplementationOnce(() => {
          throw new Error('invalid accelerator')
        })
      await expect(shortcuts.change(combination)).rejects.toThrow('unavailable')
      expect(store.getState().settings.shortcut).toBe(DEFAULT_SHORTCUT)
      expect([...electron.callbacks.keys()]).toEqual([DEFAULT_SHORTCUT])
      electron.callbacks.get(DEFAULT_SHORTCUT)!()
      expect(trigger).toHaveBeenCalledOnce()
    },
  )

  it('reports failed native registration without replacing the working combination', async () => {
    const { shortcuts, electron, doubleShift, store } = setup()
    await shortcuts.start()
    doubleShift.register.mockReturnValueOnce(false)
    await expect(shortcuts.change(DOUBLE_SHIFT_SHORTCUT)).rejects.toThrow('Accessibility')
    expect(store.getState().settings.shortcut).toBe(DEFAULT_SHORTCUT)
    expect(electron.callbacks.has(DEFAULT_SHORTCUT)).toBe(true)
  })

  it('publishes a startup registration error and retries the same saved combination', async () => {
    const { shortcuts, electron } = setup()
    electron.register.mockReturnValueOnce(false)
    await shortcuts.start()
    expect(shortcuts.shortcutError).toContain('unavailable')
    await shortcuts.change(DEFAULT_SHORTCUT)
    expect(shortcuts.shortcutError).toBeNull()
    expect(electron.callbacks.has(DEFAULT_SHORTCUT)).toBe(true)
  })

  it('gates candidate callbacks until persistence commits and retires queued old callbacks', async () => {
    const write = deferred()
    const persist = vi.fn(() => write.promise)
    const { shortcuts, electron, doubleShift, trigger, store } = setup(
      LibraryStore.inMemory(persist),
    )
    await shortcuts.start()
    const old = electron.callbacks.get(DEFAULT_SHORTCUT)!
    const changed = shortcuts.change(DOUBLE_SHIFT_SHORTCUT)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    const next = doubleShift.callbacks.get(DOUBLE_SHIFT_SHORTCUT)!
    next()
    expect(trigger).not.toHaveBeenCalled()
    old()
    expect(trigger).toHaveBeenCalledOnce()
    write.resolve()
    await changed
    old()
    next()
    expect(trigger).toHaveBeenCalledTimes(2)
    expect(store.getState().settings.shortcut).toBe(DOUBLE_SHIFT_SHORTCUT)
    expect(electron.callbacks.size).toBe(0)
  })

  it('rolls back a failed write without retiring the prior valid listener', async () => {
    const write = deferred()
    const persist = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(undefined)
    const { shortcuts, electron, doubleShift, trigger, store } = setup(
      LibraryStore.inMemory(persist),
    )
    await shortcuts.start()
    const changed = shortcuts.change(DOUBLE_SHIFT_SHORTCUT)
    const failed = expect(changed).rejects.toThrow('disk full')
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    const stale = doubleShift.callbacks.get(DOUBLE_SHIFT_SHORTCUT)!
    write.reject(new Error('disk full'))
    await failed
    stale()
    electron.callbacks.get(DEFAULT_SHORTCUT)!()
    expect(trigger).toHaveBeenCalledOnce()
    expect(doubleShift.callbacks.size).toBe(0)
    expect(store.getState().settings.shortcut).toBe(DEFAULT_SHORTCUT)
    await shortcuts.change(combination)
    expect(store.getState().settings.shortcut).toBe(combination)
  })

  it('serializes overlapping changes and commits exactly one trigger', async () => {
    const write = deferred()
    const persist = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(undefined)
    const { shortcuts, electron, doubleShift, trigger, store } = setup(
      LibraryStore.inMemory(persist),
    )
    await shortcuts.start()
    const first = shortcuts.change(DOUBLE_SHIFT_SHORTCUT)
    const second = shortcuts.change(combination)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    expect(electron.register).toHaveBeenCalledTimes(1)
    const staleNative = doubleShift.callbacks.get(DOUBLE_SHIFT_SHORTCUT)!
    write.resolve()
    await Promise.all([first, second])
    staleNative()
    electron.callbacks.get(combination)!()
    expect(trigger).toHaveBeenCalledOnce()
    expect(store.getState().settings.shortcut).toBe(combination)
    expect([...electron.callbacks.keys()]).toEqual([combination])
    expect(doubleShift.callbacks.size).toBe(0)
  })

  it('recovers a saved Double Shift preference when permission becomes available', async () => {
    const store = LibraryStore.inMemory()
    await store.execute({ type: 'set-shortcut', shortcut: DOUBLE_SHIFT_SHORTCUT })
    const { shortcuts, doubleShift, electron, trigger } = setup(store)
    doubleShift.register.mockReturnValueOnce(false).mockReturnValueOnce(false)
    await shortcuts.start()
    expect(shortcuts.shortcutError).toContain('Accessibility')
    await shortcuts.recover()
    expect(shortcuts.shortcutError).toContain('Accessibility')
    await shortcuts.recover()
    expect(shortcuts.shortcutError).toBeNull()
    doubleShift.callbacks.get(DOUBLE_SHIFT_SHORTCUT)!()
    expect(trigger).toHaveBeenCalledOnce()
    expect(electron.register).not.toHaveBeenCalled()
    await shortcuts.recover()
    expect(doubleShift.register).toHaveBeenCalledTimes(3)
  })

  it('retries an unchanged saved preference that is no longer registered', async () => {
    const { shortcuts, electron, trigger } = setup()
    await shortcuts.start()
    const old = electron.callbacks.get(DEFAULT_SHORTCUT)!
    electron.callbacks.clear()
    await shortcuts.change(DEFAULT_SHORTCUT)
    old()
    electron.callbacks.get(DEFAULT_SHORTCUT)!()
    expect(trigger).toHaveBeenCalledOnce()
    expect(electron.unregister).not.toHaveBeenCalled()
    await shortcuts.stop()
    expect(electron.callbacks.size).toBe(0)
  })

  it('cleans both listeners immediately during persistence and drains without resurrection', async () => {
    const write = deferred()
    const persist = vi.fn(() => write.promise)
    const { shortcuts, electron, doubleShift, trigger, store } = setup(
      LibraryStore.inMemory(persist),
    )
    await shortcuts.start()
    const old = electron.callbacks.get(DEFAULT_SHORTCUT)!
    const changed = shortcuts.change(DOUBLE_SHIFT_SHORTCUT)
    const queued = shortcuts.change(combination)
    const recovery = shortcuts.recover()
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    const next = doubleShift.callbacks.get(DOUBLE_SHIFT_SHORTCUT)!
    let drained = false
    const stop = shortcuts.stop().then(() => {
      drained = true
    })
    expect(electron.callbacks.size).toBe(0)
    expect(doubleShift.callbacks.size).toBe(0)
    old()
    next()
    await Promise.resolve()
    expect(drained).toBe(false)
    write.resolve()
    await Promise.all([changed, queued, recovery, stop])
    expect(drained).toBe(true)
    expect(trigger).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledOnce()
    expect(store.getState().settings.shortcut).toBe(DOUBLE_SHIFT_SHORTCUT)
    expect(electron.callbacks.size).toBe(0)
    expect(doubleShift.callbacks.size).toBe(0)
  })
})
