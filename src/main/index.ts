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
  exportBackup,
  MAX_CLIP_LENGTH,
  draftSchema,
} from '../shared/library'
import { LibraryStore } from './store'
import { DraftQuitDrain } from './draft-quit-drain'
import { CaptureController } from './capture'
import { ShortcutController } from './shortcuts'
import {
  readSelection,
  requestSelectionAccess,
  selectionAccess,
  startDoubleShift,
  stopDoubleShift,
  isDoubleShiftRegistered,
} from './selection'

const directory = dirname(fileURLToPath(import.meta.url))
app.setName('Machete')
app.setPath(
  'userData',
  // Preserve the existing collection and the previous data-directory override.
  process.env.MACHETE_DATA_DIR ||
    process.env.CLIPTOBOARDS_DATA_DIR ||
    join(app.getPath('appData'), 'Cliptoboards'),
)
protocol.registerSchemesAsPrivileged([
  { scheme: 'machete', privileges: { secure: true, standard: true, supportFetchAPI: true } },
])

let window: BrowserWindow | null = null
let windowReady: Promise<void> | null = null
let tray: Tray | null = null
let store: LibraryStore
let quitPhase: 'running' | 'draining' | 'quitting' = 'running'
const draftQuit = new DraftQuitDrain((request) =>
  requireWindow().webContents.send(channels.draftDrainRequested, request),
)
let startup: Promise<void>
let shortcuts: ShortcutController
let captures: CaptureController

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

function snapshot(): Snapshot {
  return {
    library: store.getState(),
    revision: store.getRevision(),
    draftWriteId: store.getDraftWriteId(),
    shortcutError: shortcuts.shortcutError,
  }
}

function report(error: unknown) {
  if (quitPhase === 'quitting') return
  dialog.showErrorBox('Machete', error instanceof Error ? error.message : 'Something went wrong.')
}

function requireWindow() {
  const current = window
  if (!current) throw new Error('The app window is no longer available.')
  return current
}

async function readyToPresent() {
  await startup
  if (quitPhase === 'running') await (window ? windowReady : createWindow())
}

async function show(mode: OpenRequest['mode'], notice?: string) {
  await readyToPresent()
  present(mode, notice)
}

function present(mode: OpenRequest['mode'], notice?: string) {
  if (quitPhase !== 'running') return
  const current = window
  if (!current) return
  if (current.isMinimized()) current.restore()
  current.show()
  current.focus()
  current.webContents.send(channels.openRequested, {
    mode,
    snapshot: snapshot(),
    notice,
  } satisfies OpenRequest)
}

function browse() {
  if (quitPhase === 'running') void show('browse').catch(report)
}

async function prepareToQuit() {
  if (quitPhase !== 'running') return
  quitPhase = 'draining'
  try {
    await draftQuit.drain()
  } catch (error) {
    quitPhase = 'running'
    if (window) {
      window.webContents.send(channels.draftDrainCancelled)
      window.show()
    } else {
      browse()
    }
    report(error)
    return
  }
  quitPhase = 'quitting'
  try {
    // Both cleanups must settle so native Copy can restore the clipboard even
    // if another cleanup throws. Electron closes the window after we resume quit.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => shortcuts?.stop()),
      Promise.resolve().then(() => captures?.stop()),
    ])
    await store?.whenIdle()
    for (const result of results) {
      if (result.status === 'rejected') console.error('Could not finish shutdown:', result.reason)
    }
  } catch (error) {
    console.error('Could not finish shutdown:', error)
  } finally {
    app.quit()
  }
}

export function captureSelectionAndShow() {
  if (quitPhase !== 'running' || !captures) return Promise.resolve()
  return captures.request('selection')
}

async function refreshSelectionAccess() {
  const access = selectionAccess()
  if (quitPhase === 'running') await shortcuts.recover()
  return access
}

