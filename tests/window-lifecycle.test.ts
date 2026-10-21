import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { channels } from '../src/shared/bridge'
import { createLibrary, DEFAULT_SHORTCUT, DOUBLE_SHIFT_SHORTCUT } from '../src/shared/library'
import type { SelectionResult } from '../src/main/selection'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

// Execute the actual main entry point without starting Electron or taking focus.
// Native window methods throw after destruction. Tests deliver lifecycle events
// explicitly; this fake does not implement Electron's quit or process-exit logic.
async function desktop({
  ready = Promise.resolve(),
  load = async () => {},
  permission = { granted: false },
  shortcut = DEFAULT_SHORTCUT,
  selection = async (): Promise<SelectionResult> => ({ status: 'captured', text: 'selected text' }),
} = {}) {
  vi.resetModules()
  const directory = await mkdtemp(join(tmpdir(), 'machete-window-test-'))
  directories.push(directory)
  vi.stubEnv('MACHETE_DATA_DIR', directory)
  await writeFile(
    join(directory, 'collection.json'),
    JSON.stringify({ ...createLibrary(), settings: { shortcut } }),
  )
  const windows: Window[] = []
  const trays: Tray[] = []
  const handlers = new Map<string, (event: object, payload: unknown) => Promise<unknown>>()
  const event = () => ({
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  })
  class Window extends EventEmitter {
    destroyed = false
    visible = false
    minimized = false
    webContents = {
      mainFrame: {},
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
    }
    loadURL = vi.fn(() => load())
    focus = vi.fn(() => this.check())
    constructor() {
      super()
      windows.push(this)
    }
    check() {
      if (this.destroyed) throw new TypeError('Object has been destroyed')
    }
    isDestroyed() {
      return this.destroyed
    }
    isVisible() {
      this.check()
      return this.visible
    }
    isMinimized() {
      this.check()
      return this.minimized
    }
    restore() {
      this.check()
      this.minimized = false
    }
    show() {
      this.check()
      this.visible = true
    }
    hide() {
      this.check()
      this.visible = false
    }
    close() {
      this.check()
      const close = event()
      this.emit('close', close)
      if (!close.defaultPrevented) this.destroy()
    }
    destroy() {
      this.destroyed = true
      this.visible = false
      this.emit('closed')
    }
  }
  class Tray extends EventEmitter {
    destroyed = false
    constructor() {
      super()
      trays.push(this)
    }
    setToolTip() {}
    popUpContextMenu() {
      if (this.destroyed) throw new TypeError('Object has been destroyed')
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
  }
  const app = Object.assign(new EventEmitter(), {
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: () => directory,
    requestSingleInstanceLock: () => true,
    whenReady: () => ready,
    isHidden: () => false,
    quit: vi.fn(),
  })
  const image = {
    setTemplateImage() {},
    resize() {
      return image
    },
  }
  const dialog = { showErrorBox: vi.fn() }
  const globalShortcut = {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    isRegistered: vi.fn(() => true),
    unregisterAll: vi.fn(),
  }
  vi.doMock('electron', () => ({
    app,
    BrowserWindow: Window,
    Tray,
    dialog,
    globalShortcut,
    ipcMain: {
      handle: (name: string, handler: (event: object, payload: unknown) => Promise<unknown>) =>
        handlers.set(name, handler),
    },
    clipboard: { readText: async () => '' },
    Menu: { buildFromTemplate: (template: unknown) => template, setApplicationMenu() {} },
    nativeImage: { createFromPath: () => image },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    net: {},
  }))
  let nativeActive = false
  const startDoubleShift = vi.fn(() => {
    if (!permission.granted) return false
    nativeActive = true
    return true
  })
  vi.doMock('../src/main/selection', () => ({
    readSelection: selection,
    selectionAccess: () => ({ granted: permission.granted, supported: true }),
    requestSelectionAccess: vi.fn(),
    startDoubleShift,
    stopDoubleShift: vi.fn(() => {
      nativeActive = false
    }),
    isDoubleShiftRegistered: () => nativeActive && permission.granted,
  }))
  const main = await import('../src/main/index')
  const invoke = (window: Window, channel: string, payload: unknown) =>
    handlers.get(channel)!(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      payload,
    )
  const loaded = async () => {
    await vi.waitFor(() => expect(windows.at(-1)?.visible).toBe(true))
    return windows.at(-1)!
  }
  const requestQuit = () => {
    const quit = event()
    app.emit('before-quit', quit)
    return quit
  }
  return {
    app,
    windows,
    trays,
    dialog,
    globalShortcut,
    invoke,
    loaded,
    main,
    startDoubleShift,
    requestQuit,
  }
}

it('handles Dock activation after the native window has been destroyed', async () => {
  const d = await desktop()
  const first = await d.loaded()
  first.destroy()
  expect(() => d.app.emit('activate')).not.toThrow()
  await vi.waitFor(() => expect(d.windows).toHaveLength(2))
  const reopened = await d.loaded()
  expect(reopened).not.toBe(first)
  expect(reopened.loadURL).toHaveBeenCalledOnce()
  expect(d.dialog.showErrorBox).not.toHaveBeenCalled()
})

it('hides a closed window and reuses it for tray and second-instance opens', async () => {
  const d = await desktop()
  const window = await d.loaded()
  window.close()
  expect(window.destroyed).toBe(false)
  expect(window.visible).toBe(false)
  d.trays[0].emit('click')
  await d.loaded()
  window.hide()
  d.app.emit('second-instance')
  await d.loaded()
  expect(d.windows).toHaveLength(1)
  expect(d.app.quit).not.toHaveBeenCalled()
})

it('recreates one window for overlapping tray and Dock opens and rejects the old renderer', async () => {
  let loads = 0
  let finish!: () => void
  const d = await desktop({
    load: () =>
      ++loads === 1
        ? Promise.resolve()
        : new Promise<void>((done) => {
            finish = done
          }),
  })
  const first = await d.loaded()
  first.destroy()
  d.trays[0].emit('click')
  d.app.emit('activate')
  d.app.emit('second-instance')
  await vi.waitFor(() => expect(d.windows).toHaveLength(2))
  expect(d.windows[1].visible).toBe(false)
  finish()
  const replacement = await d.loaded()
  expect(d.windows).toHaveLength(2)
  expect(replacement).not.toBe(first)
  await expect(d.invoke(first, channels.state, undefined)).rejects.toThrow('app window')
  await expect(d.invoke(replacement, channels.state, undefined)).resolves.toHaveProperty('library')
})

it('can capture into a replacement window', async () => {
  const d = await desktop()
  const first = await d.loaded()
  first.destroy()
  await d.main.captureSelectionAndShow()
  const replacement = await d.loaded()
  expect(replacement).not.toBe(first)
  expect(replacement.webContents.send).toHaveBeenCalledWith(
    channels.openRequested,
    expect.objectContaining({
      mode: 'saved',
      snapshot: expect.objectContaining({
        library: expect.objectContaining({
          clips: [expect.objectContaining({ text: 'selected text', boardId: 'inbox' })],
          draft: null,
        }),
      }),
    }),
  )
})

it('drains once, ignores reopen events during quit, and then lets Electron close the window', async () => {
  const d = await desktop()
  const window = await d.loaded()
  const tray = d.trays[0]
  const registrationId = crypto.randomUUID()
  await d.invoke(window, channels.draftDrainRegistration, { registrationId, active: true })
  window.focus.mockClear()
  d.requestQuit()
  d.requestQuit()
  d.app.emit('activate')
  d.app.emit('second-instance')
  tray.emit('click')
  await Promise.resolve()
  expect(window.focus).not.toHaveBeenCalled()
  expect(d.app.quit).not.toHaveBeenCalled()
  const drains = window.webContents.send.mock.calls.filter(
    ([channel]) => channel === channels.draftDrainRequested,
  )
  expect(drains).toHaveLength(1)
  window.on('closed', () => {
    expect(() => d.app.emit('activate')).not.toThrow()
    tray.emit('click')
  })
  await d.invoke(window, channels.draftDrainCompleted, drains[0][1])
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
  expect(d.requestQuit().defaultPrevented).toBe(false)
  window.close()
  d.app.emit('will-quit')
  expect(tray.destroyed).toBe(true)
  expect(d.windows).toHaveLength(1)
  expect(window.destroyed).toBe(true)
  expect(d.globalShortcut.unregisterAll).toHaveBeenCalledOnce()
  expect(d.dialog.showErrorBox).not.toHaveBeenCalled()
})

it('keeps the app usable when flushing a draft fails, then allows another quit', async () => {
  const d = await desktop()
  const window = await d.loaded()
  await d.invoke(window, channels.draftDrainRegistration, {
    registrationId: crypto.randomUUID(),
    active: true,
  })
  window.hide()
  d.requestQuit()
  const request = window.webContents.send.mock.calls.find(
    ([channel]) => channel === channels.draftDrainRequested,
  )![1]
  await d.invoke(window, channels.draftDrainCompleted, { ...request, error: 'Disk is full' })
  await vi.waitFor(() =>
    expect(d.dialog.showErrorBox).toHaveBeenCalledWith('Machete', 'Disk is full'),
  )
  expect(d.app.quit).not.toHaveBeenCalled()
  expect(window.visible).toBe(true)
  expect(d.trays[0].destroyed).toBe(false)
  d.requestQuit()
  const requests = window.webContents.send.mock.calls.filter(
    ([channel]) => channel === channels.draftDrainRequested,
  )
  await d.invoke(window, channels.draftDrainCompleted, requests[1][1])
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
})

it('drops a destroyed editor registration so quitting does not wait on a dead renderer', async () => {
  const d = await desktop()
  const window = await d.loaded()
  await d.invoke(window, channels.draftDrainRegistration, {
    registrationId: crypto.randomUUID(),
    active: true,
  })
  window.destroy()
  d.requestQuit()
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
  expect(
    window.webContents.send.mock.calls.some(
      ([channel]) => channel === channels.draftDrainRequested,
    ),
  ).toBe(false)
  d.app.emit('will-quit')
  expect(d.trays[0].destroyed).toBe(true)
})

it('recovers if the window is destroyed while a draft flush is pending', async () => {
  const d = await desktop()
  const window = await d.loaded()
  await d.invoke(window, channels.draftDrainRegistration, {
    registrationId: crypto.randomUUID(),
    active: true,
  })
  d.requestQuit()
  window.destroy()
  await vi.waitFor(() => expect(d.windows).toHaveLength(2))
  await d.loaded()
  expect(d.app.quit).not.toHaveBeenCalled()
  expect(d.dialog.showErrorBox).toHaveBeenCalledWith(
    'Machete',
    expect.stringContaining('disconnected'),
  )
  d.requestQuit()
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
})

it('does not create a window or tray when quit precedes app readiness', async () => {
  let resolve!: () => void
  const d = await desktop({
    ready: new Promise<void>((done) => {
      resolve = done
    }),
  })
  d.requestQuit()
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
  resolve()
  await new Promise((done) => setTimeout(done, 10))
  expect(d.windows).toHaveLength(0)
  expect(d.trays).toHaveLength(0)
  expect(d.dialog.showErrorBox).not.toHaveBeenCalled()
})

it('quits during initial page loading without a startup error or replacement window', async () => {
  let reject!: (error: Error) => void
  const d = await desktop({
    load: () =>
      new Promise<void>((_, fail) => {
        reject = fail
      }),
  })
  await vi.waitFor(() => expect(d.windows).toHaveLength(1))
  d.windows[0].on('closed', () => reject(new Error('ERR_ABORTED')))
  d.requestQuit()
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
  d.windows[0].close()
  d.app.emit('will-quit')
  await Promise.resolve()
  expect(d.windows).toHaveLength(1)
  expect(d.trays[0].destroyed).toBe(true)
  expect(d.dialog.showErrorBox).not.toHaveBeenCalled()
})

it('waits for in-flight native capture cleanup without allowing shutdown reactivation', async () => {
  let finish!: (result: SelectionResult) => void
  const selection = vi.fn(
    () =>
      new Promise<SelectionResult>((done) => {
        finish = done
      }),
  )
  const d = await desktop({ selection })
  const window = await d.loaded()
  const capture = d.main.captureSelectionAndShow()
  await vi.waitFor(() => expect(selection).toHaveBeenCalledOnce())
  window.focus.mockClear()
  d.requestQuit()
  await vi.waitFor(() => expect(d.globalShortcut.unregister).toHaveBeenCalledOnce())
  d.app.emit('activate')
  d.trays[0].emit('click')
  expect(d.app.quit).not.toHaveBeenCalled()
  expect(window.focus).not.toHaveBeenCalled()
  finish({ status: 'captured', text: 'selection after cleanup' })
  await capture
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
  expect(d.windows).toHaveLength(1)
})

it('drains native capture even if shortcut teardown throws, then finishes quitting', async () => {
  let finish!: (result: SelectionResult) => void
  const selection = vi.fn(
    () =>
      new Promise<SelectionResult>((done) => {
        finish = done
      }),
  )
  const d = await desktop({ selection })
  await d.loaded()
  const capture = d.main.captureSelectionAndShow()
  await vi.waitFor(() => expect(selection).toHaveBeenCalledOnce())
  const error = new Error('Native shortcut teardown failed')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    d.globalShortcut.unregister.mockImplementationOnce(() => {
      throw error
    })
    d.requestQuit()
    await vi.waitFor(() => expect(d.globalShortcut.unregister).toHaveBeenCalledOnce())
    expect(d.app.quit).not.toHaveBeenCalled()
    expect(d.trays[0].destroyed).toBe(false)
    finish({ status: 'no-selection', text: '' })
    await capture
    await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
    expect(log).toHaveBeenCalledWith('Could not finish shutdown:', error)
    expect(d.dialog.showErrorBox).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})

it('reports a genuine initial load failure once and cleans up the app', async () => {
  const d = await desktop({
    load: async () => {
      throw new Error('Renderer file is missing')
    },
  })
  await vi.waitFor(() => expect(d.app.quit).toHaveBeenCalledOnce())
  expect(d.dialog.showErrorBox).toHaveBeenCalledExactlyOnceWith(
    'Machete',
    'Renderer file is missing',
  )
  d.app.emit('will-quit')
  expect(d.trays[0].destroyed).toBe(true)
  expect(d.windows[0].destroyed).toBe(true)
})

it('rechecks Accessibility and clears the startup warning after permission is granted', async () => {
  const permission = { granted: false }
  const d = await desktop({ permission, shortcut: DOUBLE_SHIFT_SHORTCUT })
  const window = await d.loaded()
  await expect(d.invoke(window, channels.state, undefined)).resolves.toHaveProperty(
    'shortcutError',
    expect.stringContaining('Accessibility'),
  )
  permission.granted = true
  await expect(d.invoke(window, channels.state, undefined)).resolves.toHaveProperty(
    'shortcutError',
    null,
  )
  const attempts = d.startDoubleShift.mock.calls.length
  await d.invoke(window, channels.state, undefined)
  expect(d.startDoubleShift).toHaveBeenCalledTimes(attempts)
})

it('reports revoked access and clears the warning when an existing monitor becomes trusted again', async () => {
  const permission = { granted: true }
  const d = await desktop({ permission, shortcut: DOUBLE_SHIFT_SHORTCUT })
  const window = await d.loaded()
  await expect(d.invoke(window, channels.state, undefined)).resolves.toHaveProperty(
    'shortcutError',
    null,
  )
  permission.granted = false
  await expect(d.invoke(window, channels.state, undefined)).resolves.toHaveProperty(
    'shortcutError',
    expect.stringContaining('Accessibility'),
  )
  permission.granted = true
  await expect(d.invoke(window, channels.state, undefined)).resolves.toHaveProperty(
    'shortcutError',
    null,
  )
})
