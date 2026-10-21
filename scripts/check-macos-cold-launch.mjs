import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { createPackagedDesktopSession } from './packaged-desktop-session.mjs'

const session = await createPackagedDesktopSession({
  identity: 'copied',
  bundle: process.argv[2],
  label: 'cold-launch',
})
const { directory, identifier, run } = session
const observer = join(directory, 'observe')
const state = () => JSON.parse(run(observer, [identifier]))
const until = (accept, label, timeout) => session.until(state, accept, label, timeout)

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
  for (let round = 1; round <= 5; round++) {
    const electronTerminal = round % 2 === 0
    const launchLabel = electronTerminal ? 'Electron terminal' : 'normal terminal'
    // No debugger flags or startup instrumentation: use the user's launch command.
    session.open({ electronTerminal })
    // Repeat the command during startup, as in the reported failure.
    session.reopen()
    const apps = await until(
      visible,
      `Cold launch ${round} (${launchLabel}) did not show a window`,
      20000,
    )
    dockApp(apps)
    const pid = apps[0].pid
    for (let repeat = 1; repeat <= 3; repeat++) {
      session.reopen()
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
  await session.dispose()
}
