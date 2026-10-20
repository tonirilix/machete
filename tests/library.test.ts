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
