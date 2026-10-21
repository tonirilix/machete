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

let window: BrowserWindow
let tray: Tray
let store: LibraryStore
let quitting = false
let preparingQuit = false
const draftQuit = new DraftQuitDrain((request) =>
  window.webContents.send(channels.draftDrainRequested, request),
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
  dialog.showErrorBox('Machete', error instanceof Error ? error.message : 'Something went wrong.')
}

async function show(mode: OpenRequest['mode'], notice?: string) {
  // loadURL can resolve while isLoading() is still true, after did-finish-load
  // has already fired. Share startup's promise instead of waiting for that event again.
  await startup
  present(mode, notice)
}

function present(mode: OpenRequest['mode'], notice?: string) {
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

export function captureSelectionAndShow() {
  if (preparingQuit || quitting) return Promise.resolve()
  return captures.request('selection')
}

async function refreshSelectionAccess() {
  const access = selectionAccess()
  if (access.granted) await shortcuts.recover()
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
    if (preparingQuit || quitting) throw new Error('Machete is preparing to quit.')
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
  handle(channels.hide, () => window.hide())
  handle(channels.export, async () => {
    await store.whenIdle()
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
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
    const { canceled, filePaths } = await dialog.showOpenDialog(window, {
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
  captures = new CaptureController(
    store,
    {
      selection:
        process.platform === 'darwin'
          ? readSelection
          : async () => ({ status: 'captured', text: await clipboard.readText() }),
      clipboard: () => clipboard.readText(),
    },
    { ready: () => startup, show: present },
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
  window = new BrowserWindow({
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
  tray.setToolTip('Machete')
  tray.on('click', () => void show('browse'))
  const trayMenu = Menu.buildFromTemplate([
    { label: 'Open Machete', click: () => void show('browse') },
    {
      label: 'Capture clipboard',
      click: () => {
        if (!preparingQuit && !quitting) void captures.request('clipboard').catch(report)
      },
    },
    { type: 'separator' },
    { label: 'Quit Machete', role: 'quit' },
  ])
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu))
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
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  await window.loadURL(developmentUrl || 'machete://app/index.html')
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
    if (preparingQuit) return
    preparingQuit = true
    void (async () => {
      try {
        await draftQuit.drain()
      } catch (error) {
        preparingQuit = false
        if (!window.isDestroyed()) {
          window.webContents.send(channels.draftDrainCancelled)
          window.show()
        }
        report(error)
        return
      }
      quitting = true
      await Promise.all([shortcuts?.stop(), captures?.stop()])
      await store.whenIdle()
      app.quit()
    })().catch(report)
  })
  app.on('will-quit', () => void shortcuts?.stop())
  startup = start().catch((error) => {
    // Closing the app can reject its initial page load. Shutdown is already
    // underway; a modal startup error here would prevent it from finishing.
    if (quitting) return
    report(error)
    quitting = true
    void shortcuts?.stop()
    app.quit()
  })
  if (!process.argv.includes('--hidden')) void show('browse')
}
