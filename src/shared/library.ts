import { z } from 'zod'

export const INBOX_ID = 'inbox'
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'
export const DOUBLE_SHIFT_SHORTCUT = 'DoubleShift'
export const MAX_CLIP_LENGTH = 1_000_000

const idSchema = z.string().min(1).max(100)
const textSchema = z.string().max(MAX_CLIP_LENGTH, 'This clip is too large.')
const savedTextSchema = textSchema.refine((text) => text.trim().length > 0, 'Add some text first.')
const nameSchema = z.string().trim().min(1, 'Give your board a name.').max(60)
const dateSchema = z.number().finite().nonnegative()

export const boardSchema = z.object({
  id: idSchema,
  name: nameSchema,
  createdAt: dateSchema,
})

export const clipSchema = z.object({
  id: idSchema,
  boardId: idSchema,
  text: savedTextSchema,
  createdAt: dateSchema,
  updatedAt: dateSchema,
  deletedAt: dateSchema.nullable(),
})

export const draftSchema = z.object({ text: textSchema, boardId: idSchema })
const collectionShape = {
  boards: z.array(boardSchema).min(1).max(1000),
  clips: z.array(clipSchema).max(100_000),
}

function checkCollection(value: { boards: Board[]; clips: Clip[] }, context: z.RefinementCtx) {
  const boardIds = new Set(value.boards.map((board) => board.id))
  const names = new Set(value.boards.map((board) => board.name.toLocaleLowerCase()))
  const inbox = value.boards.find((board) => board.id === INBOX_ID)
  if (boardIds.size !== value.boards.length || names.size !== value.boards.length) {
    context.addIssue({ code: 'custom', message: 'Board names and identifiers must be unique.' })
  }
  if (boardIds.has('all') || boardIds.has('trash')) {
    context.addIssue({
      code: 'custom',
      message: 'This collection uses a reserved board identifier.',
    })
  }
  if (!inbox || inbox.name !== 'Inbox') {
    context.addIssue({ code: 'custom', message: 'The collection needs its Inbox board.' })
  }
  if (new Set(value.clips.map((clip) => clip.id)).size !== value.clips.length) {
    context.addIssue({ code: 'custom', message: 'Clip identifiers must be unique.' })
  }
  if (value.clips.some((clip) => !boardIds.has(clip.boardId))) {
    context.addIssue({ code: 'custom', message: 'Every clip must belong to an existing board.' })
  }
}

export const librarySchema = z
  .object({
    version: z.literal(1),
    ...collectionShape,
    draft: draftSchema.nullable(),
    settings: z.object({ shortcut: z.string().trim().min(1).max(100) }),
  })
  .superRefine((value, context) => {
    checkCollection(value, context)
    if (value.draft && !value.boards.some((board) => board.id === value.draft?.boardId)) {
      context.addIssue({ code: 'custom', message: 'The draft needs an existing board.' })
    }
  })

// The version 1 backup identifier stays stable across the Machete rename.
export const backupSchema = z
  .object({
    format: z.literal('cliptoboards'),
    version: z.literal(1),
    exportedAt: dateSchema,
    ...collectionShape,
  })
  .superRefine(checkCollection)

export type Board = z.infer<typeof boardSchema>
export type Clip = z.infer<typeof clipSchema>
export type Draft = z.infer<typeof draftSchema>
export type Library = z.infer<typeof librarySchema>
export type Backup = z.infer<typeof backupSchema>

const idsSchema = z.array(idSchema).min(1).max(100_000)
const placementsSchema = z
  .array(z.object({ id: idSchema, boardId: idSchema }))
  .min(1)
  .max(100_000)

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin-capture'), text: textSchema }),
  z.object({ type: z.literal('append-capture'), text: textSchema.min(1) }),
  z.object({ type: z.literal('save-capture'), text: savedTextSchema }),
  z.object({ type: z.literal('update-draft'), ...draftSchema.shape }),
  z.object({ type: z.literal('discard-draft') }),
  z.object({ type: z.literal('save-draft'), text: savedTextSchema, boardId: idSchema }),
  z.object({
    type: z.literal('edit-clip'),
    id: idSchema,
    text: savedTextSchema,
    boardId: idSchema,
  }),
  z.object({ type: z.literal('create-board'), name: nameSchema }),
  z.object({ type: z.literal('rename-board'), id: idSchema, name: nameSchema }),
  z.object({ type: z.literal('delete-board'), id: idSchema }),
  z.object({ type: z.literal('move-clips'), ids: idsSchema, boardId: idSchema }),
  z.object({ type: z.literal('move-clips-to-new-board'), ids: idsSchema, name: nameSchema }),
  z.object({ type: z.literal('place-clips'), placements: placementsSchema }),
  z.object({ type: z.literal('trash-clips'), ids: idsSchema }),
  z.object({ type: z.literal('restore-clips'), ids: idsSchema }),
  z.object({ type: z.literal('empty-trash') }),
  z.object({ type: z.literal('set-shortcut'), shortcut: z.string().trim().min(1).max(100) }),
])

export type Command = z.infer<typeof commandSchema>

export function createLibrary(): Library {
  return {
    version: 1,
    boards: [{ id: INBOX_ID, name: 'Inbox', createdAt: 0 }],
    clips: [],
    draft: null,
    settings: { shortcut: DEFAULT_SHORTCUT },
  }
}

