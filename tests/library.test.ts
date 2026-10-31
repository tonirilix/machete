import { describe, expect, it } from 'vitest'
import {
  applyCommand,
  MAX_CLIP_LENGTH,
  createLibrary,
  exportBackup,
  restoreBackup,
  selectedText,
  visibleClips,
  type Library,
} from '../src/shared/library'

function save(library: Library, text: string, boardId = 'inbox', time = Date.now()) {
  const withDraft = applyCommand(library, { type: 'begin-capture', text })
  return applyCommand(
    withDraft,
    { type: 'save-draft', text, boardId },
    { now: () => time, id: () => crypto.randomUUID() },
  )
}

describe('deliberately saved clips', () => {
  it('saves each quick capture in Inbox verbatim without creating a draft', () => {
    const text = '  code\n\t選択 👋\n'
    const first = applyCommand(createLibrary(), { type: 'save-capture', text })
    const second = applyCommand(first, { type: 'save-capture', text })
    expect(second.clips.map((clip) => [clip.text, clip.boardId])).toEqual([
      [text, 'inbox'],
      [text, 'inbox'],
    ])
    expect(second.clips[0].id).not.toBe(second.clips[1].id)
    expect(second.draft).toBeNull()
  })

  it('keeps an unfinished manual draft and its board separate from quick captures', () => {
    let library = applyCommand(createLibrary(), { type: 'create-board', name: 'Work' })
    const boardId = library.boards[1].id
    library = applyCommand(library, { type: 'begin-capture', text: '' })
    library = applyCommand(library, { type: 'update-draft', text: 'unfinished', boardId })
    const captured = applyCommand(library, { type: 'save-capture', text: 'separate selection' })
    expect(captured.draft).toEqual({ text: 'unfinished', boardId })
    expect(captured.clips[0]).toMatchObject({ text: 'separate selection', boardId: 'inbox' })
    expect(library.clips).toEqual([])
  })

  it('rejects blank and oversized quick captures without changing the collection', () => {
    const library = createLibrary()
    for (const text of ['', ' \n\t', 'x'.repeat(MAX_CLIP_LENGTH + 1)]) {
      expect(() => applyCommand(library, { type: 'save-capture', text })).toThrow()
    }
    expect(library).toEqual(createLibrary())
  })

  it('starts a selection draft without saving a clip and appends subsequent selections verbatim', () => {
    let library = applyCommand(createLibrary(), { type: 'append-capture', text: '  first\n' })
    expect(library.draft).toEqual({ text: '  first\n', boardId: 'inbox' })
    library = applyCommand(library, { type: 'append-capture', text: '選択 👋\n\tsecond' })
    expect(library.draft?.text).toBe('  first\n\n\n選択 👋\n\tsecond')
    expect(library.clips).toEqual([])
  })

  it('appends to an existing draft without changing its selected board', () => {
    let library = applyCommand(createLibrary(), { type: 'create-board', name: 'Work' })
    const boardId = library.boards[1].id
    library = applyCommand(library, { type: 'begin-capture', text: '' })
    library = applyCommand(library, { type: 'update-draft', text: 'my note', boardId })
    const captured = applyCommand(library, { type: 'append-capture', text: 'new selection' })
    expect(captured.draft).toEqual({ text: 'my note\n\nnew selection', boardId })
    expect(library.draft?.text).toBe('my note')
  })

  it('rejects an overflowing append without replacing the previous draft', () => {
    const library = applyCommand(createLibrary(), {
      type: 'begin-capture',
      text: 'x'.repeat(MAX_CLIP_LENGTH),
    })
    expect(() => applyCommand(library, { type: 'append-capture', text: 'more' })).toThrow()
    expect(library.draft?.text).toHaveLength(MAX_CLIP_LENGTH)
  })

  it('resumes manual entry without replacing an unfinished draft', () => {
    const draft = applyCommand(createLibrary(), {
      type: 'begin-capture',
      text: 'keep this thought',
    })
    const resumed = applyCommand(draft, { type: 'begin-capture', text: 'something copied later' })
    expect(resumed.clips).toEqual([])
    expect(resumed.draft?.text).toBe('keep this thought')
  })

  it('preserves code whitespace and saves identical content as independent clips', () => {
    const text = '  function example() {\n\treturn 1\n  }\n'
    const library = save(save(createLibrary(), text), text)
    expect(library.clips.map((clip) => clip.text)).toEqual([text, text])
    expect(library.clips[0].id).not.toBe(library.clips[1].id)
    expect(library.draft).toBeNull()
  })

  it('does not create a clip from an empty capture or a second save of a finished draft', () => {
    expect(() => save(createLibrary(), '  \n')).toThrow()
    const library = save(createLibrary(), 'saved once')
    expect(() =>
      applyCommand(library, { type: 'save-draft', text: 'saved once', boardId: 'inbox' }),
    ).toThrow('already been saved')
    expect(library.clips).toHaveLength(1)
  })

  it('keeps original save ordering when an older clip is edited', () => {
    const first = save(createLibrary(), 'first', 'inbox', 10)
    const second = save(first, 'second', 'inbox', 20)
    const edited = applyCommand(second, {
      type: 'edit-clip',
      id: first.clips[0].id,
      text: 'FIRST',
      boardId: 'inbox',
    })
    expect(visibleClips(edited, 'all', '').map((clip) => clip.text)).toEqual(['second', 'FIRST'])
  })
})

