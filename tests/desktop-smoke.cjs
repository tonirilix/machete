const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, clipboard, ClipboardItem, globalShortcut } = require('electron')

let previousClipboard
let finished = false
const timeout = setTimeout(() => finish(new Error('Desktop startup timed out.')), 20_000)

async function finish(error) {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  try {
    if (previousClipboard) await clipboard.write(previousClipboard)
  } catch (restoreError) {
    error ??= restoreError
  }
  if (error) console.error(error)
  else
    console.log(
      'Desktop smoke passed: sandboxed bridge, capture, save, clipboard, persistence, shortcut status, and hide.',
    )
  app.exit(error ? 1 : 0)
}

app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-fail-load', (_event, code, message) =>
    finish(new Error(`${code}: ${message}`)),
  )
  window.webContents.once('did-finish-load', async () => {
    try {
      const initial = await window.webContents.executeJavaScript('window.machete.getState()')
      assert.equal(initial.library.clips.length, 0)
      assert.equal(window.webContents.getLastWebPreferences().sandbox, true)
      assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true)
      assert.ok(
        globalShortcut.isRegistered(initial.library.settings.shortcut) || initial.shortcutError,
      )

      // Preserve all clipboard formats while testing real native clipboard access.
      previousClipboard = await Promise.all(
        (await clipboard.read()).map(async (item) => {
          const entries = await Promise.all(
            item.types.map(async (type) => [type, await item.getType(type)]),
          )
          return new ClipboardItem(Object.fromEntries(entries))
        }),
      )
      const text = 'git status --short\n  # native clipboard smoke test'
      await clipboard.writeText(text)
      const captured = await window.webContents.executeJavaScript(
        'window.machete.capture(true)',
      )
      assert.equal(captured.library.draft.text, text)
      assert.equal(captured.library.clips.length, 0)
      const saved = await window.webContents.executeJavaScript(
        `window.machete.execute(${JSON.stringify({ type: 'save-draft', text, boardId: 'inbox' })})`,
      )
      assert.equal(saved.library.clips[0].text, text)
      assert.equal(saved.library.draft, null)
      await window.webContents.executeJavaScript(
        `window.machete.copy(${JSON.stringify(text)})`,
      )
      assert.equal(await clipboard.readText(), text)
      const disk = JSON.parse(
        await readFile(join(process.env.MACHETE_DATA_DIR, 'collection.json'), 'utf8'),
      )
      assert.equal(disk.clips[0].text, text)

      // Startup shows the window after loading; let that finish before hiding it.
      await new Promise((done) => setTimeout(done, 100))
      const rendered = await window.webContents.executeJavaScript('document.body.innerText')
      assert.ok(rendered.includes('Machete') || rendered.includes('machete'))
      await window.webContents.executeJavaScript('window.machete.hide()')
      assert.equal(window.isVisible(), false)
      await finish()
    } catch (error) {
      await finish(error)
    }
  })
})

import(pathToFileURL(join(__dirname, '../out/main/index.js')).href).catch(finish)
