import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform === 'darwin') {
  const directory = await mkdtemp(join(tmpdir(), 'cliptoboards-native-'))
  const executable = join(directory, 'pasteboard-test')
  try {
    for (const [command, args] of [
      [
        '/usr/bin/xcrun',
        [
          'clang++',
          '-std=c++17',
          '-fobjc-arc',
          '-framework',
          'AppKit',
          resolve('tests/pasteboard.mm'),
          '-o',
          executable,
        ],
      ],
      [executable, []],
      [
        '/usr/bin/xcrun',
        [
          'clang++',
          '-std=c++17',
          resolve('tests/double-shift.cpp'),
          '-o',
          join(directory, 'double-shift-test'),
        ],
      ],
      [join(directory, 'double-shift-test'), []],
    ]) {
      const result = spawnSync(command, args, { stdio: 'inherit' })
      if (result.error) throw result.error
      if (result.status !== 0) {
        process.exitCode = result.status ?? 1
        break
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
