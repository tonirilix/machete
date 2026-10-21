import type { Command, Draft, Library } from './library'

export interface Snapshot {
  library: Library
  /** Runtime ordering only; collection and backup formats remain version 1. */
  revision: number
  draftWriteId: string | null
  shortcutError: string | null
}

export interface OpenRequest {
  mode: 'browse' | 'capture' | 'settings' | 'saved'
  snapshot: Snapshot
  notice?: string
}

export interface SelectionAccess {
  supported: boolean
  granted: boolean
}

export interface DraftEdit {
  id: string
  revision: number
  action: 'update' | 'save' | 'discard'
  draft?: Draft
}

export interface DraftEditResult {
  snapshot: Snapshot
  accepted: boolean
}

export interface DesktopBridge {
  editDraft(request: DraftEdit): Promise<DraftEditResult>
  getState(): Promise<Snapshot>
  execute(command: Command): Promise<Snapshot>
  capture(fromClipboard: boolean): Promise<Snapshot>
  selectionAccess(requestPermission?: boolean): Promise<SelectionAccess>
  copy(text: string): Promise<void>
  hide(): Promise<void>
  exportCollection(): Promise<boolean>
  importCollection(): Promise<Snapshot | null>
  onBeforeQuit(listener: () => Promise<void>, onCancelled: () => void): () => void
  onOpen(listener: (request: OpenRequest) => void): () => void
}

export const channels = {
  state: 'clips:state',
  command: 'clips:command',
  editDraft: 'clips:edit-draft',
  draftDrainRegistration: 'clips:draft-drain-registration',
  draftDrainRequested: 'clips:draft-drain-requested',
  draftDrainCompleted: 'clips:draft-drain-completed',
  draftDrainCancelled: 'clips:draft-drain-cancelled',
  capture: 'clips:capture',
  selectionAccess: 'clips:selection-access',
  copy: 'clips:copy',
  hide: 'clips:hide',
  export: 'clips:export',
  import: 'clips:import',
  openRequested: 'clips:open-requested',
} as const
