import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'cliptoboards-desktop-'))
const environment = { ...process.env, CLIPTOBOARDS_DATA_DIR: directory }
// Electron-hosted terminals may inherit this variable from their parent app.
delete environment.ELECTRON_RUN_AS_NODE

try {
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(require('electron'), [resolve('tests/desktop-smoke.cjs')], {
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => done(code ?? 1))
  })
  process.exitCode = exitCode
} finally {
  await rm(directory, { recursive: true, force: true })
}
