import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataDirectory, migrateCollection } from '../src/main/data-directory'
import { LibraryStore } from '../src/main/store'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'machete-data-test-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const missing = { code: 'ENOENT' }
async function legacyCollection() {
  const file = join(root, 'Cliptoboards', 'collection.json')
  const store = await LibraryStore.open(file)
  await store.execute({ type: 'create-board', name: 'References' })
  await store.execute({ type: 'save-capture', text: 'keep this' })
  await store.execute({ type: 'save-capture', text: 'in trash' })
  await store.execute({ type: 'trash-clips', ids: [store.getState().clips[0].id] })
  await store.execute({ type: 'begin-capture', text: 'unfinished draft' })
  await store.execute({ type: 'set-shortcut', shortcut: 'CommandOrControl+Alt+K' })
  return { file, state: store.getState(), contents: await readFile(file) }
}

describe('namespaced collection directory', () => {
  it('uses the new directory for a fresh installation without creating a collection', async () => {
    const paths = dataDirectory(root, {})
    expect(paths.directory).toBe(join(root, 'com.tonirilix.machete'))
    await migrateCollection(paths)
    expect(
      (await LibraryStore.open(join(paths.directory, 'collection.json'))).getState().clips,
    ).toEqual([])
    await expect(stat(join(paths.directory, 'collection.json'))).rejects.toMatchObject(missing)
  })

  it('preserves all collection state and exact source bytes, retaining the legacy copy', async () => {
    const source = await legacyCollection()
    const paths = dataDirectory(root, {})
    await migrateCollection(paths)
    const destination = join(paths.directory, 'collection.json')
    expect(await readFile(destination)).toEqual(source.contents)
    expect((await LibraryStore.open(destination)).getState()).toEqual(source.state)
    expect(await readFile(source.file)).toEqual(source.contents)
    if (process.platform !== 'win32') {
      expect((await stat(destination)).mode & 0o777).toBe(0o600)
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700)
    }
    expect(await readdir(paths.directory)).toEqual(['collection.json'])
  })

  it('never replaces an existing destination collection or reimports after changes', async () => {
    const source = await legacyCollection()
    const paths = dataDirectory(root, {})
    const destination = join(paths.directory, 'collection.json')
    const current = await LibraryStore.open(destination)
    await current.execute({ type: 'save-capture', text: 'new collection' })
    const contents = await readFile(destination)
    await migrateCollection(paths)
    expect(await readFile(destination)).toEqual(contents)
    await current.execute({ type: 'save-capture', text: 'another clip' })
    const updated = await readFile(destination)
    await migrateCollection(paths)
    expect(await readFile(destination)).toEqual(updated)
    expect(await readFile(source.file)).toEqual(source.contents)
  })

  it('leaves an unreadable existing destination intact for the store to report', async () => {
    await legacyCollection()
    const paths = dataDirectory(root, {})
    await mkdir(paths.directory)
    const destination = join(paths.directory, 'collection.json')
    await writeFile(destination, 'invalid destination')
    await migrateCollection(paths)
    await expect(LibraryStore.open(destination)).rejects.toThrow('left intact')
    expect(await readFile(destination, 'utf8')).toBe('invalid destination')
  })

  it.each(['{broken JSON', '{"not":"a collection"}'])(
    'fails visibly without publishing malformed legacy data: %s',
    async (contents) => {
      const paths = dataDirectory(root, {})
      await mkdir(join(root, 'Cliptoboards'))
      const source = join(root, 'Cliptoboards', 'collection.json')
      await writeFile(source, contents)
      await expect(migrateCollection(paths)).rejects.toThrow('original has been left intact')
      expect(await readFile(source, 'utf8')).toBe(contents)
      await expect(stat(join(paths.directory, 'collection.json'))).rejects.toMatchObject(missing)
    },
  )

  it('reports an unreadable legacy source instead of silently starting fresh', async () => {
    const paths = dataDirectory(root, {})
    await mkdir(join(root, 'Cliptoboards', 'collection.json'), { recursive: true })
    await expect(migrateCollection(paths)).rejects.toThrow()
    await expect(stat(join(paths.directory, 'collection.json'))).rejects.toMatchObject(missing)
  })

  it.each(['source', 'destination', 'legacy directory'])(
    'reports a dangling %s link without replacing it or opening an empty collection',
    async (location) => {
      const source = await legacyCollection()
      const paths = dataDirectory(root, {})
      const destination = join(paths.directory, 'collection.json')
      await mkdir(paths.directory)
      const broken =
        location === 'source'
          ? source.file
          : location === 'destination'
            ? destination
            : join(root, 'Cliptoboards')
      if (location !== 'destination') await rm(broken, { recursive: true })
      await symlink('missing-target', broken)
      await expect(migrateCollection(paths)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readlink(broken)).toBe('missing-target')
      if (location === 'destination') expect(await readFile(source.file)).toEqual(source.contents)
      else await expect(stat(destination)).rejects.toMatchObject(missing)
    },
  )

  it('leaves the source intact when creating the destination fails, allowing a retry', async () => {
    const source = await legacyCollection()
    const paths = dataDirectory(root, {})
    await writeFile(paths.directory, 'blocked directory')
    await expect(migrateCollection(paths)).rejects.toThrow()
    expect(await readFile(source.file)).toEqual(source.contents)
    await rm(paths.directory)
    await migrateCollection(paths)
    expect(await readFile(join(paths.directory, 'collection.json'))).toEqual(source.contents)
  })

  it('publishes a complete collection once for concurrent migration attempts', async () => {
    const source = await legacyCollection()
    const paths = dataDirectory(root, {})
    await Promise.all(Array.from({ length: 8 }, () => migrateCollection(paths)))
    expect(await readFile(join(paths.directory, 'collection.json'))).toEqual(source.contents)
    expect(await readdir(paths.directory)).toEqual(['collection.json'])
  })

  it.each([
    { MACHETE_DATA_DIR: 'custom' },
    { CLIPTOBOARDS_DATA_DIR: 'legacy-override' },
    { MACHETE_DATA_DIR: 'custom', CLIPTOBOARDS_DATA_DIR: 'ignored' },
  ])(
    'honors data-directory overrides without importing the default collection: %j',
    async (env) => {
      await legacyCollection()
      const environment = Object.fromEntries(
        Object.entries(env).map(([key, value]) => [key, join(root, value)]),
      )
      const paths = dataDirectory(root, environment)
      expect(paths.directory).toBe(join(root, env.MACHETE_DATA_DIR || env.CLIPTOBOARDS_DATA_DIR!))
      expect(paths.legacyDirectory).toBeUndefined()
      await migrateCollection(paths)
      await expect(stat(join(paths.directory, 'collection.json'))).rejects.toMatchObject(missing)
    },
  )
})
