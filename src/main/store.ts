import type { DraftEdit } from '../shared/bridge'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  applyCommand,
  createLibrary,
  draftSchema,
  librarySchema,
  restoreBackup,
  type Command,
  type Library,
} from '../shared/library'

export async function writeCollection(path: string, library: Library): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporaryPath, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(library, null, 2), 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    throw error
  }
}

export class LibraryStore {
  private revision = 0
  private draftWriteId: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(
    private library: Library,
    private persist: (library: Library) => Promise<void>,
  ) {}

  static async open(path: string): Promise<LibraryStore> {
    let library: Library
    try {
      library = librarySchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        library = createLibrary()
      } else {
        throw new Error(
          `Could not read your collection at ${path}. The file has been left intact.`,
          {
            cause: error,
          },
        )
      }
    }
    return new LibraryStore(library, (value) => writeCollection(path, value))
  }

  static inMemory(persist: (library: Library) => Promise<void> = async () => {}) {
    return new LibraryStore(createLibrary(), persist)
  }

  getState(): Library {
    return structuredClone(this.library)
  }

  getShortcut(): string {
    return this.library.settings.shortcut
  }

  getDraftWriteId(): string | null {
    return this.draftWriteId
  }

  getRevision(): number {
    return this.revision
  }

  editDraft(
    request: DraftEdit,
    compact = false,
  ): Promise<{
    library?: Library
    revision: number
    accepted: boolean
    draftWriteId: string | null
  }> {
    const operation = this.queue.then(async () => {
      if (request.revision !== this.revision) {
        return {
          library: this.getState(),
          revision: this.revision,
          accepted: false,
          draftWriteId: this.draftWriteId,
        }
      }
      const command: Command =
        request.action === 'discard'
          ? { type: 'discard-draft' }
          : request.action === 'save'
            ? { type: 'save-draft', ...request.draft! }
            : { type: 'update-draft', ...request.draft! }
      let next: Library
      if (request.action === 'update') {
        const draft = draftSchema.parse(request.draft)
        if (!this.library.draft) throw new Error('This draft has already been saved or discarded.')
        if (!this.library.boards.some((board) => board.id === draft.boardId)) {
          throw new Error('That board no longer exists.')
        }
        next = { ...this.library, draft }
      } else {
        next = applyCommand(this.library, command)
      }
      await this.persist(next)
      this.library = next
      this.revision++
      this.draftWriteId = request.id
      return {
        library: compact && request.action === 'update' ? undefined : this.getState(),
        revision: this.revision,
        accepted: true,
        draftWriteId: this.draftWriteId,
      }
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  execute(command: Command): Promise<Library> {
    return this.change((current) => applyCommand(current, command))
  }

  restore(backup: unknown): Promise<Library> {
    return this.change((current) => restoreBackup(current, backup))
  }

  whenIdle(): Promise<unknown> {
    return this.queue
  }

  private change(transform: (library: Library) => Library): Promise<Library> {
    const operation = this.queue.then(async () => {
      const next = transform(this.library)
      await this.persist(next)
      this.library = next
      this.revision++
      return this.getState()
    })
    this.queue = operation.catch(() => {})
    return operation
  }
}
