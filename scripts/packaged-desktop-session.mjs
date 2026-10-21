import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, realpathSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const electron = `process.getBuiltinModule('module').createRequire(process.resourcesPath + '/app.asar/package.json')('electron')`

// Every request and event wait belongs to this connection, including waits made
// before the socket opens. A dead peer must never leave a scenario hanging.
export async function connectInspector(
  url,
  { WebSocket: Socket = WebSocket, timeout = 4000, process: child } = {},
) {
  const socket = new Socket(url)
  const pending = new Map()
  const events = new Set()
  let id = 0
  let failure
  const fail = (reason) => {
    failure ??= reason
    for (const request of pending.values()) request.reject(failure)
    for (const waiter of events) waiter.reject(failure)
    pending.clear()
    events.clear()
  }
  const exited = () => fail(new Error('Inspected process exited'))
  child?.once('exit', exited)
  socket.addEventListener('close', () => fail(new Error('Inspector disconnected')))
  socket.addEventListener('error', () => {
    fail(new Error('Inspector connection failed'))
    socket.close()
  })
  socket.addEventListener('message', ({ data }) => {
    let response
    try {
      response = JSON.parse(data)
    } catch {
      return fail(new Error('Invalid inspector response'))
    }
    if (response.method) {
      for (const waiter of [...events])
        if (waiter.method === response.method) waiter.resolve(response.params)
      return
    }
    const request = pending.get(response.id)
    if (!request) return
    if (response.error) request.reject(new Error(response.error.message))
    else request.resolve(response.result)
  })
  const wait = (register, remove, label) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure)
      const timer = setTimeout(() => finish(reject, new Error(`${label} timed out`)), timeout)
      const finish = (done, value) => {
        clearTimeout(timer)
        remove()
        done(value)
      }
      register({
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      })
    })
  try {
    await wait(
      (request) => {
        events.add(request)
        socket.addEventListener('open', () => request.resolve(), { once: true })
      },
      () => {
        for (const entry of events) if (!entry.method) events.delete(entry)
      },
      'Inspector connection',
    )
  } catch (error) {
    child?.off('exit', exited)
    socket.close()
    throw error
  }
  return {
    request(method, params = {}) {
      const requestId = ++id
      return wait(
        (request) => {
          pending.set(requestId, request)
          try {
            socket.send(JSON.stringify({ id: requestId, method, params }))
          } catch (error) {
            request.reject(error)
          }
        },
        () => pending.delete(requestId),
        'Main-process inspection',
      )
    },
    async evaluate(expression, callFrameId) {
      const result = await this.request(
        callFrameId ? 'Debugger.evaluateOnCallFrame' : 'Runtime.evaluate',
        {
          expression,
          ...(callFrameId ? { callFrameId } : {}),
          returnByValue: true,
          awaitPromise: true,
        },
      )
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result?.value
    },
    waitForEvent(method) {
      let entry
      return wait(
        (request) => {
          entry = { ...request, method }
          events.add(entry)
        },
        () => events.delete(entry),
        method,
      )
    },
    processExited: exited,
    close() {
      fail(new Error('Inspector closed'))
      child?.off('exit', exited)
      socket.close()
    },
  }
}

