import { createPackagedDesktopSession, electron } from './packaged-desktop-session.mjs'

const session = await createPackagedDesktopSession({
  identity: 'copied',
  bundle: process.argv[2],
  label: 'launch-check',
})
const { until } = session
let inspector
const status = `(() => {
  const { app, BrowserWindow } = ${electron};
  const windows = BrowserWindow.getAllWindows();
  return { pid: process.pid, ready: app.isReady(), hidden: app.isHidden(), active: app.isActive(),
    windows: windows.map(w => ({ visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized(), loading: w.webContents.isLoading(), url: w.webContents.getURL(), title: w.getTitle() })),
    events: globalThis.__launchCheckEvents || [] };
})()`

try {
  session.open({ inspect: true })
  inspector = await session.connect({ bootstrapDelay: 1000 })
  await session.ready()
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
      session.reopen()
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
  const log = await session.readLog()
  if (log) console.error(log)
  process.exitCode = 1
} finally {
  await session.dispose()
}