describe('boards and Trash', () => {
  it('preserves live clips, deleted clips, and draft destinations when their board is deleted', () => {
    let library = applyCommand(createLibrary(), { type: 'create-board', name: 'Project' })
    const boardId = library.boards[1].id
    library = save(save(library, 'keep', boardId), 'recover later', boardId)
    const deletedId = library.clips[0].id
    library = applyCommand(library, { type: 'trash-clips', ids: [deletedId] })
    library = applyCommand(library, { type: 'begin-capture', text: 'unfinished' })
    library = applyCommand(library, { type: 'update-draft', text: 'unfinished', boardId })
    library = applyCommand(library, { type: 'delete-board', id: boardId })
    expect(library.clips.every((clip) => clip.boardId === 'inbox')).toBe(true)
    expect(library.clips.find((clip) => clip.id === deletedId)?.deletedAt).not.toBeNull()
    expect(library.draft?.boardId).toBe('inbox')
    library = applyCommand(library, { type: 'restore-clips', ids: [deletedId] })
    expect(visibleClips(library, 'inbox', '')).toHaveLength(2)
  })

  it('protects Inbox and rejects ambiguous board names', () => {
    const library = createLibrary()
    expect(() => applyCommand(library, { type: 'delete-board', id: 'inbox' })).toThrow('permanent')
    expect(() =>
      applyCommand(library, { type: 'rename-board', id: 'inbox', name: 'Other' }),
    ).toThrow()
    expect(() => applyCommand(library, { type: 'create-board', name: ' inbox ' })).toThrow(
      'already exists',
    )
  })

  it('searches without case sensitivity and keeps Trash separate until explicitly emptied', () => {
    let library = save(save(createLibrary(), 'Git STATUS'), 'git log')
    library = applyCommand(library, { type: 'trash-clips', ids: [library.clips[0].id] })
    expect(visibleClips(library, 'all', 'git').map((clip) => clip.text)).toEqual(['Git STATUS'])
    expect(visibleClips(library, 'trash', 'GIT').map((clip) => clip.text)).toEqual(['git log'])
    library = applyCommand(library, { type: 'empty-trash' })
    expect(library.clips.map((clip) => clip.text)).toEqual(['Git STATUS'])
  })

  it('copies selected clips in visible order without changing their contents', () => {
    const library = save(
      save(createLibrary(), '  older\n', 'inbox', 10),
      'newer\n  line two',
      'inbox',
      20,
    )
    const visible = visibleClips(library, 'all', '')
    expect(
      selectedText(
        visible,
        [...visible].reverse().map((clip) => clip.id),
      ),
    ).toBe('newer\n  line two\n\n  older\n')
  })
})

