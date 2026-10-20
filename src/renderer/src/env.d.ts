import type { DesktopBridge } from '../../shared/bridge'

declare global {
  interface Window {
    cliptoboards?: DesktopBridge
  }
}

export {}
