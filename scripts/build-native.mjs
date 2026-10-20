import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url)
  const result = spawnSync(
    '/usr/bin/xcrun',
    [
      'clang++',
      '-std=c++17',
      '-fobjc-arc',
      '-DNAPI_VERSION=8',
      '-bundle',
      '-undefined',
      'dynamic_lookup',
      '-arch',
      process.arch === 'arm64' ? 'arm64' : 'x86_64',
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-I',
      require('node-api-headers').include_dir,
      resolve('native/selection.mm'),
      resolve('native/shortcut.mm'),
      '-o',
      resolve('resources/selection.node'),
    ],
    { stdio: 'inherit' },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
