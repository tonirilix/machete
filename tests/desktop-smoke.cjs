const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, clipboard, ClipboardItem, globalShortcut, ipcMain, dialog } = require('electron')

// Gate only this disposable harness's IPC replies; the application receives no test globals.
const register = ipcMain.handle.bind(ipcMain)
let gateNext = false,
  failNext = false,
  releaseReply,
  replyReached
ipcMain.handle = (channel, handler) =>
  register(channel, async (event, payload) => {
    if (channel === 'clips:edit-draft' && failNext) {
      failNext = false
      throw new Error('Test disk failure')
    }
    const gate = channel === 'clips:edit-draft' && gateNext
    if (gate) gateNext = false
    const result = await handler(event, payload)
    if (gate) {
      replyReached()
      await new Promise((resolve) => {
        releaseReply = resolve
      })
    }
    return result
  })
dialog.showErrorBox = () => {}

let previousClipboard
let finished = false
const timeout = setTimeout(() => finish(new Error('Desktop startup timed out.')), 60_000)

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
      const captured = await window.webContents.executeJavaScript('window.machete.capture(true)')
      assert.equal(captured.library.draft.text, text)
      assert.equal(captured.library.clips.length, 0)
      const saved = await window.webContents.executeJavaScript(
        `window.machete.execute(${JSON.stringify({ type: 'save-draft', text, boardId: 'inbox' })})`,
      )
      assert.equal(saved.library.clips[0].text, text)
      assert.equal(saved.library.draft, null)
      await window.webContents.executeJavaScript(`window.machete.copy(${JSON.stringify(text)})`)
      assert.equal(await clipboard.readText(), text)
      const disk = JSON.parse(
        await readFile(join(process.env.MACHETE_DATA_DIR, 'collection.json'), 'utf8'),
      )
      assert.equal(disk.clips[0].text, text)

      // Populate only the disposable smoke-test collection, then exercise the rendered pages.
      let many
      for (let i = 0; i < 55; i++) {
        await window.webContents.executeJavaScript(
          `window.machete.execute(${JSON.stringify({ type: 'begin-capture', text: '' })})`,
        )
        many = await window.webContents.executeJavaScript(
          `window.machete.execute(${JSON.stringify({ type: 'save-draft', text: `synthetic ${i}`, boardId: 'inbox' })})`,
        )
      }
      window.webContents.send('clips:open-requested', { mode: 'browse', snapshot: many })
      await new Promise((done) => setTimeout(done, 200))
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelectorAll('[data-clip-id]').length",
        ),
        50,
      )
      await window.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))`,
      )
      await new Promise((done) => setTimeout(done, 50))
      assert.ok(
        (await window.webContents.executeJavaScript('document.body.innerText')).includes(
          '56 selected',
        ),
      )
      await window.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true }))`,
      )
      await new Promise((done) => setTimeout(done, 100))
      assert.ok((await clipboard.readText()).includes('synthetic 0'))
      assert.ok((await clipboard.readText()).includes('synthetic 54'))
      await window.webContents.executeJavaScript(
        `document.querySelectorAll('[data-clip-id]')[49].querySelector('button:not([role="checkbox"])[aria-label^="Select "]').click()`,
      )
      await new Promise((done) => setTimeout(done, 100))
      await window.webContents.executeJavaScript(
        'document.querySelector(\'[aria-label="Saved clips"]\').scrollTop = 999999',
      )
      await window.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`,
      )
      await new Promise((done) => setTimeout(done, 100))
      assert.ok(
        (await window.webContents.executeJavaScript('document.body.innerText')).includes(
          'Page 2 of 2',
        ),
      )
      assert.equal(
        await window.webContents.executeJavaScript(
          "document.querySelectorAll('[data-clip-id]').length",
        ),
        6,
      )
      assert.equal(
        await window.webContents.executeJavaScript(`(() => {
        const container = document.querySelector('[aria-label="Saved clips"]')
        const selected = document.querySelector('[data-clip-id]:has([role="checkbox"][data-state="checked"])')
        if (!selected) return false
        const card = selected.getBoundingClientRect(), viewport = container.getBoundingClientRect()
        return card.top >= viewport.top && card.bottom <= viewport.bottom
      })()`),
        true,
        'arrow-selected card must be visible after crossing a page',
      )

      await window.webContents.executeJavaScript(
        `document.querySelectorAll('[data-clip-id]')[5].querySelector('button:not([role="checkbox"])[aria-label^="Select "]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))`,
      )
      await new Promise((done) => setTimeout(done, 100))
      assert.ok(
        (await window.webContents.executeJavaScript('document.body.innerText')).includes(
          '6 selected',
        ),
      )

      // Repeating ArrowDown at the final item must reveal it even when the anchor is unchanged.
      await window.webContents.executeJavaScript(
        `document.querySelectorAll('[data-clip-id]')[5].querySelector('button:not([role="checkbox"])[aria-label^="Select "]').click()`,
      )
      await new Promise((done) => setTimeout(done, 100))
      await window.webContents.executeJavaScript(
        'document.querySelector(\'[aria-label="Saved clips"]\').scrollTop = 0',
      )
      const selectedCardVisible = `(() => {
        const container = document.querySelector('[aria-label="Saved clips"]')
        const selected = document.querySelector('[data-clip-id]:has([role="checkbox"][data-state="checked"])')
        const card = selected.getBoundingClientRect(), viewport = container.getBoundingClientRect()
        // Scroll offsets round to CSS pixels, while card bounds can be fractional.
        return {
          visible: card.top >= viewport.top - 1 && card.bottom <= viewport.bottom + 1,
          card: { top: card.top, bottom: card.bottom },
          viewport: { top: viewport.top, bottom: viewport.bottom },
          scrollTop: container.scrollTop,
        }
      })()`
      assert.equal((await window.webContents.executeJavaScript(selectedCardVisible)).visible, false)
      await window.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`,
      )
      await new Promise((done) => setTimeout(done, 100))
      const boundaryReveal = await window.webContents.executeJavaScript(selectedCardVisible)
      assert.equal(
        boundaryReveal.visible,
        true,
        `repeated arrow navigation must reveal the final selected card: ${JSON.stringify(boundaryReveal)}`,
      )

      // Actual editor: an accepted update is held while board and Inbox state advance.
      const js = async (code) => {
        try {
          return await window.webContents.executeJavaScript(code)
        } catch (error) {
          throw new Error(`Renderer script failed: ${code}`, { cause: error })
        }
      }
      const waitFor = async (condition, label) => {
        for (let i = 0; i < 100; i++) {
          if (await condition()) return
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        throw new Error(`Timed out waiting for ${label}`)
      }
      const click = (selector) =>
        js(
          `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e?.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, button:0, pointerType:'mouse'})); e?.click() })()`,
        )
      const setValue = (selector, value) =>
        js(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing input'); const setter = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', {bubbles:true})); })()`,
        )
      let boardState = await js(`window.machete.execute({type:'create-board',name:'Dirty board'})`)
      const dirtyBoard = boardState.library.boards.at(-1).id
      boardState = await js(`window.machete.capture(false)`)
      window.webContents.send('clips:open-requested', { mode: 'capture', snapshot: boardState })
      await waitFor(
        () => js('!!document.querySelector(\'[aria-label="Clip text"]\')'),
        'draft editor',
      )
      await click('[aria-label="Save to board"]')
      await waitFor(
        () =>
          js(
            "Array.from(document.querySelectorAll('[role=option]')).some(x => x.textContent.includes('Dirty board'))",
          ),
        'board option',
      )
      await js(
        "Array.from(document.querySelectorAll('[role=option]')).find(x => x.textContent.includes('Dirty board')).click()",
      )
      let reached = new Promise((resolve) => {
        replyReached = resolve
      })
      gateNext = true
      await setValue('[aria-label="Clip text"]', 'first local')
      await reached
      await setValue('[aria-label="Clip text"]', 'later local')
      await click('[aria-label="Options for Dirty board"]')
      await waitFor(
        () =>
          js(
            "Array.from(document.querySelectorAll('[role=menuitem]')).some(x => x.textContent.includes('Rename board'))",
          ),
        'rename menu',
      )
      await js(
        "Array.from(document.querySelectorAll('[role=menuitem]')).find(x => x.textContent.includes('Rename board')).click()",
      )
      await waitFor(() => js("!!document.querySelector('#board-name')"), 'rename dialog')
      await setValue('#board-name', 'Renamed board')
      await js(
        "Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Save name')).click()",
      )
      await waitFor(
        () => js('!!document.querySelector(\'[aria-label="Options for Renamed board"]\')'),
        'renamed board',
      )
      const competing = await js(
        `window.machete.execute({type:'save-capture',text:'independent Inbox capture'})`,
      )
      window.webContents.send('clips:open-requested', { mode: 'capture', snapshot: competing })
      releaseReply()
      await waitFor(
        async () =>
          (await js('document.querySelector(\'[aria-label="Clip text"]\')?.value')) ===
          'later local',
        'local text after late acknowledgement',
      )
      await click('[aria-label="Save clip"]')
      await waitFor(
        async () => (await js('window.machete.getState()')).library.draft === null,
        'saved dirty draft',
      )
      let persisted = JSON.parse(
        await readFile(join(process.env.MACHETE_DATA_DIR, 'collection.json'), 'utf8'),
      )
      assert.ok(persisted.clips.some((c) => c.text === 'later local' && c.boardId === dirtyBoard))
      assert.ok(
        persisted.clips.some(
          (c) => c.text === 'independent Inbox capture' && c.boardId === 'inbox',
        ),
      )
      assert.equal(persisted.boards.find((b) => b.id === dirtyBoard).name, 'Renamed board')

      // Delete a selected draft board while dirty; saving must fall back to Inbox.
      let next = await js('window.machete.capture(false)')
      window.webContents.send('clips:open-requested', { mode: 'capture', snapshot: next })
      await waitFor(
        () => js('!!document.querySelector(\'[aria-label="Clip text"]\')'),
        'second draft',
      )
      await click('[aria-label="Save to board"]')
      await waitFor(
        () =>
          js(
            "Array.from(document.querySelectorAll('[role=option]')).some(x => x.textContent.includes('Renamed board'))",
          ),
        'renamed board option',
      )
      await js(
        "Array.from(document.querySelectorAll('[role=option]')).find(x => x.textContent.includes('Renamed board')).click()",
      )
      await setValue('[aria-label="Clip text"]', 'survives board deletion')
      await click('[aria-label="Options for Renamed board"]')
      await waitFor(
        () =>
          js(
            "Array.from(document.querySelectorAll('[role=menuitem]')).some(x => x.textContent.includes('Delete board'))",
          ),
        'delete menu',
      )
      await js(
        "Array.from(document.querySelectorAll('[role=menuitem]')).find(x => x.textContent.includes('Delete board')).click()",
      )
      await waitFor(
        () => js("!!document.querySelector('[role=alertdialog]')"),
        'delete confirmation',
      )
      await js(
        "Array.from(document.querySelectorAll('[role=alertdialog] button')).find(x => x.textContent.includes('Delete board')).click()",
      )
      await waitFor(
        () => js('!document.querySelector(\'[aria-label="Options for Renamed board"]\')'),
        'board deletion',
      )
      await waitFor(
        () => js("!document.querySelector('[role=alertdialog]')"),
        'delete dialog close',
      )
      if (!(await js('!!document.querySelector(\'[aria-label="Clip text"]\')'))) {
        await js(
          "Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Resume draft')).click()",
        )
      }
      await waitFor(
        () => js('!!document.querySelector(\'[aria-label="Clip text"]\')'),
        'resume after deletion',
      )
      assert.equal(
        await js('document.querySelector(\'[aria-label="Clip text"]\').value'),
        'survives board deletion',
      )
      await click('[aria-label="Save clip"]')
      await waitFor(
        async () => (await js('window.machete.getState()')).library.draft === null,
        'save after deletion',
      )
      persisted = JSON.parse(
        await readFile(join(process.env.MACHETE_DATA_DIR, 'collection.json'), 'utf8'),
      )
      assert.ok(
        persisted.clips.some((c) => c.text === 'survives board deletion' && c.boardId === 'inbox'),
      )
      console.log(
        'GUI passed: dirty rename, delayed acknowledgement with competing Inbox capture, and dirty board deletion.',
      )

      // Clipboard append remains manual composition; a late terminal reply must not erase its successor.
      next = await js('window.machete.capture(false)')
      window.webContents.send('clips:open-requested', { mode: 'capture', snapshot: next })
      await waitFor(
        () => js('!!document.querySelector(\'[aria-label="Clip text"]\')'),
        'clipboard draft',
      )
      await setValue('[aria-label="Clip text"]', 'manual words')
      await clipboard.writeText('manual append')
      await js(
        "Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Append clipboard')).click()",
      )
      await waitFor(
        () =>
          js(
            "document.querySelector('[aria-label=\"Clip text\"]')?.value === 'manual words\\n\\nmanual append'",
          ),
        'manual clipboard append',
      )
      reached = new Promise((resolve) => {
        replyReached = resolve
      })
      gateNext = true
      await click('[aria-label="Save clip"]')
      await reached
      next = await js('window.machete.capture(false)')
      window.webContents.send('clips:open-requested', { mode: 'capture', snapshot: next })
      await waitFor(
        () => js("document.querySelector('[aria-label=\"Clip text\"]')?.value === ''"),
        'successor draft',
      )
      await setValue('[aria-label="Clip text"]', 'successor survives')
      releaseReply()
      await waitFor(
        () =>
          js(
            "document.querySelector('[aria-label=\"Clip text\"]')?.value === 'successor survives'",
          ),
        'successor after terminal reply',
      )
      await waitFor(
        async () =>
          (await js('window.machete.getState()')).library.draft?.text === 'successor survives',
        'persisted successor',
      )
      persisted = JSON.parse(
        await readFile(join(process.env.MACHETE_DATA_DIR, 'collection.json'), 'utf8'),
      )
      assert.ok(
        persisted.clips.some(
          (c) => c.text === 'manual words\n\nmanual append' && c.boardId === 'inbox',
        ),
      )
      assert.equal(persisted.draft.text, 'successor survives')

      // A write failure during the quit drain blocks quit and leaves a retryable draft.
      failNext = true
      await setValue('[aria-label="Clip text"]', 'retry after quit failure')
      app.quit()
      await waitFor(
        () =>
          js("document.querySelector('[role=alert]')?.textContent.includes('Test disk failure')"),
        'quit write error',
      )
      assert.equal(window.isDestroyed(), false)
      assert.equal(
        await js('document.querySelector(\'[aria-label="Clip text"]\')?.value'),
        'retry after quit failure',
      )
      await js(
        "Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Try again')).click()",
      )
      await waitFor(
        async () =>
          (await js('window.machete.getState()')).library.draft?.text ===
          'retry after quit failure',
        'retry persistence',
      )
      failNext = true
      await click('[aria-label="Save clip"]')
      await waitFor(
        () =>
          js("document.querySelector('[role=alert]')?.textContent.includes('Test disk failure')"),
        'save write error',
      )
      assert.equal(
        await js('document.querySelector(\'[aria-label="Clip text"]\')?.value'),
        'retry after quit failure',
      )
      await js(
        "Array.from(document.querySelectorAll('button')).find(x => x.textContent.includes('Try again')).click()",
      )
      await waitFor(() => js("!document.querySelector('[role=alert]')"), 'save retry')
      await setValue('[aria-label="Clip text"]', 'hide close preserves typing')
      window.close()
      assert.equal(window.isVisible(), false)
      window.show()
      await waitFor(
        () =>
          js(
            "document.querySelector('[aria-label=\"Clip text\"]')?.value === 'hide close preserves typing'",
          ),
        'reopen pending draft',
      )
      await waitFor(
        async () =>
          (await js('window.machete.getState()')).library.draft?.text ===
          'hide close preserves typing',
        'hide persistence',
      )
      persisted = JSON.parse(
        await readFile(join(process.env.MACHETE_DATA_DIR, 'collection.json'), 'utf8'),
      )
      assert.deepEqual(persisted.draft, { text: 'hide close preserves typing', boardId: 'inbox' })
      console.log(
        'GUI passed: manual append, successor after delayed terminal reply, failed quit, retry, and close/reopen.',
      )

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
