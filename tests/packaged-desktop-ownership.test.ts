import { writeFile, stat, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPackagedDesktopSession } from '../scripts/packaged-desktop-session.mjs'

const shell = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', () => ({ spawnSync: shell.run }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  realpathSync: (path: string) => path,
}))

type Session = Awaited<ReturnType<typeof createPackagedDesktopSession>>
let session: Session | undefined
let executable: string
let live: boolean
let processId: number
let fingerprintAvailable: boolean
let marker: string
let dataOverride: string
let configuredData: string | undefined
let quitDelay: number
let opens: string[][]
const spyOnKill = () =>
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (signal === 0) {
      if (live && pid === processId) return true
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
    }
    live = false
    return true
  })
let killed: ReturnType<typeof spyOnKill>
const platform = process.platform

// This peer returns process identity and runtime data configuration separately:
// an executable match or launch environment cannot substitute for userData.
class AppPeer extends EventTarget {
  constructor(_url: string) {
    super()
    queueMicrotask(() => this.dispatchEvent(new Event('open')))
  }
  send(data: string) {
    const request = JSON.parse(data)
    let value: unknown = true
    if (request.params.expression === 'process.pid') value = processId
    if (request.params.expression.endsWith(".app.getPath('userData')")) value = configuredData
    if (request.params.expression.includes('.app.quit()')) {
      if (quitDelay)
        setTimeout(() => {
          live = false
        }, quitDelay)
      else live = false
    }
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ id: request.id, result: { result: { value } } }),
        }),
      ),
    )
  }
  close() {
    this.dispatchEvent(new Event('close'))
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  executable = '/test/Current Machete.app/Contents/MacOS/Machete'
  live = false
  processId = 421
  fingerprintAvailable = true
  marker = ''
  dataOverride = ''
  configuredData = undefined
  quitDelay = 0
  opens = []
  killed = spyOnKill()
  vi.stubGlobal('WebSocket', AppPeer)
  shell.run.mockImplementation((command: string, args: string[]) => {
    let stdout = ''
    if (
      command === '/bin/ps' &&
      args[0] === '-p' &&
      live &&
      Number(args[1]) === processId &&
      fingerprintAvailable
    )
      // macOS truncates a nonfinal comm column to16 characters, even though
      // the process path is much longer. Keep the real ps formatting here.
      stdout =
        args.at(-1) === 'comm='
          ? `Tue Oct 20 10:00:00 2026 ${executable}`
          : `${executable.slice(0, 16)} Tue Oct 20 10:00:00 2026`
    if (command === '/usr/bin/pgrep' && live) stdout = String(processId)
    if (command === '/bin/ps' && args[0] === 'eww' && live && Number(args[2]) === processId)
      stdout = `${executable} ${marker} ${dataOverride}`
    if (command === '/usr/bin/open') opens.push(args)
    return { stdout, stderr: '', status: 0 }
  })
})

afterEach(async () => {
  await session?.dispose()
  if (session) await rm(session.directory, { recursive: true, force: true })
  session = undefined
  vi.unstubAllGlobals()
  killed.mockRestore()
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  vi.useRealTimers()
})

async function prepare() {
  session = await createPackagedDesktopSession({
    identity: 'granted',
    bundle: '/test/Current Machete.app',
  })
  return session
}
function isolatedLaunch(current: Session) {
  current.open({ inspect: true })
  const args = opens.at(-1) ?? []
  marker = args.find((arg) => arg.startsWith('MACHETE_DESKTOP_SESSION_TOKEN=')) ?? ''
  dataOverride = `MACHETE_DATA_DIR=${current.dataPath}`
  live = true
}

describe('packaged desktop process ownership', () => {
  it('never signals a user reopening the same executable during cleanup', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    // The launch failed and a user independently opened their usual app.
    marker = ''
    dataOverride = 'MACHETE_DATA_DIR='
    await current.dispose()
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(live).toBe(true)
  })

  it('does not transfer ownership when the verified test exits and a user reopens its bundle', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    configuredData = current.dataPath
    await writeFile(current.logPath, 'Debugger listening on ws://controlled-peer\n')
    await current.connect()
    processId = 422
    marker = ''
    dataOverride = 'MACHETE_DATA_DIR='
    await current.dispose()
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(live).toBe(true)
  })

  it('cleans an isolated launch before inspector connection using its private token', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    await current.dispose()
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[421, 'SIGTERM']])
    expect(opens.at(-1)).toEqual(['--env', 'MACHETE_DATA_DIR=', current.bundle])
  })

  it('does not adopt an inspector peer whose runtime userData is the user collection', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    configuredData = '/Users/person/Library/Application Support/Machete'
    await writeFile(current.logPath, 'Debugger listening on ws://controlled-peer\n')
    vi.useFakeTimers()
    const connecting = current.connect()
    const failed = expect(connecting).rejects.toThrow('isolated userData')
    // Allow real log I/O to finish before advancing the readiness deadline.
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(6100)
    await failed
    await current.dispose()
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(live).toBe(true)
  })

  it('checks runtime isolation and lets normal app quit finish before signalling', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    configuredData = current.dataPath
    await writeFile(current.logPath, 'Debugger listening on ws://controlled-peer\n')
    await current.connect()
    await current.dispose()
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(live).toBe(false)
  })

  it('allows an in-flight capture to drain beyond three seconds during normal quit', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    configuredData = current.dataPath
    await writeFile(current.logPath, 'Debugger listening on ws://controlled-peer\n')
    await current.connect()
    quitDelay = 5000
    vi.useFakeTimers()
    const disposing = current.dispose()
    await vi.advanceTimersByTimeAsync(4000)
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(live).toBe(true)
    await vi.advanceTimersByTimeAsync(1200)
    await disposing
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(live).toBe(false)
  })

  it('keeps inspector requests alive through a transient process identity lookup failure', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    configuredData = current.dataPath
    await writeFile(current.logPath, 'Debugger listening on ws://controlled-peer\n')
    const inspector = await current.connect()
    fingerprintAvailable = false
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(200)
    await expect(inspector.evaluate('true')).resolves.toBe(true)
    expect(live).toBe(true)
    fingerprintAvailable = true
    await current.dispose()
  })

  it('preserves temporary files and avoids signals while a live launch cannot be identified', async () => {
    const current = await prepare()
    isolatedLaunch(current)
    // Identity lookup fails before an inspector or even initial process
    // fingerprint can be established, but the launch token proves candidacy.
    fingerprintAvailable = false
    vi.useFakeTimers()
    const disposing = current.dispose()
    const failed = expect(disposing).rejects.toThrow('Test app survived SIGKILL')
    await vi.advanceTimersByTimeAsync(6200)
    await failed
    expect((await stat(current.directory)).isDirectory()).toBe(true)
    expect(killed.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
    expect(live).toBe(true)
  })

  it('keeps a new process isolated when a repeated open restarts an exited app', async () => {
    const current = await prepare()
    current.open()
    current.reopen()
    const args = opens.at(-1) ?? []
    expect(args).toContain(`MACHETE_DATA_DIR=${current.dataPath}`)
    expect(args.some((arg) => arg.startsWith('MACHETE_DESKTOP_SESSION_TOKEN='))).toBe(true)
    expect(args.some((arg) => arg.includes('--inspect'))).toBe(false)
  })
})
