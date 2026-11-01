import { link, lstat, mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { librarySchema } from '../shared/library'

export function dataDirectory(appData: string, environment: NodeJS.ProcessEnv) {
  const override = environment.MACHETE_DATA_DIR || environment.CLIPTOBOARDS_DATA_DIR
  return {
    directory: override || join(appData, 'com.tonirilix.machete'),
    legacyDirectory: override ? undefined : join(appData, 'Cliptoboards'),
  }
}

/** Seed the new collection once, retaining the original for recovery. */
export async function migrateCollection({
  directory,
  legacyDirectory,
}: ReturnType<typeof dataDirectory>): Promise<void> {
  if (!legacyDirectory) return
  const destination = join(directory, 'collection.json')
  const source = join(legacyDirectory, 'collection.json')
  if (await exists(destination)) {
    // A dangling link exists, but the store treats readFile's ENOENT as a fresh
    // installation. Fail here rather than allowing an empty collection to open.
    await readFile(destination)
    return
  }
  if (!(await exists(legacyDirectory))) return
  // Distinguish a genuinely absent collection from broken file/directory links.
  await stat(legacyDirectory)
  if (!(await exists(source))) return
  const contents = await readFile(source)

  const temporary = join(directory, `.collection-migration-${randomUUID()}.tmp`)
  let ownsTemporary = false
  try {
    librarySchema.parse(JSON.parse(contents.toString('utf8')))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // Write privately and publish a complete file without replacing a destination
    // that appeared meanwhile. The old collection is never modified or removed.
    const file = await open(temporary, 'wx', 0o600)
    ownsTemporary = true
    try {
      await file.writeFile(contents)
      await file.sync()
    } finally {
      await file.close()
    }
    try {
      await link(temporary, destination)
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error
      await readFile(destination)
    }
  } catch (error) {
    throw new Error(
      `Could not migrate your collection from ${source} to ${destination}. The original has been left intact.`,
      { cause: error },
    )
  } finally {
    if (ownsTemporary) await unlink(temporary).catch(() => {})
  }
}

function isCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (isCode(error, 'ENOENT')) return false
    throw error
  }
}
