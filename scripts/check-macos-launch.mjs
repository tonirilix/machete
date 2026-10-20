import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin')
  throw new Error('This check requires macOS and a desktop session.')

const directory = await mkdtemp(join(tmpdir(), 'machete-launch-'))
const bundle = join(directory, 'Machete Launch Check.app')
const stderr = join(directory, 'stderr.log')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
let inspector
let processId
let nativeLog = ''

function run(command, args) {
  const result = spawnSync(command, args, { env: environment, encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || `${command} failed`)
}

async function until(read, accept, label, timeout = 6000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await new Promise((done) => setTimeout(done, 75))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((done, reject) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(data)
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timeout)
    if (response.error) request.reject(new Error(response.error.message))
    else if (response.result.exceptionDetails)
      request.reject(new Error(JSON.stringify(response.result.exceptionDetails)))
    else request.resolve(response.result.result.value)
  })
  return {
    socket,
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        const timeout = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('Main-process inspection timed out'))
        }, 4000)
        pending.set(requestId, { resolve, reject, timeout })
        socket.send(
          JSON.stringify({
            id: requestId,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        )
      })
    },
  }
}

const electron = `process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron')`
const status = `(() => {
  const { app, BrowserWindow } = ${electron};
  const windows = BrowserWindow.getAllWindows();
  return { pid: process.pid, ready: app.isReady(), hidden: app.isHidden(), active: app.isActive(),
    windows: windows.map(w => ({ visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized(), loading: w.webContents.isLoading(), url: w.webContents.getURL(), title: w.getTitle() })),
    events: globalThis.__launchCheckEvents || [] };
})()`

try {
  await cp(resolve(process.argv[2] || 'release/mac/Machete.app'), bundle, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  })
  const identifier = `com.tonirilix.cliptoboards.launchcheck.${process.pid}`
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleIdentifier ${identifier}`,
    join(bundle, 'Contents/Info.plist'),
  ])
  // Launch through macOS, just like opening the .app in Finder or with `open`.
  run('/usr/bin/open', [
    '-n',
    '--env',
    `MACHETE_DATA_DIR=${join(directory, 'data')}`,
    '--stderr',
    stderr,
    bundle,
    '--args',
    '--inspect=127.0.0.1:0',
  ])
  const endpoint = await until(
    async () => {
      nativeLog = await readFile(stderr, 'utf8').catch(() => '')
      return nativeLog
        .split('\n')
        .find((line) => line.startsWith('Debugger listening on '))
        ?.slice('Debugger listening on '.length)
        .trim()
    },
    Boolean,
    'Inspector did not start',
    // Launch Services may take longer to register a new unsigned temporary app.
    20000,
  )
  // Let Electron finish bootstrapping before inspecting its lazy native exports.
  await new Promise((done) => setTimeout(done, 1000))
  inspector = await connect(endpoint)
  processId = await inspector.evaluate('process.pid')
  await until(
    () => inspector.evaluate(status),
    (state) => state.ready && state.windows.length && !state.windows[0].loading,
    'Window did not load',
  )
  await inspector.evaluate(`(() => {
    const { app, BrowserWindow } = ${electron}; globalThis.__launchCheckEvents = [];
    for (const event of ['activate','did-become-active','did-resign-active','second-instance']) app.on(event, () => globalThis.__launchCheckEvents.push(event));
    for (const w of BrowserWindow.getAllWindows()) for (const event of ['show','hide','focus','blur','minimize','restore','close']) w.on(event, () => globalThis.__launchCheckEvents.push('window:' + event));
    return true;
  })()`)
  const present = (state) =>
    !state.hidden &&
    state.windows[0]?.visible &&
    state.windows[0]?.focused &&
    !state.windows[0]?.minimized
  await until(
    () => inspector.evaluate(status),
    present,
    'Initial launch did not show and focus the window',
  )
  console.log('PASS: initial open shows and focuses the window')
  for (let round = 1; round <= 3; round++) {
    for (const action of ['hide', 'close', 'minimize', 'hide-app']) {
      // AppKit can deliver activation events after the window reports focus.
      // Let the preceding open finish before starting a separate hide/close case.
      await new Promise((done) => setTimeout(done, 500))
      await inspector.evaluate(
        `(() => {const E=${electron}; globalThis.__launchCheckEvents=[]; ${action === 'hide-app' ? 'E.app.hide()' : `E.BrowserWindow.getAllWindows()[0].${action}()`}; return true})()`,
      )
      await until(
        () => inspector.evaluate(status),
        (state) =>
          action === 'hide-app'
            ? state.hidden
            : action === 'minimize'
              ? state.windows[0]?.minimized
              : !state.windows[0]?.visible,
        `Window did not enter ${action} state`,
      )
      run('/usr/bin/open', [bundle])
      await until(
        () => inspector.evaluate(status),
        present,
        `Round ${round}: open after ${action} did not recover the window`,
      )
      console.log(`PASS: round ${round}, open after ${action}`)
    }
  }
} catch (error) {
  if (inspector) console.error('Launch state:', await inspector.evaluate(status).catch(() => null))
  console.error(error)
  const log = nativeLog
  if (log) console.error(log)
  process.exitCode = 1
} finally {
  if (inspector) {
    await inspector
      .evaluate(`(() => { setImmediate(() => ${electron}.app.exit(0)); return true })()`)
      .catch(() => {})
    inspector.socket.close()
  }
  if (!processId) {
    const result = spawnSync(
      '/usr/bin/pgrep',
      ['-f', join(bundle, 'Contents/MacOS/Machete')],
      { encoding: 'utf8' },
    )
    processId = Number(result.stdout.trim().split('\n')[0]) || undefined
  }
  if (processId) {
    try {
      process.kill(processId, 'SIGTERM')
    } catch {}
    await new Promise((done) => setTimeout(done, 250))
    try {
      process.kill(processId, 'SIGKILL')
    } catch {}
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
