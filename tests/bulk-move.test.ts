import { describe, expect, it } from 'vitest'
import type { Board, Clip } from '../src/shared/library'
import { moveMessage, moveTargets, undoPlacements } from '../src/renderer/src/lib/bulk-move'

const boards = [
  { id: 'inbox', name: 'Inbox' },
  { id: 'b1', name: 'Reading' },
  { id: 'b2', name: 'Work' },
] as Board[]

const clips = [
  { id: 'c1', boardId: 'b1' },
  { id: 'c2', boardId: 'b2' },
  { id: 'c3', boardId: 'inbox' },
] as Clip[]

describe('moveTargets', () => {
  it('excludes the viewed board and keeps order', () => {
    expect(moveTargets(boards, 'b1').map((board) => board.id)).toEqual(['inbox', 'b2'])
  })

  it('returns every board in the All view', () => {
    expect(moveTargets(boards, 'all')).toEqual(boards)
  })

  it('returns nothing in the Trash view', () => {
    expect(moveTargets(boards, 'trash')).toEqual([])
  })
})

describe('undoPlacements', () => {
  it('returns each clip own board in ids order and skips unknown ids', () => {
    expect(undoPlacements(clips, ['c3', 'missing', 'c1', 'c2'])).toEqual([
      { id: 'c3', boardId: 'inbox' },
      { id: 'c1', boardId: 'b1' },
      { id: 'c2', boardId: 'b2' },
    ])
  })
})

describe('moveMessage', () => {
  it('uses singular for one clip', () => {
    expect(moveMessage(1, 'Reading')).toBe('Moved 1 clip to Reading')
  })

  it('uses plural otherwise', () => {
    expect(moveMessage(3, 'Reading')).toBe('Moved 3 clips to Reading')
  })
})
