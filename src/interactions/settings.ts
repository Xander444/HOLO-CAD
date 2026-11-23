import type { Quality } from '../cad/kernel'
import type { Calibration } from '../vision/tracking'
import type { GestureOptions } from '../gestures/engine'
export type SnapKind = 'grid' | 'origin' | 'endpoint' | 'midpoint' | 'center' | 'vertex' | 'edge' | 'face' | 'axis'
export type Settings = GestureOptions & {
  precision: number; pinch: number; smoothing: number; confidence: number; mirror: boolean;
  cameraPreview: boolean; allowBrowserSpeech: boolean; spokenPrompts: boolean; confirmVoice: boolean; snap: boolean;
  voiceMuted: boolean; showTools: boolean; showObjects: boolean;
  snapStrength: number; snapTypes: Record<SnapKind, boolean>; grid: number; historyLimit: number;
  quality: Quality; reducedMotion: boolean; calibration?: Calibration;
}
export const defaults: Settings = {
  precision: 2, dwell: 150, cooldown: 270, sensitivity: 1, pinch: .29, smoothing: .68, confidence: .52, mirror: true,
  cameraPreview: true, allowBrowserSpeech: false, spokenPrompts: true, confirmVoice: true, snap: true, snapStrength: 1,
  voiceMuted: false, showTools: false, showObjects: false,
  snapTypes: { grid: true, origin: true, endpoint: true, midpoint: true, center: true, vertex: true, edge: true, face: true, axis: true },
  grid: 1, historyLimit: 64, quality: 'standard', reducedMotion: false,
}
const key = 'holo-cad-settings-v1'
export function readSettings(): Settings {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<Settings>
    return { ...defaults, ...data, snapTypes: { ...defaults.snapTypes, ...data.snapTypes } }
  } catch { return defaults }
}
export function storeSettings(value: Settings) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Settings remain available for this session. */ }
}
