import type { Board, Clip } from '../../../shared/library'

export function moveTargets(boards: Board[], active: string): Board[] {
  if (active === 'trash') return []
  if (active === 'all') return boards
  return boards.filter((board) => board.id !== active)
}

export function undoPlacements(clips: Clip[], ids: string[]): { id: string; boardId: string }[] {
  const placements: { id: string; boardId: string }[] = []
  for (const id of ids) {
    const clip = clips.find((candidate) => candidate.id === id)
    if (clip) placements.push({ id, boardId: clip.boardId })
  }
  return placements
}

export function moveMessage(count: number, boardName: string): string {
  return count === 1 ? `Moved 1 clip to ${boardName}` : `Moved ${count} clips to ${boardName}`
}