export async function createPackagedDesktopSession({
  identity,
  bundle: source = 'release/mac/Machete.app',
  label = 'desktop-check',
}) {
  if (process.platform !== 'darwin')
    throw new Error('This check requires macOS and a desktop session.')
  if (!['copied', 'granted'].includes(identity))
    throw new Error('Choose copied or granted app identity')
  const directory = await mkdtemp(join(tmpdir(), `machete-${label}-`))
  const bundle = identity === 'copied' ? join(directory, 'Machete.app') : resolve(source)
  const executable = join(bundle, 'Contents/MacOS/Machete')
  const dataPath = join(directory, 'data')
  const logPath = join(directory, 'stderr.log')
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const token = randomUUID()
  const rejected = new Map()
  const owned = new Map()
  const unverified = new Set()
  let inspector,
    monitor,
    disposed = false,
    launched = false
  const restore = new Set()
  const previous = new Map()
  const run = (command, args) => {
    const result = spawnSync(command, args, { env: environment, encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(result.stderr || `${command} failed (${result.status})`)
    return result.stdout
  }
  const fingerprint = (pid, expectedExecutable = executable) => {
    // macOS truncates a nonfinal comm column. Put it last and request
    // unlimited width so ownership uses the entire executable path.
    const result = spawnSync(
      '/bin/ps',
      ['-p', String(pid), '-ww', '-o', 'lstart=', '-o', 'comm='],
      {
        encoding: 'utf8',
      },
    )
    const value = result.stdout.trim()
    const match = value.match(
      /^((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
    )
    try {
      return match && realpathSync(match[2]) === realpathSync(expectedExecutable)
        ? value
        : undefined
    } catch {
      return undefined
    }
  }
  const discover = () => {
    const result = spawnSync('/usr/bin/pgrep', ['-f', executable], { encoding: 'utf8' })
    return result.stdout
      .trim()
      .split('\n')
      .map(Number)
      .filter((pid) => pid > 0)
  }
  const track = () => {
    if (!launched) return
    for (const pid of discover()) {
      if (identity === 'granted') {
        // A matching executable alone can be a user reopening their usual app.
        // Before inspection, only this launch's unguessable environment marker
        // and isolated data override are sufficient to claim its process.
        const result = spawnSync('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], {
          encoding: 'utf8',
        })
        const command = result.stdout + ' '
        if (
          !command.includes(`MACHETE_DESKTOP_SESSION_TOKEN=${token} `) ||
          !command.includes(`MACHETE_DATA_DIR=${dataPath} `)
        )
          continue
      }
      const stamp = fingerprint(pid)
      if (stamp && rejected.get(pid) === stamp) continue
      // A candidate with our unique copied path or launch marker may still be
      // using the temporary files when identity lookup is unavailable.
      unverified.add(pid)
      if (stamp) owned.set(pid, { executable, stamp })
    }
  }
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code !== 'ESRCH'
    }
  }
  // An unavailable fingerprint is not proof of exit. Never remove a live
  // process's bundle or data merely because ps or path lookup failed.
  const remaining = () => [...new Set([...owned.keys(), ...unverified])].filter(isAlive)
  const running = () =>
    [...owned]
      .filter(
        ([pid, identity]) =>
          identity.stamp && fingerprint(pid, identity.executable) === identity.stamp,
      )
      .map(([pid]) => pid)
  const delay = (ms) => new Promise((done) => setTimeout(done, ms))
  const until = async (read, accept, label, timeout = 6000) => {
    const deadline = Date.now() + timeout
    let value
    while (Date.now() < deadline) {
      value = await read()
      if (accept(value)) return value
      await delay(75)
    }
    throw new Error(`${label}: ${JSON.stringify(value)}`)
  }
  const stop = async (graceful = false) => {
    track()
    if (graceful) {
      try {
        await until(
          async () => remaining(),
          (pids) => pids.length === 0,
          'Test app did not finish normal quit',
          20000,
        )
        return
      } catch {
        /* Escalate only the verified disposable process. */
      }
    }
    for (const pid of running()) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {}
    }
    try {
      await until(
        async () => remaining(),
        (pids) => pids.length === 0,
        'Test app did not quit',
        3000,
      )
    } catch {
      for (const pid of running()) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
      await until(
        async () => remaining(),
        (pids) => pids.length === 0,
        'Test app survived SIGKILL',
        3000,
      )
    }
  }
  const session = {
    directory,
    bundle,
    dataPath,
    logPath,
    environment,
    run,
    until,
    identifier:
      identity === 'copied'
        ? `com.tonirilix.cliptoboards.${label.replaceAll('-', '')}.${process.pid}`
        : 'com.tonirilix.cliptoboards',
    async readLog() {
      return readFile(logPath, 'utf8').catch(() => '')
    },
    open({ inspect = false, pause = false, electronTerminal = false } = {}) {
      run('/usr/bin/open', [
        ...(inspect ? ['-n'] : []),
        '--env',
        `MACHETE_DATA_DIR=${dataPath}`,
        '--env',
        `MACHETE_DESKTOP_SESSION_TOKEN=${token}`,
        '--stderr',
        logPath,
        ...(electronTerminal ? ['--env', 'ELECTRON_RUN_AS_NODE=1'] : []),
        bundle,
        ...(inspect || pause
          ? ['--args', pause ? '--inspect-brk=127.0.0.1:0' : '--inspect=127.0.0.1:0']
          : []),
      ])
      launched = true
      track()
    },
    reopen() {
      run('/usr/bin/open', [
        '--env',
        `MACHETE_DATA_DIR=${dataPath}`,
        '--env',
        `MACHETE_DESKTOP_SESSION_TOKEN=${token}`,
        bundle,
      ])
      track()
    },
    async connect({ pause = false, timeout = 4000, bootstrapDelay = 0 } = {}) {
      const endpoint = await until(
        async () =>
          (await session.readLog())
            .split('\n')
            .find((line) => line.startsWith('Debugger listening on '))
            ?.slice(22)
            .trim(),
        Boolean,
        'Inspector did not start',
        20000,
      )
      if (bootstrapDelay) await delay(bootstrapDelay)
      inspector = await connectInspector(endpoint, { timeout })
      // A paused launch is ready for scenario instrumentation only once the
      // initial call frame exists. Verify its PID before returning either mode.
      if (pause) {
        const [event] = await Promise.all([
          inspector.waitForEvent('Debugger.paused'),
          (async () => {
            await inspector.request('Debugger.enable')
            await inspector.request('Runtime.runIfWaitingForDebugger')
          })(),
        ])
        inspector.pausedFrame = event.callFrames[0].callFrameId
      }
      const pid = await inspector.evaluate('process.pid', inspector.pausedFrame)
      const stamp = fingerprint(pid)
      if (!stamp) throw new Error('Inspector belongs to another app process')
      if (identity === 'granted') {
        try {
          await until(
            () => inspector.evaluate(`${electron}.app.getPath('userData')`),
            (path) => path === dataPath,
            'Inspected app did not configure isolated userData',
          )
        } catch (error) {
          owned.delete(pid)
          unverified.delete(pid)
          rejected.set(pid, stamp)
          throw error
        }
      }
      owned.set(pid, { executable, stamp })
      monitor = setInterval(() => {
        if (remaining().length === 0) {
          inspector.processExited()
          clearInterval(monitor)
        }
      }, 100)
      return inspector
    },
    async ready() {
      return until(
        () =>
          inspector.evaluate(
            `(() => {const E=${electron}; return E.app.isReady() && E.BrowserWindow.getAllWindows().length > 0 && !E.BrowserWindow.getAllWindows()[0].webContents.isLoading()})()`,
          ),
        Boolean,
        'App did not load',
      )
    },
    async waitForExit() {
      return until(
        async () => {
          track()
          return remaining()
        },
        (pids) => pids.length === 0,
        'App did not finish quitting',
      )
    },
    async dispose() {
      if (disposed) return
      disposed = true
      clearInterval(monitor)
      let graceful = false
      if (inspector && running().length) {
        graceful = await inspector
          .evaluate(`(() => { setImmediate(() => ${electron}.app.quit()); return true })()`)
          .then(
            () => true,
            () => false,
          )
      }
      inspector?.close()
      try {
        await stop(graceful)
      } finally {
        // A granted app keeps its original bundle, signature and TCC identity.
        // Restore an existing user session only after the isolated app has exited.
        if (identity === 'granted' && restore.size === 0 && launched) restore.add(bundle)
        if (remaining().length === 0)
          for (const previousBundle of restore) {
            const stillRunning = [...previous].some(
              ([pid, identity]) =>
                identity.bundle === previousBundle &&
                fingerprint(pid, identity.executable) === identity.stamp,
            )
            if (!stillRunning) run('/usr/bin/open', ['--env', 'MACHETE_DATA_DIR=', previousBundle])
          }
        if (remaining().length === 0)
          await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    },
  }
  try {
    if (identity === 'copied') {
      await cp(resolve(source), bundle, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      })
      run('/usr/libexec/PlistBuddy', [
        '-c',
        `Set :CFBundleIdentifier ${session.identifier}`,
        join(bundle, 'Contents/Info.plist'),
      ])
    } else {
      // An installed copy can share the granted bundle identifier. Stop and
      // later reopen that exact bundle so single-instance routing cannot send
      // the test to the user's collection in an already running app.
      const processes = run('/bin/ps', ['-axo', 'pid=,comm='])
      for (const line of processes.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+\/Contents\/MacOS\/Machete)$/)
        if (!match) continue
        const pid = Number(match[1]),
          path = match[2]
        const previousBundle = path.slice(0, -'/Contents/MacOS/Machete'.length)
        let identifier
        try {
          identifier = run('/usr/libexec/PlistBuddy', [
            '-c',
            'Print :CFBundleIdentifier',
            join(previousBundle, 'Contents/Info.plist'),
          ]).trim()
        } catch {
          continue
        }
        if (identifier !== session.identifier) continue
        const stamp = fingerprint(pid, path)
        if (!stamp) continue
        previous.set(pid, { bundle: previousBundle, executable: path, stamp })
        restore.add(previousBundle)
      }
      if (previous.size) {
        const observer = join(directory, 'observe-existing-app')
        run('/usr/bin/xcrun', ['swiftc', resolve('tests/macos-app.swift'), '-o', observer])
        // Ask AppKit to quit normally so in-flight capture can restore the
        // clipboard. Never force-kill a preexisting user process.
        run(observer, [session.identifier, 'quit'])
        await until(
          async () =>
            [...previous].filter(
              ([pid, identity]) => fingerprint(pid, identity.executable) === identity.stamp,
            ),
          (apps) => apps.length === 0,
          'Existing Machete did not quit',
          10000,
        )
        await delay(300)
      }
    }
    return session
  } catch (error) {
    await session.dispose()
    throw error
  }
}
