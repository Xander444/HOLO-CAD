import { HandLandmarker } from '@mediapipe/tasks-vision'
import type { RawHand } from './tracking'

export function createDetector(model: string, loader: string, wasm: string) {
  const address = (path: string) => new URL(path, globalThis.location.href).href
  return HandLandmarker.createFromOptions({
    wasmLoaderPath: address(loader), wasmBinaryPath: address(wasm),
  }, {
    baseOptions: { modelAssetPath: model, delegate: 'CPU' }, runningMode: 'VIDEO',
    numHands: 2, minHandDetectionConfidence: .57, minHandPresenceConfidence: .57, minTrackingConfidence: .56,
  })
}

export function detect(detector: HandLandmarker, frame: HTMLVideoElement | ImageBitmap, time: number): RawHand[] {
  const result = detector.detectForVideo(frame, time)
  return result.landmarks.map((landmarks, i) => ({
    landmarks, confidence: result.handedness[i]?.[0]?.score ?? 0, handedness: result.handedness[i]?.[0]?.categoryName ?? '',
  }))
}
