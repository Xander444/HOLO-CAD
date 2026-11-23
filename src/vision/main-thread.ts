import loader from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasm from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import { createDetector } from './detector'

export const createMainThreadDetector = (model: string) => createDetector(model, loader, wasm)
export { detect } from './detector'
