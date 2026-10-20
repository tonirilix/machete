import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  session,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { channels, type OpenRequest, type Snapshot } from '../shared/bridge'
import {
  backupSchema,
  commandSchema,
  DOUBLE_SHIFT_SHORTCUT,
  exportBackup,
  MAX_CLIP_LENGTH,
} from '../shared/library'
import { LibraryStore } from './store'
import {
  readSelection,
  requestSelectionAccess,
  selectionAccess,
  selectionNotice,
  startDoubleShift,
  stopDoubleShift,
  isDoubleShiftRegistered,
} from './selection'

const directory = dirname(fileURLToPath(import.meta.url))
app.setName('Cliptoboards')
app.setPath(
  'userData',
  process.env.CLIPTOBOARDS_DATA_DIR || join(app.getPath('appData'), 'Cliptoboards'),
)
protocol.registerSchemesAsPrivileged([
  { scheme: 'cliptoboards', privileges: { secure: true, standard: true, supportFetchAPI: true } },
])

let window: BrowserWindow
let tray: Tray
let store: LibraryStore
let quitting = false
let shortcutError: string | null = null
let startup: Promise<void>
let selectionTask: Promise<void> | null = null

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

function snapshot(): Snapshot {
  return { library: store.getState(), shortcutError }
}

function report(error: unknown) {
  dialog.showErrorBox(
    'Cliptoboards',
    error instanceof Error ? error.message : 'Something went wrong.',
  )
}

async function show(mode: OpenRequest['mode'], notice?: string) {
  // loadURL can resolve while isLoading() is still true, after did-finish-load
  // has already fired. Share startup's promise instead of waiting for that event again.
  await startup
  if (quitting) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  window.webContents.send(channels.openRequested, {
    mode,
    snapshot: snapshot(),
    notice,
  } satisfies OpenRequest)
}

async function capture(fromClipboard: boolean): Promise<Snapshot> {
  await store.whenIdle()
  if (fromClipboard) {
    const text = await clipboard.readText()
    if (text.length > MAX_CLIP_LENGTH) throw new Error('The copied text is too large to capture.')
    if (text.length) await store.execute({ type: 'append-capture', text })
    else await store.execute({ type: 'begin-capture', text: '' })
  } else {
    await store.execute({ type: 'begin-capture', text: '' })
  }
  return snapshot()
}

async function captureAndShow() {
  try {
    await capture(true)
    await show('capture')
  } catch (error) {
    report(error)
  }
}

export async function captureSelectionAndShow() {
  if (quitting || selectionTask) return
  selectionTask = (async () => {
    try {
      if (process.platform !== 'darwin') return await captureAndShow()
      // Read before showing or focusing any Cliptoboards window.
      const result = await readSelection()
      if (quitting) return
      if (result.status === 'permission-required') return await show('settings')
      if (result.status === 'captured' && result.text.length) {
        await store.execute({ type: 'append-capture', text: result.text })
        await show('capture')
      } else {
        await capture(false)
        await show('capture', selectionNotice(result.status))
      }
    } catch (error) {
      if (!quitting) {
        await show('browse', error instanceof Error ? error.message : 'Selection capture failed.')
      }
    }
  })().finally(() => {
    selectionTask = null
  })
  await selectionTask
}

function registerShortcut(accelerator: string): boolean {
  try {
    if (accelerator === DOUBLE_SHIFT_SHORTCUT) {
      return startDoubleShift(() => {
        if (!quitting && store.getState().settings.shortcut === DOUBLE_SHIFT_SHORTCUT) {
          void captureSelectionAndShow()
        }
      })
    }
    return globalShortcut.register(accelerator, () => void captureSelectionAndShow())
  } catch {
    return false
  }
}

function isShortcutRegistered(shortcut: string) {
  return shortcut === DOUBLE_SHIFT_SHORTCUT
    ? isDoubleShiftRegistered()
    : globalShortcut.isRegistered(shortcut)
}

function unregisterShortcut(shortcut: string) {
  if (shortcut === DOUBLE_SHIFT_SHORTCUT) stopDoubleShift()
  else globalShortcut.unregister(shortcut)
}

function refreshSelectionAccess() {
  const access = selectionAccess()
  if (
    access.granted &&
    store.getState().settings.shortcut === DOUBLE_SHIFT_SHORTCUT &&
    !isDoubleShiftRegistered()
  ) {
    if (registerShortcut(DOUBLE_SHIFT_SHORTCUT)) shortcutError = null
  }
  return access
}

function handle(channel: string, handler: (payload: unknown) => unknown) {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('This request did not come from the app window.')
    }
    try {
      return await handler(payload)
    } catch (error) {
      if (error instanceof z.ZodError) throw new Error(error.issues[0]?.message || 'Invalid data.')
      throw error
    }
  })
}