describe('moving clips between boards', () => {
  function setup() {
    let library = applyCommand(createLibrary(), { type: 'create-board', name: 'A' })
    library = applyCommand(library, { type: 'create-board', name: 'B' })
    const [, a, b] = library.boards
    library = save(library, 'one')
    library = save(library, 'two')
    library = save(library, 'three')
    const [three, two, one] = library.clips
    return { library, a, b, one, two, three }
  }

  it('moves several clips to a board with one move-clips command', () => {
    const { library, a, one, two, three } = setup()
    const moved = applyCommand(library, {
      type: 'move-clips',
      ids: [one.id, two.id],
      boardId: a.id,
    })
    const board = (id: string) => moved.clips.find((clip) => clip.id === id)?.boardId
    expect(board(one.id)).toBe(a.id)
    expect(board(two.id)).toBe(a.id)
    expect(board(three.id)).toBe('inbox')
  })

  it('rejects move-clips to a missing board without changing the library', () => {
    const { library, one } = setup()
    const snapshot = structuredClone(library)
    expect(() =>
      applyCommand(library, { type: 'move-clips', ids: [one.id], boardId: 'missing' }),
    ).toThrow('no longer exists')
    expect(library).toEqual(snapshot)
  })

  it('rejects move-clips with a missing clip without changing the library', () => {
    const { library, a, one } = setup()
    const snapshot = structuredClone(library)
    expect(() =>
      applyCommand(library, { type: 'move-clips', ids: [one.id, 'missing'], boardId: a.id }),
    ).toThrow('no longer exists')
    expect(library).toEqual(snapshot)
  })

  it('creates a board and moves the clips with move-clips-to-new-board', () => {
    const { library, a, one, two, three } = setup()
    const newBoardId = crypto.randomUUID()
    const onA = applyCommand(library, { type: 'move-clips', ids: [two.id], boardId: a.id })
    const moved = applyCommand(
      onA,
      { type: 'move-clips-to-new-board', ids: [one.id, two.id], name: '  Fresh  ' },
      { now: () => 1, id: () => newBoardId },
    )
    expect(moved.boards.filter((board) => board.name === 'Fresh')).toHaveLength(1)
    const board = (id: string) => moved.clips.find((clip) => clip.id === id)?.boardId
    expect(board(one.id)).toBe(newBoardId)
    expect(board(two.id)).toBe(newBoardId)
    expect(board(three.id)).toBe('inbox')
  })

  it('rejects move-clips-to-new-board with a duplicate board name', () => {
    const { library, one } = setup()
    const snapshot = structuredClone(library)
    expect(() =>
      applyCommand(library, { type: 'move-clips-to-new-board', ids: [one.id], name: ' inbox ' }),
    ).toThrow('already exists')
    expect(library).toEqual(snapshot)
    expect(library.boards).toHaveLength(3)
  })

  it('rejects move-clips-to-new-board with an unknown clip id', () => {
    const { library, one } = setup()
    const snapshot = structuredClone(library)
    expect(() =>
      applyCommand(library, {
        type: 'move-clips-to-new-board',
        ids: [one.id, 'missing'],
        name: 'Fresh',
      }),
    ).toThrow('no longer exists')
    expect(library).toEqual(snapshot)
  })

  it('places each clip on its own board with place-clips', () => {
    const { library, a, b, one, two } = setup()
    const onA = applyCommand(library, { type: 'move-clips', ids: [one.id, two.id], boardId: a.id })
    const placed = applyCommand(onA, {
      type: 'place-clips',
      placements: [
        { id: one.id, boardId: 'inbox' },
        { id: two.id, boardId: b.id },
      ],
    })
    const board = (id: string) => placed.clips.find((clip) => clip.id === id)?.boardId
    expect(board(one.id)).toBe('inbox')
    expect(board(two.id)).toBe(b.id)
  })

  it('rejects place-clips with an unknown clip', () => {
    const { library, a, one } = setup()
    const snapshot = structuredClone(library)
    expect(() =>
      applyCommand(library, {
        type: 'place-clips',
        placements: [
          { id: one.id, boardId: a.id },
          { id: 'missing', boardId: a.id },
        ],
      }),
    ).toThrow('no longer exists')
    expect(library).toEqual(snapshot)
  })

  it('rejects place-clips with an unknown board', () => {
    const { library, a, one, two } = setup()
    const snapshot = structuredClone(library)
    expect(() =>
      applyCommand(library, {
        type: 'place-clips',
        placements: [
          { id: one.id, boardId: a.id },
          { id: two.id, boardId: 'missing' },
        ],
      }),
    ).toThrow('no longer exists')
    expect(library).toEqual(snapshot)
  })

  it('rejects place-clips with no placements', () => {
    expect(() => applyCommand(createLibrary(), { type: 'place-clips', placements: [] })).toThrow()
  })
})

describe('portable collections', () => {
  it('round-trips boards and Trash while preserving destination shortcut settings', () => {
    let source = save(createLibrary(), 'a saved reference')
    source = applyCommand(source, { type: 'trash-clips', ids: [source.clips[0].id] })
    source = applyCommand(source, { type: 'begin-capture', text: 'an unfinished thought' })
    const destination = applyCommand(createLibrary(), {
      type: 'set-shortcut',
      shortcut: 'Alt+Shift+Space',
    })
    const restored = restoreBackup(destination, JSON.parse(JSON.stringify(exportBackup(source))))
    expect(restored.boards).toEqual(source.boards)
    expect(restored.clips).toEqual(source.clips)
    expect(restored.draft).toBeNull()
    expect(restored.settings).toEqual(destination.settings)
  })

  it('rejects unsupported backups, duplicate identifiers, and missing boards before replacing anything', () => {
    const library = save(createLibrary(), 'still here')
    const backup = exportBackup(library)
    expect(() => restoreBackup(library, { ...backup, version: 99 })).toThrow()
    expect(() =>
      restoreBackup(library, { ...backup, clips: [...backup.clips, ...backup.clips] }),
    ).toThrow()
    expect(() =>
      restoreBackup(library, { ...backup, clips: [{ ...backup.clips[0], boardId: 'missing' }] }),
    ).toThrow()
    expect(library.clips[0].text).toBe('still here')
  })
})
