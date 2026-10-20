import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin')
  throw new Error(
    'Selection checks require macOS and Accessibility permission for the packaged app.',
  )
const directory = await mkdtemp(join(tmpdir(), 'machete-selection-check-'))
const observer = join(directory, 'observe')
const fixture = join(directory, 'fixture')
const keyboard = join(directory, 'keyboard.node')
const logPath = join(directory, 'main.log')
const dataPath = join(directory, 'data')
const bundle = resolve('release/mac/Machete.app')
const identifier = 'com.tonirilix.cliptoboards'
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
let inspector, source
let helperReady = false,
  launched = false
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
function run(cmd, args) {
  const result = spawnSync(cmd, args, { env: environment, encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || cmd)
  return result.stdout
}
async function until(read, accept, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await delay(80)
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
async function quitApp() {
  run(observer, [identifier, 'quit'])
  await until(
    () => JSON.parse(run(observer, [identifier])),
    (apps) => apps.length === 0,
    'App did not quit',
  )
  await delay(300)
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
    const response = JSON.parse(data),
      request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timeout)
    if (response.error || response.result.exceptionDetails)
      request.reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)))
    else request.resolve(response.result.result.value)
  })
  return {
    close: () => socket.close(),
    evaluate(expression) {
      return new Promise((resolve, reject) => {
        const requestId = ++id
        const timeout = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error('Main-process check timed out'))
        }, 15000)
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
const requireExpression = `process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')`
const electron = `${requireExpression}('electron')`
const renderer = (expression) =>
  inspector.evaluate(
    `${electron}.BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(${JSON.stringify(expression)})`,
  )
const current = () => renderer('window.machete.getState()')
const capture = () =>
  inspector.evaluate(`(async () => {
  const entry = ${requireExpression}(${electron}.app.getAppPath() + '/out/main/index.js');
  await Promise.all([entry.captureSelectionAndShow(), entry.captureSelectionAndShow()]);
  return true;
})()`)
async function openFixture(mode, text) {
  if (source && source.exitCode === null && source.signalCode === null) {
    // AppKit can reactivate the previous app as a fixture exits. Finish that
    // handoff before asking the next fixture to take focus.
    const exited = once(source, 'exit')
    source.kill()
    await exited
  }
  source = spawn(fixture, [mode, text], { env: environment, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture did not become ready')), 8000)
    source.stdout.once('data', () => {
      clearTimeout(timer)
      done()
    })
    source.once('error', reject)
  })
}
// Fingerprints stay inside the app: no clipboard contents are printed or stored.
const clipboardFingerprint = `async () => {
  const r=${requireExpression}, {clipboard}=r('electron'), hash=r('node:crypto').createHash('sha256');
  for(const item of await clipboard.read()) for(const type of [...item.types].sort()) {
    hash.update(type); const value=await item.getType(type);
    hash.update(typeof value.arrayBuffer==='function' ? Buffer.from(await value.arrayBuffer()) : JSON.stringify(value));
  }
  return hash.digest('hex');
}`
try {
  run('/usr/bin/xcrun', ['swiftc', resolve('tests/macos-app.swift'), '-o', observer])
  helperReady = true
  run('/usr/bin/xcrun', [
    'clang++',
    '-fobjc-arc',
    '-framework',
    'AppKit',
    resolve('tests/selection-fixture.mm'),
    '-o',
    fixture,
  ])
  run('/usr/bin/xcrun', [
    'clang++',
    '-fobjc-arc',
    '-DNAPI_VERSION=8',
    '-bundle',
    '-undefined',
    'dynamic_lookup',
    '-framework',
    'ApplicationServices',
    '-framework',
    'AppKit',
    '-I',
    createRequire(import.meta.url)('node-api-headers').include_dir,
    resolve('tests/keyboard-events.mm'),
    '-o',
    keyboard,
  ])
  await quitApp()
  run('/usr/bin/open', [
    '--env',
    `MACHETE_DATA_DIR=${dataPath}`,
    '--stderr',
    logPath,
    bundle,
    '--args',
    '--inspect=127.0.0.1:0',
  ])
  launched = true
  const endpoint = await until(
    async () =>
      (await readFile(logPath, 'utf8').catch(() => ''))
        .split('\n')
        .find((line) => line.startsWith('Debugger listening on '))
        ?.slice(22)
        .trim(),
    Boolean,
    'Inspector did not start',
    20000,
  )
  inspector = await connect(endpoint)
  await until(
    () =>
      inspector.evaluate(
        `(()=>{const E=${electron}; return E.app.isReady() && E.BrowserWindow.getAllWindows().length>0 && !E.BrowserWindow.getAllWindows()[0].webContents.isLoading()})()`,
      ),
    Boolean,
    'App did not load',
  )
  await until(
    () => renderer('typeof window.machete?.selectionAccess === "function"').catch(() => false),
    Boolean,
    'Sandboxed bridge did not become ready',
  )
  const access = await renderer('window.machete.selectionAccess()')
  assert.ok(
    access.granted,
    'Enable Machete in System Settings → Privacy & Security → Accessibility, then rerun this check.',
  )
  const shortcut = (await current()).library.settings.shortcut
  assert.equal(
    await inspector.evaluate(
      `${electron}.globalShortcut.isRegistered(${JSON.stringify(shortcut)})`,
    ),
    true,
    'The capture shortcut must be registered',
  )

  const first = '  selected α 👋\n\tline two\n'
  await openFixture('direct', first)
  await capture()
  assert.equal((await current()).library.draft.text, first)
  assert.equal((await current()).library.clips.length, 0)
  await delay(300)
  assert.equal(await renderer('document.querySelector("textarea")?.value'), first)
  console.log('PASS: native selected text reaches the editor verbatim, once, without saving a clip')

  await renderer('window.machete.execute({type:"create-board",name:"Selection test"})')
  const boardId = (await current()).library.boards[1].id
  await renderer(
    `window.machete.execute(${JSON.stringify({ type: 'update-draft', text: first, boardId })})`,
  )
  await openFixture('direct', 'second selection')
  await capture()
  let expected = first + '\n\nsecond selection'
  assert.equal((await current()).library.draft.text, expected)
  assert.equal((await current()).library.draft.boardId, boardId)
  await delay(300)
  assert.equal(await renderer('document.querySelector("textarea")?.value'), expected)
  console.log('PASS: another selection appends to the same draft and refreshes its editor')

  const before = await inspector.evaluate(`(${clipboardFingerprint})()`)
  await openFixture('fallback', 'copied fallback selection')
  await capture()
  expected += '\n\ncopied fallback selection'
  assert.equal((await current()).library.draft.text, expected)
  assert.equal(
    await inspector.evaluate(`(${clipboardFingerprint})()`),
    before,
    'The previous system clipboard must be restored',
  )
  console.log('PASS: Copy fallback captures fresh selection and restores the system clipboard')

  await openFixture('empty', 'nothing selected here')
  await capture()
  assert.equal((await current()).library.draft.text, expected)
  assert.equal((await current()).library.clips.length, 0)
  console.log(
    'PASS: no selection leaves the existing draft intact and never inserts stale clipboard text',
  )

  await renderer(
    `window.machete.execute(${JSON.stringify({ type: 'save-draft', text: expected, boardId })})`,
  )
  const saved = JSON.parse(await readFile(join(dataPath, 'collection.json'), 'utf8'))
  assert.equal(saved.clips[0].text, expected)
  assert.equal(saved.clips.length, 1)
  assert.equal(saved.draft, null)
  console.log('PASS: explicit save persists exactly one clip in the selected board')

  const conventional = shortcut
  await renderer('window.machete.execute({type:"set-shortcut",shortcut:"DoubleShift"})')
  assert.equal(
    await inspector.evaluate(
      `${electron}.globalShortcut.isRegistered(${JSON.stringify(conventional)})`,
    ),
    false,
  )
  await openFixture('direct', 'captured by double Shift')
  const key = async (code, down, flags = 0) => {
    // The native emitter checks the fixture PID immediately before posting.
    // Spawning a process here would distort the tap timing.
    await inspector.evaluate(
      `${requireExpression}(${JSON.stringify(keyboard)}).postKey(${code},${down},${flags},${source.pid})`,
    )
    await delay(45)
  }
  const shift = async (code = 56, duration = 0) => {
    const flags = (1 << 17) | (code === 56 ? 2 : 4)
    await key(code, true, flags)
    try {
      if (duration) await delay(duration)
    } finally {
      await key(code, false)
    }
  }
  // One tap, a held key, and Shift used while typing must leave selection alone.
  await shift(56, 300)
  await shift()
  await delay(500)
  assert.equal((await current()).library.draft, null)
  await key(56, true, (1 << 17) | 2)
  try {
    await key(0, true, (1 << 17) | 2)
    await key(0, false, (1 << 17) | 2)
  } finally {
    await key(56, false)
  }
  await shift()
  await delay(500)
  assert.equal((await current()).library.draft, null)
  console.log('PASS: holding Shift and using Shift while typing do not trigger capture')

  // Reopen the fixture to reset the selection changed by the typing test.
  await openFixture('direct', 'captured by double Shift')
  await shift()
  await shift()
  await until(
    current,
    (state) => state.library.draft?.text === 'captured by double Shift',
    'Double Shift did not capture the selection',
  )
  assert.equal((await current()).library.clips.length, 1)
  console.log('PASS: actual global double Shift events capture selected text without saving')

  await openFixture('direct', 'right Shift selection')
  await shift(60)
  await shift(60)
  const appended = 'captured by double Shift\n\nright Shift selection'
  await until(
    current,
    (state) => state.library.draft?.text === appended,
    'Right Shift did not append the selection',
  )
  console.log('PASS: right Shift also captures and appends to the existing draft')

  await renderer(
    `window.machete.execute(${JSON.stringify({ type: 'set-shortcut', shortcut: conventional })})`,
  )
  await openFixture('direct', 'must not be captured')
  await shift()
  await shift()
  await delay(500)
  assert.equal((await current()).library.draft.text, appended)
  assert.equal(
    await inspector.evaluate(
      `${electron}.globalShortcut.isRegistered(${JSON.stringify(conventional)})`,
    ),
    true,
  )
  console.log('PASS: switching back to a key combination removes the double Shift listener')
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  source?.kill()
  if (inspector) {
    // All capture and persistence checks have finished. Stop the disposable
    // inspected process before asking the native observer to wait for its exit.
    await inspector
      .evaluate(`(() => { setTimeout(() => ${electron}.app.exit(0), 100); return true })()`)
      .catch(() => {})
    inspector.close()
  }
  if (helperReady && launched) {
    await quitApp()
    run('/usr/bin/open', ['--env', 'MACHETE_DATA_DIR=', bundle])
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