function installHandlers() {
  handle(channels.state, async () => {
    await store.whenIdle()
    return snapshot()
  })
  handle(channels.capture, (payload) => capture(z.boolean().parse(payload)))
  handle(channels.selectionAccess, async (payload) => {
    if (z.boolean().parse(payload)) await requestSelectionAccess()
    return refreshSelectionAccess()
  })
  handle(channels.command, async (payload) => {
    const command = commandSchema.parse(payload)
    if (command.type !== 'set-shortcut') {
      await store.execute(command)
      return snapshot()
    }
    const previous = store.getState().settings.shortcut
    const next = command.shortcut
    if (next === previous && isShortcutRegistered(previous)) return snapshot()
    if (!registerShortcut(next)) {
      if (next === DOUBLE_SHIFT_SHORTCUT) {
        throw new Error(
          'Double Shift requires macOS Accessibility access. Enable selection capture in Settings first.',
        )
      }
      throw new Error('That shortcut is unavailable. Try another key combination.')
    }
    try {
      await store.execute(command)
    } catch (error) {
      if (next !== previous) unregisterShortcut(next)
      throw error
    }
    if (next !== previous) unregisterShortcut(previous)
    shortcutError = null
    return snapshot()
  })
  handle(channels.copy, async (payload) => {
    const text = z
      .string()
      .max(MAX_CLIP_LENGTH * 20)
      .parse(payload)
    await clipboard.writeText(text)
  })
  handle(channels.hide, () => window.hide())
  handle(channels.export, async () => {
    await store.whenIdle()
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Export your collection',
      defaultPath: join(
        app.getPath('downloads'),
        `cliptoboards-${new Date().toISOString().slice(0, 10)}.json`,
      ),
      filters: [{ name: 'Cliptoboards collection', extensions: ['json'] }],
    })
    if (canceled || !filePath) return false
    await writeFile(filePath, JSON.stringify(exportBackup(store.getState()), null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    return true
  })
  handle(channels.import, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
      title: 'Import a collection',
      properties: ['openFile'],
      filters: [{ name: 'Cliptoboards collection', extensions: ['json'] }],
    })
    if (canceled || !filePaths[0]) return null
    if ((await stat(filePaths[0])).size > 64 * 1024 * 1024) {
      throw new Error('This collection file is too large to import.')
    }
    let backup: unknown
    try {
      backup = backupSchema.parse(JSON.parse(await readFile(filePaths[0], 'utf8')))
    } catch {
      throw new Error('This is not a supported Cliptoboards collection. Your library is unchanged.')
    }
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message: 'Replace your current collection?',
      detail:
        'Importing replaces your boards, clips, Trash, and unfinished draft. Export your current collection first if you want to keep it.',
      buttons: ['Cancel', 'Replace collection'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (response !== 1) return null
    await store.restore(backup)
    return snapshot()
  })
}

async function start() {
  await app.whenReady()
  store = await LibraryStore.open(join(app.getPath('userData'), 'collection.json'))
  const rendererRoot = resolve(directory, '../renderer')
  protocol.handle('cliptoboards', (request) => {
    const url = new URL(request.url)
    const target = resolve(rendererRoot, `.${decodeURIComponent(url.pathname)}`)
    if (url.host !== 'app' || !target.startsWith(`${rendererRoot}${sep}`)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(target).toString())
  })
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  window = new BrowserWindow({
    width: 760,
    height: 760,
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: 'Cliptoboards',
    backgroundColor: '#f7f8f5',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 19 },
    webPreferences: {
      preload: join(directory, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window.hide()
    }
  })
  installHandlers()

  const image = nativeImage.createFromPath(join(directory, '../../resources/trayTemplate.png'))
  image.setTemplateImage(true)
  tray = new Tray(image.resize({ width: 18, height: 18 }))
  tray.setToolTip('Cliptoboards')
  tray.on('click', () => void show('browse'))
  const trayMenu = Menu.buildFromTemplate([
    { label: 'Open Cliptoboards', click: () => void show('browse') },
    { label: 'Capture clipboard', click: () => void captureAndShow() },
    { type: 'separator' },
    { label: 'Quit Cliptoboards', role: 'quit' },
  ])
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu))
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Cliptoboards',
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
      },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]),
  )
  const accelerator = store.getState().settings.shortcut
  if (!registerShortcut(accelerator)) {
    shortcutError =
      accelerator === DOUBLE_SHIFT_SHORTCUT
        ? 'Enable Accessibility in Settings to use Double Shift.'
        : 'Your capture shortcut is unavailable. Choose a different one in Settings.'
  }
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  await window.loadURL(developmentUrl || 'cliptoboards://app/index.html')
}

if (hasLock) {
  app.on('second-instance', () => {
    void show('browse')
  })
  app.on('activate', () => {
    // Focusing our own capture window also activates the app. Preserve its mode.
    if (window?.isVisible() && !window.isMinimized() && !app.isHidden()) {
      window.focus()
      return
    }
    void show('browse')
  })
  app.on('window-all-closed', () => {})
  app.on('before-quit', (event) => {
    if (quitting || !store) return
    event.preventDefault()
    quitting = true
    stopDoubleShift()
    // Let an in-flight Copy restore the clipboard before exiting.
    void Promise.resolve(selectionTask)
      .then(() => store.whenIdle())
      .finally(() => app.quit())
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
  startup = start().catch((error) => {
    // Closing the app can reject its initial page load. Shutdown is already
    // underway; a modal startup error here would prevent it from finishing.
    if (quitting) return
    report(error)
    quitting = true
    app.quit()
  })
  if (!process.argv.includes('--hidden')) void show('browse')
}
