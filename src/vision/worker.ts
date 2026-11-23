import type { HandLandmarker } from '@mediapipe/tasks-vision'
import loader from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url'
import wasm from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url'
import { createDetector, detect } from './detector'

let detector: HandLandmarker | undefined
self.onmessage = async ({ data }: MessageEvent<{ model?: string; bitmap?: ImageBitmap; time: number }>) => {
  const bitmap = data.bitmap
  try {
    if (data.model) {
      detector = await createDetector(data.model, loader, wasm)
      self.postMessage({ ready: true })
    } else if (bitmap && detector) self.postMessage({ hands: detect(detector, bitmap, data.time), time: data.time })
  } catch { self.postMessage({ failed: true }) }
  finally { bitmap?.close() }
}
