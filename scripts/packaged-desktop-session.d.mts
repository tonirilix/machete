import type { EventEmitter } from 'node:events'

interface InspectorSocket extends EventTarget {
  send(data: string): void
  close(): void
}
interface Inspector {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
  evaluate(expression: string, callFrameId?: string): Promise<unknown>
  waitForEvent(method: string): Promise<Record<string, unknown>>
  processExited(): void
  close(): void
}
export function connectInspector(
  url: string,
  options?: {
    WebSocket?: new (url: string) => InspectorSocket
    timeout?: number
    process?: EventEmitter
  },
): Promise<Inspector>

export const electron: string
export function createPackagedDesktopSession(options: {
  identity: 'copied' | 'granted'
  bundle?: string
  label?: string
}): Promise<{
  directory: string
  bundle: string
  dataPath: string
  logPath: string
  identifier: string
  environment: NodeJS.ProcessEnv
  run(command: string, args: string[]): string
  until<T>(
    read: () => T | Promise<T>,
    accept: (value: T) => unknown,
    label: string,
    timeout?: number,
  ): Promise<T>
  readLog(): Promise<string>
  open(options?: { inspect?: boolean; pause?: boolean; electronTerminal?: boolean }): void
  reopen(): void
  connect(options?: {
    pause?: boolean
    timeout?: number
    bootstrapDelay?: number
  }): Promise<Inspector & { pausedFrame?: string }>
  ready(): Promise<unknown>
  waitForExit(): Promise<unknown>
  dispose(): Promise<void>
}>