function handle(channel: string, handler: (payload: unknown) => unknown) {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown) => {
    const current = window
    if (
      !current ||
      event.sender !== current.webContents ||
      event.senderFrame !== current.webContents.mainFrame
    ) {
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
  handle(channels.draftDrainRegistration, (payload) => {
    const request = z
      .object({ registrationId: z.string().uuid(), active: z.boolean() })
      .parse(payload)
    draftQuit.register(request.registrationId, request.active)
  })
  handle(channels.draftDrainCompleted, (payload) => {
    const request = z
      .object({
        id: z.string().uuid(),
        registrationId: z.string().uuid(),
        error: z.string().max(10_000).optional(),
      })
      .parse(payload)
    draftQuit.complete(request, request.error)
  })
  handle(channels.state, async () => {
    await refreshSelectionAccess()
    await store.whenIdle()
    return snapshot()
  })
  handle(channels.editDraft, async (payload) => {
    const request = z
      .object({
        id: z.string().min(1).max(100),
        revision: z.number().int().nonnegative(),
        action: z.enum(['update', 'save', 'discard']),
        draft: draftSchema.optional(),
      })
      .parse(payload)
    const result = await store.editDraft(request)
    return {
      accepted: result.accepted,
      snapshot: {
        library: result.library,
        revision: result.revision,
        draftWriteId: result.draftWriteId,
        shortcutError: shortcuts.shortcutError,
      },
    }
  })
  handle(channels.capture, async (payload) => {
    if (quitPhase !== 'running') throw new Error('Machete is preparing to quit.')
    await captures.request(z.boolean().parse(payload) ? 'clipboard' : 'empty', false)
    return snapshot()
  })
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
    await shortcuts.change(command.shortcut)
    return snapshot()
  })
  handle(channels.copy, async (payload) => {
    const text = z
      .string()
      .max(MAX_CLIP_LENGTH * 20)
      .parse(payload)
    await clipboard.writeText(text)
  })
  handle(channels.hide, () => window?.hide())
  handle(channels.export, async () => {
    await store.whenIdle()
    const { canceled, filePath } = await dialog.showSaveDialog(requireWindow(), {
      title: 'Export your collection',
      defaultPath: join(
        app.getPath('downloads'),
        `machete-${new Date().toISOString().slice(0, 10)}.json`,
      ),
      filters: [{ name: 'Machete collection', extensions: ['json'] }],
    })
    if (canceled || !filePath) return false
    await writeFile(filePath, JSON.stringify(exportBackup(store.getState()), null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    return true
  })
  handle(channels.import, async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(requireWindow(), {
      title: 'Import a collection',
      properties: ['openFile'],
      filters: [{ name: 'Machete collection', extensions: ['json'] }],
    })
    if (canceled || !filePaths[0]) return null
    if ((await stat(filePaths[0])).size > 64 * 1024 * 1024) {
      throw new Error('This collection file is too large to import.')
    }
    let backup: unknown
    try {
      backup = backupSchema.parse(JSON.parse(await readFile(filePaths[0], 'utf8')))
    } catch {
      throw new Error('This is not a supported Machete collection. Your library is unchanged.')
    }
    const { response } = await dialog.showMessageBox(requireWindow(), {
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

function createWindow() {
  const created = new BrowserWindow({
    width: 760,
    height: 760,
    minWidth: 480,
    minHeight: 560,
    show: false,
    title: 'Machete',
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
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  window = created
  created.on('close', (event) => {
    if (quitPhase !== 'quitting') {
      event.preventDefault()
      created.hide()
    }
  })
  created.on('closed', () => {
    if (window !== created) return
    window = null
    windowReady = null
    draftQuit.disconnect()
  })
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  windowReady = created.loadURL(developmentUrl || 'machete://app/index.html').catch((error) => {
    // Destruction during quit or recovery can abort an in-flight page load.
    if (created.isDestroyed()) return
    created.destroy()
    throw error
  })
  return windowReady
}

async function start() {
  await app.whenReady()
  if (quitPhase === 'quitting') return
  store = await LibraryStore.open(join(app.getPath('userData'), 'collection.json'))
  if (quitPhase !== 'running') return
  captures = new CaptureController(
    store,
    {
      selection:
        process.platform === 'darwin'
          ? readSelection
          : async () => ({ status: 'captured', text: await clipboard.readText() }),
      clipboard: () => clipboard.readText(),
    },
    { ready: readyToPresent, show: present },
  )
  shortcuts = new ShortcutController(
    store,
    {
      electron: globalShortcut,
      doubleShift: {
        register: (_shortcut, callback) => startDoubleShift(callback),
        unregister: () => stopDoubleShift(),
        isRegistered: () => isDoubleShiftRegistered(),
      },
    },
    () => void captureSelectionAndShow(),
  )
  const rendererRoot = resolve(directory, '../renderer')
  protocol.handle('machete', (request) => {
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
  installHandlers()

  const image = nativeImage.createFromPath(join(directory, '../../resources/trayTemplate.png'))
  image.setTemplateImage(true)
  tray = new Tray(image.resize({ width: 18, height: 18 }))
  tray.setToolTip('Machete')
  tray.on('click', browse)
  const trayMenu = Menu.buildFromTemplate([
    { label: 'Open Machete', click: browse },
    {
      label: 'Capture clipboard',
      click: () => {
        if (quitPhase === 'running') void captures.request('clipboard').catch(report)
      },
    },
    { type: 'separator' },
    { label: 'Quit Machete', role: 'quit' },
  ])
  tray.on('right-click', () => {
    if (quitPhase === 'running' && tray && !tray.isDestroyed()) tray.popUpContextMenu(trayMenu)
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Machete',
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
      },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]),
  )
  await shortcuts.start()
  if (quitPhase === 'running') await createWindow()
}

if (hasLock) {
  app.on('second-instance', browse)
  app.on('activate', () => {
    if (quitPhase !== 'running') return
    const current = window
    // Focusing our own capture window also activates the app. Preserve its mode.
    if (current?.isVisible() && !current.isMinimized() && !app.isHidden()) {
      current.focus()
      return
    }
    browse()
  })
  app.on('window-all-closed', () => {})
  app.on('before-quit', (event) => {
    if (quitPhase === 'quitting') return
    event.preventDefault()
    void prepareToQuit()
  })
  app.on('will-quit', () => {
    tray?.destroy()
    tray = null
    globalShortcut.unregisterAll()
  })
  startup = start().catch((error) => {
    if (quitPhase === 'quitting') return
    report(error)
    void prepareToQuit()
  })
  if (!process.argv.includes('--hidden')) browse()
}
