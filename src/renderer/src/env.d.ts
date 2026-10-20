import type { DesktopBridge } from '../../shared/bridge'

declare global {
  interface Window {
    machete?: DesktopBridge
  }
}

export {}
