import { app, shell, systemPreferences } from 'electron'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { SelectionAccess } from '../shared/bridge'
import { MAX_CLIP_LENGTH } from '../shared/library'

const resultSchema = z.object({
  status: z.enum([
    'captured',
    'permission-required',
    'no-selection',
    'source-changed',
    'too-large',
    'keys-held',
    'clipboard-unavailable',
    'clipboard-busy',
    'restore-failed',
    'unavailable',
  ]),
  text: z.string().max(MAX_CLIP_LENGTH),
})
export type SelectionResult = z.infer<typeof resultSchema>
interface NativeSelection {
  captureSelection(): Promise<unknown>
  startDoubleShift(callback: () => void): boolean
  stopDoubleShift(): void
}
let native: NativeSelection | undefined
let doubleShiftActive = false

export function selectionAccess(): SelectionAccess {
  return {
    supported: process.platform === 'darwin',
    granted: process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(false),
  }
}

export async function requestSelectionAccess(): Promise<SelectionAccess> {
  if (process.platform === 'darwin' && !selectionAccess().granted) {
    systemPreferences.isTrustedAccessibilityClient(true)
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    )
  }
  return selectionAccess()
}

export async function readSelection(): Promise<SelectionResult> {
  if (!selectionAccess().granted) return { status: 'permission-required', text: '' }
  return resultSchema.parse(await nativeSelection().captureSelection())
}

function nativeSelection(): NativeSelection {
  if (!native) {
    const directory = dirname(fileURLToPath(import.meta.url))
    const path = app.isPackaged
      ? join(process.resourcesPath, 'app.asar.unpacked/resources/selection.node')
      : join(directory, '../../resources/selection.node')
    native = createRequire(import.meta.url)(path) as NativeSelection
  }
  return native
}

export function startDoubleShift(callback: () => void): boolean {
  if (!selectionAccess().granted) return false
  doubleShiftActive = nativeSelection().startDoubleShift(callback)
  return doubleShiftActive
}

export function stopDoubleShift() {
  if (doubleShiftActive) native?.stopDoubleShift()
  doubleShiftActive = false
}

export function isDoubleShiftRegistered() {
  return doubleShiftActive
}
