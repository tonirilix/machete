import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopBridge, type OpenRequest } from '../shared/bridge'

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke(channels.state),
  execute: (command) => ipcRenderer.invoke(channels.command, command),
  capture: (fromClipboard) => ipcRenderer.invoke(channels.capture, fromClipboard),
  selectionAccess: (requestPermission = false) =>
    ipcRenderer.invoke(channels.selectionAccess, requestPermission),
  copy: (text) => ipcRenderer.invoke(channels.copy, text),
  hide: () => ipcRenderer.invoke(channels.hide),
  exportCollection: () => ipcRenderer.invoke(channels.export),
  importCollection: () => ipcRenderer.invoke(channels.import),
  onOpen: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: OpenRequest) => listener(request)
    ipcRenderer.on(channels.openRequested, handler)
    return () => ipcRenderer.removeListener(channels.openRequested, handler)
  },
}

contextBridge.exposeInMainWorld('cliptoboards', bridge)
