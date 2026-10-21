import { contextBridge, ipcRenderer } from 'electron'
import { channels, type DesktopBridge, type OpenRequest } from '../shared/bridge'

const bridge: DesktopBridge = {
  editDraft: (request) => ipcRenderer.invoke(channels.editDraft, request),
  getState: () => ipcRenderer.invoke(channels.state),
  execute: (command) => ipcRenderer.invoke(channels.command, command),
  capture: (fromClipboard) => ipcRenderer.invoke(channels.capture, fromClipboard),
  selectionAccess: (requestPermission = false) =>
    ipcRenderer.invoke(channels.selectionAccess, requestPermission),
  copy: (text) => ipcRenderer.invoke(channels.copy, text),
  hide: () => ipcRenderer.invoke(channels.hide),
  exportCollection: () => ipcRenderer.invoke(channels.export),
  importCollection: () => ipcRenderer.invoke(channels.import),
  onBeforeQuit: (listener, onCancelled) => {
    const registrationId = crypto.randomUUID()
    const handler = async (
      _event: Electron.IpcRendererEvent,
      request: { id: string; registrationId: string },
    ) => {
      if (request.registrationId !== registrationId) return
      let error: string | undefined
      try {
        await listener()
      } catch (failure) {
        error = failure instanceof Error ? failure.message : 'Could not keep your draft.'
      }
      await ipcRenderer.invoke(channels.draftDrainCompleted, { ...request, error }).catch(() => {})
    }
    const cancelled = () => onCancelled()
    ipcRenderer.on(channels.draftDrainRequested, handler)
    ipcRenderer.on(channels.draftDrainCancelled, cancelled)
    void ipcRenderer.invoke(channels.draftDrainRegistration, { registrationId, active: true })
    return () => {
      ipcRenderer.removeListener(channels.draftDrainRequested, handler)
      ipcRenderer.removeListener(channels.draftDrainCancelled, cancelled)
      void ipcRenderer.invoke(channels.draftDrainRegistration, { registrationId, active: false })
    }
  },
  onOpen: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: OpenRequest) => listener(request)
    ipcRenderer.on(channels.openRequested, handler)
    return () => ipcRenderer.removeListener(channels.openRequested, handler)
  },
}

contextBridge.exposeInMainWorld('machete', bridge)