export function applyCommand(
  current: Library,
  input: Command,
  environment = { now: Date.now, id: () => crypto.randomUUID() },
): Library {
  const command = commandSchema.parse(input)
  const next = structuredClone(current)
  const now = environment.now()

  function requireBoard(id: string) {
    const board = next.boards.find((candidate) => candidate.id === id)
    if (!board) throw new Error('That board no longer exists.')
    return board
  }

  function requireName(name: string, exceptId?: string) {
    if (
      next.boards.some(
        (board) =>
          board.id !== exceptId && board.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      throw new Error('A board with that name already exists.')
    }
  }

  function matchingClips(ids: string[]) {
    const chosen = new Set(ids)
    const clips = next.clips.filter((clip) => chosen.has(clip.id))
    if (clips.length !== chosen.size) throw new Error('One of these clips no longer exists.')
    return clips
  }

  function saveClip(text: string, boardId: string) {
    next.clips.unshift({
      id: environment.id(),
      text,
      boardId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
  }

  switch (command.type) {
    case 'save-capture':
      saveClip(command.text, INBOX_ID)
      break
    case 'begin-capture':
      next.draft ??= { text: command.text, boardId: INBOX_ID }
      break
    case 'append-capture':
      next.draft ??= { text: '', boardId: INBOX_ID }
      next.draft.text = next.draft.text ? `${next.draft.text}\n\n${command.text}` : command.text
      break
    case 'update-draft':
      if (!next.draft) throw new Error('This draft has already been saved or discarded.')
      requireBoard(command.boardId)
      next.draft = { text: command.text, boardId: command.boardId }
      break
    case 'discard-draft':
      next.draft = null
      break
    case 'save-draft':
      if (!next.draft) throw new Error('This draft has already been saved or discarded.')
      requireBoard(command.boardId)
      saveClip(command.text, command.boardId)
      next.draft = null
      break
    case 'edit-clip': {
      requireBoard(command.boardId)
      const clip = matchingClips([command.id])[0]
      if (clip.deletedAt !== null) throw new Error('Restore this clip before editing it.')
      clip.text = command.text
      clip.boardId = command.boardId
      clip.updatedAt = now
      break
    }
    case 'create-board':
      requireName(command.name)
      next.boards.push({ id: environment.id(), name: command.name, createdAt: now })
      break
    case 'rename-board': {
      if (command.id === INBOX_ID) throw new Error('Inbox keeps its name.')
      const board = requireBoard(command.id)
      requireName(command.name, command.id)
      board.name = command.name
      break
    }
    case 'delete-board':
      if (command.id === INBOX_ID) throw new Error('Inbox is permanent.')
      requireBoard(command.id)
      next.boards = next.boards.filter((board) => board.id !== command.id)
      // Trashed clips keep their deleted state and have a valid home on restore.
      for (const clip of next.clips) {
        if (clip.boardId === command.id) clip.boardId = INBOX_ID
      }
      if (next.draft?.boardId === command.id) next.draft.boardId = INBOX_ID
      break
    case 'move-clips':
      requireBoard(command.boardId)
      for (const clip of matchingClips(command.ids)) clip.boardId = command.boardId
      break
    case 'move-clips-to-new-board': {
      requireName(command.name)
      const clips = matchingClips(command.ids)
      const board = { id: environment.id(), name: command.name, createdAt: now }
      next.boards.push(board)
      for (const clip of clips) clip.boardId = board.id
      break
    }
    case 'place-clips': {
      for (const placement of command.placements) requireBoard(placement.boardId)
      const clips = matchingClips(command.placements.map((placement) => placement.id))
      const boardIds = new Map(
        command.placements.map((placement) => [placement.id, placement.boardId]),
      )
      for (const clip of clips) clip.boardId = boardIds.get(clip.id) ?? clip.boardId
      break
    }
    case 'trash-clips':
      for (const clip of matchingClips(command.ids)) clip.deletedAt ??= now
      break
    case 'restore-clips':
      for (const clip of matchingClips(command.ids)) clip.deletedAt = null
      break
    case 'empty-trash':
      next.clips = next.clips.filter((clip) => clip.deletedAt === null)
      break
    case 'set-shortcut':
      next.settings.shortcut = command.shortcut
      break
  }

  return librarySchema.parse(next)
}

export function exportBackup(library: Library): Backup {
  return backupSchema.parse({
    format: 'cliptoboards',
    version: 1,
    exportedAt: Date.now(),
    boards: library.boards,
    clips: library.clips,
  })
}

export function restoreBackup(current: Library, input: unknown): Library {
  const backup = backupSchema.parse(input)
  return librarySchema.parse({
    ...current,
    boards: backup.boards,
    clips: backup.clips,
    draft: null,
  })
}

export function visibleClips(library: Library, boardId: string, query: string): Clip[] {
  const term = query.toLocaleLowerCase()
  return library.clips
    .filter(
      (clip) =>
        (boardId === 'trash' ? clip.deletedAt !== null : clip.deletedAt === null) &&
        (boardId === 'all' || boardId === 'trash' || clip.boardId === boardId) &&
        (!term || clip.text.toLocaleLowerCase().includes(term)),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function selectedText(clips: Clip[], selectedIds: string[]): string {
  const chosen = new Set(selectedIds)
  return clips
    .filter((clip) => chosen.has(clip.id))
    .map((clip) => clip.text)
    .join('\n\n')
}
