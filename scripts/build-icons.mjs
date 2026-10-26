import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Generated assets are checked in; packaging does not need macOS image tools.
// Run on macOS after updating resources/icon.png (the 1024px master).
const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'resources/icon.png')
const temporary = mkdtempSync(join(tmpdir(), 'machete-icons-'))
const iconset = join(temporary, 'icon.iconset')

function resize(size, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', destination], {
    stdio: 'pipe',
  })
}

try {
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    resize(size, join(iconset, `icon_${size}x${size}.png`))
    resize(size * 2, join(iconset, `icon_${size}x${size}@2x.png`))
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'resources/icon.icns')])
  resize(64, join(root, 'src/renderer/src/assets/icon.png'))
  resize(32, join(root, 'src/renderer/src/assets/favicon.png'))
  console.log('Generated the macOS icon, header icon, and favicon from resources/icon.png.')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
