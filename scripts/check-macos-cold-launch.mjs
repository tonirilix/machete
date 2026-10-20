import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'darwin')
  throw new Error('This check requires macOS and a desktop session.')

const directory = await mkdtemp(join(tmpdir(), 'cliptoboards-cold-launch-'))
const bundle = join(directory, 'Cliptoboards.app')
const observer = join(directory, 'observe')
const identifier = `com.tonirilix.cliptoboards.coldcheck.${process.pid}`
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const processes = new Set()
let observerReady = false

function run(command, args) {
  const result = spawnSync(command, args, { env: environment, encoding: 'utf8' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, result.stderr || `${command} failed`)
  return result.stdout
}

function state() {
  const apps = JSON.parse(run(observer, [identifier]))
  for (const app of apps) if (app.pid > 0) processes.add(app.pid)
  return apps
}

async function until(accept, label, timeout = 6000) {
  const deadline = Date.now() + timeout
  let apps
  while (Date.now() < deadline) {
    apps = state()
    if (accept(apps)) return apps
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`${label}: ${JSON.stringify(apps)}`)
}

// Foreground focus is checked separately by check-macos-launch.mjs. This check
// remains valid if the user switches focus while repeated launches are running.
function visible(apps) {
  return (
    apps.length === 1 &&
    !apps[0].hidden &&
    apps[0].windows.some(
      (window) => window.onscreen && window.bounds.Width >= 400 && window.bounds.Height >= 400,
    )
  )
}

function dockApp(apps) {
  assert.equal(apps[0].dockIconVisible, true, 'The app must keep its Dock icon')
}

try {
  run('/usr/bin/xcrun', ['swiftc', resolve('tests/macos-app.swift'), '-o', observer])
  observerReady = true
  await cp(resolve(process.argv[2] || 'release/mac/Cliptoboards.app'), bundle, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  })
  run('/usr/libexec/PlistBuddy', [
    '-c',
    `Set :CFBundleIdentifier ${identifier}`,
    join(bundle, 'Contents/Info.plist'),
  ])

  for (let round = 1; round <= 5; round++) {
    const electronTerminal = round % 2 === 0
    const launchLabel = electronTerminal ? 'Electron terminal' : 'normal terminal'
    // No debugger flags or startup instrumentation: use the user's launch command.
    run('/usr/bin/open', [
      '--env',
      `CLIPTOBOARDS_DATA_DIR=${join(directory, 'data')}`,
      // Electron-hosted terminals can supply this variable. It must not change
      // the packaged GUI app into a Node process before our main code runs.
      ...(electronTerminal ? ['--env', 'ELECTRON_RUN_AS_NODE=1'] : []),
      bundle,
    ])
    // Repeat the command during startup, as in the reported failure.
    run('/usr/bin/open', [bundle])
    const apps = await until(
      visible,
      `Cold launch ${round} (${launchLabel}) did not show a window`,
      20000,
    )
    dockApp(apps)
    const pid = apps[0].pid
    for (let repeat = 1; repeat <= 3; repeat++) {
      run('/usr/bin/open', [bundle])
      const reopened = await until(visible, `Reopen ${repeat} did not show a window`)
      assert.equal(reopened[0].pid, pid, 'Reopening started another process')
      dockApp(reopened)
    }
    run(observer, [identifier, 'quit'])
    await until((apps) => apps.length === 0, 'App did not quit')
    console.log(`PASS: cold launch ${round} (${launchLabel}), repeated open, and visible Dock icon`)
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  if (observerReady) {
    try {
      state()
      run(observer, [identifier, 'quit'])
      await until((apps) => apps.length === 0, 'Test app did not quit', 3000)
    } catch {
      for (const pid of processes) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
