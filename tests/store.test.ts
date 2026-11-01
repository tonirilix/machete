import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LibraryStore } from '../src/main/store'

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'machete-test-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('durable local collection', () => {
  it('serializes pending changes and resumes an unfinished draft after restart', async () => {
    const file = join(directory, 'collection.json')
    const store = await LibraryStore.open(file)
    const begin = store.execute({ type: 'begin-capture', text: '' })
    const first = store.execute({ type: 'update-draft', text: 'first words', boardId: 'inbox' })
    const second = store.execute({
      type: 'update-draft',
      text: 'first words\nnext line',
      boardId: 'inbox',
    })
    await Promise.all([begin, first, second])
    const reopened = await LibraryStore.open(file)
    expect(reopened.getState().draft?.text).toBe('first words\nnext line')
    expect(reopened.getState().clips).toEqual([])
    await reopened.execute({ type: 'save-draft', text: 'first words\nnext line', boardId: 'inbox' })
    expect((await LibraryStore.open(file)).getState().clips[0].text).toBe('first words\nnext line')
  })

  it('keeps the last committed state on a write failure and permits a later retry', async () => {
    let fail = true
    const store = LibraryStore.inMemory(async () => {
      if (fail) throw new Error('Disk is full')
    })
    await expect(store.execute({ type: 'create-board', name: 'Project' })).rejects.toThrow(
      'Disk is full',
    )
    expect(store.getState().boards).toHaveLength(1)
    fail = false
    await store.execute({ type: 'create-board', name: 'Project' })
    expect(store.getState().boards.map((board) => board.name)).toEqual(['Inbox', 'Project'])
  })

  it('publishes a conditional draft update only after persistence and preserves state on failure', async () => {
    let release!: () => void
    let reject!: (error: Error) => void
    let defer = false
    const store = LibraryStore.inMemory(async () => {
      if (defer)
        await new Promise<void>((resolve, fail) => {
          release = resolve
          reject = fail
        })
    })
    await store.execute({ type: 'begin-capture', text: 'before' })
    defer = true
    const request = {
      id: 'first',
      revision: store.getRevision(),
      action: 'update' as const,
      draft: { text: 'after', boardId: 'inbox' },
    }
    const pending = store.editDraft(request)
    await Promise.resolve()
    expect(store.getState().draft?.text).toBe('before')
    expect(store.getRevision()).toBe(request.revision)
    release()
    expect((await pending).accepted).toBe(true)
    const failed = store.editDraft({
      ...request,
      id: 'second',
      revision: store.getRevision(),
      draft: { ...request.draft, text: 'failed' },
    })
    await Promise.resolve()
    reject(new Error('Disk full'))
    await expect(failed).rejects.toThrow('Disk full')
    expect(store.getState().draft?.text).toBe('after')
    expect(store.getDraftWriteId()).toBe('first')
  })

  it('leaves an unreadable collection intact instead of starting an empty one', async () => {
    const file = join(directory, 'collection.json')
    await writeFile(file, '{interrupted or invalid file')
    await expect(LibraryStore.open(file)).rejects.toThrow('left intact')
    expect(await readFile(file, 'utf8')).toBe('{interrupted or invalid file')
  })

  it('keeps the collection intact after an invalid import', async () => {
    const file = join(directory, 'collection.json')
    const store = await LibraryStore.open(file)
    await store.execute({ type: 'create-board', name: 'Keep this' })
    const before = await readFile(file, 'utf8')
    await expect(store.restore({ format: 'wrong' })).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})
