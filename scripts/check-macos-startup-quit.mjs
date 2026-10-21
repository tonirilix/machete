import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createPackagedDesktopSession, electron } from './packaged-desktop-session.mjs'

const session = await createPackagedDesktopSession({
  identity: 'copied',
  bundle: process.argv[2],
  label: 'startup-quit',
})
const { until, logPath: stderr } = session
let inspector
let pausedFrame

try {
  session.open({ pause: true })
  inspector = await session.connect({ pause: true })
  // The session pauses before startup at the real initial-load seam.
  pausedFrame = inspector.pausedFrame
  await inspector.evaluate(
    `(()=>{
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
  })()`,
    pausedFrame,
  )
  pausedFrame = undefined
  await inspector.request('Debugger.resume')
  await until(
    () => readFile(stderr, 'utf8'),
    (s) => s.includes('STARTUP_QUIT_TRIGGER'),
    'Shutdown was not triggered',
    20000,
  )
  await new Promise((r) => setTimeout(r, 500))
  inspector.close()
  await new Promise((r) => setTimeout(r, 500))
  const log = await readFile(stderr, 'utf8')
  assert.ok(
    !log.includes('STARTUP_QUIT_ALERT'),
    'Quitting while the first local page loads must not show a startup error: ' + log,
  )
  await session.waitForExit()
  console.log('PASS: quitting during the initial local page load exits without a startup alert')
} finally {
  await session.dispose()
}
