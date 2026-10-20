import type { Command, Library } from './library'

export interface Snapshot {
  library: Library
  shortcutError: string | null
}

export interface OpenRequest {
  mode: 'browse' | 'capture' | 'settings'
  snapshot: Snapshot
  notice?: string
}

export interface SelectionAccess {
  supported: boolean
  granted: boolean
}

export interface DesktopBridge {
  getState(): Promise<Snapshot>
  execute(command: Command): Promise<Snapshot>
  capture(fromClipboard: boolean): Promise<Snapshot>
  selectionAccess(requestPermission?: boolean): Promise<SelectionAccess>
  copy(text: string): Promise<void>
  hide(): Promise<void>
  exportCollection(): Promise<boolean>
  importCollection(): Promise<Snapshot | null>
  onOpen(listener: (request: OpenRequest) => void): () => void
}

export const channels = {
  state: 'clips:state',
  command: 'clips:command',
  capture: 'clips:capture',
  selectionAccess: 'clips:selection-access',
  copy: 'clips:copy',
  hide: 'clips:hide',
  export: 'clips:export',
  import: 'clips:import',
  openRequested: 'clips:open-requested',
} as const
