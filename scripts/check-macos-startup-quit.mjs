import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin')
  throw new Error('This check requires macOS and a desktop session.')

const directory = await mkdtemp(join(tmpdir(), 'machete-startup-quit-'))
const bundle = join(directory, 'Machete Launch Check.app')
const stderr = join(directory, 'stderr.log')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
let inspector
let pausedFrame
let processId

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
            method: pausedFrame ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate',
            params: {
              expression,
              callFrameId: pausedFrame,
              returnByValue: true,
              awaitPromise: true,
            },
          }),
        )
      })
    },
  }
}

const electron = `process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron')`

try {
  await cp(resolve('release/mac/Machete.app'), bundle, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  })
  const identifier = `com.tonirilix.cliptoboards.startupquit.${process.pid}`
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleIdentifier ${identifier}`,
    join(bundle, 'Contents/Info.plist'),
  ])
  run('/usr/bin/open', [
    '--env',
    `MACHETE_DATA_DIR=${join(directory, 'data')}`,
    '--stderr',
    stderr,
    bundle,
    '--args',
    '--inspect-brk=127.0.0.1:0',
  ])
  const endpoint = await until(
    async () =>
      (await readFile(stderr, 'utf8').catch(() => ''))
        .split('\n')
        .find((l) => l.startsWith('Debugger listening on '))
        ?.slice(22)
        .trim(),
    Boolean,
    'Inspector did not start',
    20000,
  )
  inspector = await connect(endpoint)
  // Pause before startup so the quit happens at the real initial-load seam.
  const paused = new Promise((done) =>
    inspector.socket.addEventListener('message', ({ data }) => {
      const event = JSON.parse(data)
      if (event.method === 'Debugger.paused') {
        pausedFrame = event.params.callFrames[0].callFrameId
        done()
      }
    }),
  )
  inspector.socket.send(JSON.stringify({ id: 9998, method: 'Debugger.enable' }))
  inspector.socket.send(JSON.stringify({ id: 9999, method: 'Runtime.runIfWaitingForDebugger' }))
  await paused
  processId = await inspector.evaluate('process.pid')
  await inspector.evaluate(`(()=>{
    const E=${electron};
    // Record an alert instead of blocking the test with a modal dialog.
    E.dialog.showErrorBox=(title,message)=>process.stderr.write('STARTUP_QUIT_ALERT '+message+'\\n');
    const handle=E.protocol.handle.bind(E.protocol);
    E.protocol.handle=(scheme,handler)=>handle(scheme,request=>{
      process.stderr.write('STARTUP_QUIT_TRIGGER\\n');
      E.app.quit();
      return handler(request);
    });
    return true;
  })()`)
  pausedFrame = undefined
  inspector.socket.send(JSON.stringify({ id: 10000, method: 'Debugger.resume' }))
  await until(
    () => readFile(stderr, 'utf8'),
    (s) => s.includes('STARTUP_QUIT_TRIGGER'),
    'Shutdown was not triggered',
    20000,
  )
  await new Promise((r) => setTimeout(r, 500))
  inspector.socket.close()
  await new Promise((r) => setTimeout(r, 500))
  const log = await readFile(stderr, 'utf8')
  assert.ok(
    !log.includes('STARTUP_QUIT_ALERT'),
    'Quitting while the first local page loads must not show a startup error: ' + log,
  )
  await until(
    async () => {
      try {
        process.kill(processId, 0)
        return false
      } catch {
        return true
      }
    },
    Boolean,
    'App did not finish quitting',
  )
  console.log('PASS: quitting during the initial local page load exits without a startup alert')
} finally {
  inspector?.socket.close()
  if (processId)
    try {
      process.kill(processId, 'SIGKILL')
    } catch {}
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
