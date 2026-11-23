import type { RawHand } from './tracking'

type Status = 'off' | 'starting' | 'active'
type MediaFrame = (hands: RawHand[], time: number, aspect: number) => void
type Detector = Awaited<ReturnType<typeof import('./detector').createDetector>>

export class CameraSession {
  private stream?: MediaStream
  private video?: HTMLVideoElement
  private worker?: Worker
  private detector?: Detector
  private frameId = 0
  private generation = 0
  private lastResult = 0
  private lastVideo = -1
  private inFlight = false

  constructor(private frame: MediaFrame, private status: (status: Status, detail?: string) => void) {}

  async start(video: HTMLVideoElement) {
    this.stop()
    const id = this.generation
    this.status('starting')
    try {
      if (!window.isSecureContext) throw new Error('Open HOLO-CAD with HTTPS or on localhost to enable the camera.')
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not offer webcam access.')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } })
      if (id !== this.generation) { stream.getTracks().forEach(t => t.stop()); return }
      this.stream = stream
      this.video = video
      for (const track of stream.getTracks()) track.onended = () => {
        this.stop()
        this.status('off', 'The camera disconnected. Reconnect it and try again.')
      }
      video.srcObject = stream
      await video.play()
      if (id !== this.generation) return
      const model = new URL(import.meta.env.BASE_URL + 'models/hand_landmarker.task', window.location.href).href
      let detectFrame: ((detector: Detector, frame: HTMLVideoElement, time: number) => RawHand[]) | undefined
      if (typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined') {
        try { await this.startWorker(model, id) } catch { this.worker?.terminate(); this.worker = undefined }
      }
      if (id !== this.generation) return
      if (!this.worker) {
        const module = await import('./main-thread')
        const detector = await module.createMainThreadDetector(model)
        if (id !== this.generation) { detector.close(); return }
        this.detector = detector
        detectFrame = module.detect
      }
      this.status('active')
      this.lastResult = performance.now()
      let lastFrame = 0
      const loop = (time: number) => {
        if (id !== this.generation) return
        this.frameId = requestAnimationFrame(loop)
        if (time - this.lastResult > 240) this.frame([], time, this.aspect)
        if (this.inFlight || time - lastFrame < 34 || video.readyState < 2 || video.currentTime === this.lastVideo) return
        lastFrame = time
        this.lastVideo = video.currentTime
        if (this.worker) {
          this.inFlight = true
          void createImageBitmap(video).then(bitmap => {
            if (this.worker && this.generation === id) this.worker.postMessage({ bitmap, time }, [bitmap])
            else bitmap.close()
          }).catch(() => { this.inFlight = false })
        } else if (this.detector && detectFrame) {
          try { this.receive(detectFrame(this.detector, video, time), time) }
          catch { this.stop(); this.status('off', 'Hand tracking stopped. Restart the camera to try again.') }
        }
      }
      this.frameId = requestAnimationFrame(loop)
    } catch (error) {
      if (id !== this.generation) return
      this.stop()
      const reason = error instanceof DOMException && error.name === 'NotAllowedError' ? 'Camera access was denied. Mouse and keyboard controls are available.' :
        error instanceof DOMException && error.name === 'NotFoundError' ? 'No camera is connected.' :
          error instanceof Error ? error.message : 'Hand tracking could not initialize. Verify the local model files.'
      this.status('off', reason)
    }
  }

  private get aspect() { return (this.video?.videoWidth || 640) / (this.video?.videoHeight || 480) }

  private receive(hands: RawHand[], time: number) {
    this.inFlight = false
    this.lastResult = performance.now()
    this.frame(hands, time, this.aspect)
  }

  private startWorker(model: string, generation: number) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    return new Promise<void>((resolve, reject) => {
      const fail = () => { clearTimeout(timeout); reject(new Error('Hand tracking worker failed.')) }
      const timeout = setTimeout(fail, 15_000)
      worker.onerror = fail
      worker.onmessage = ({ data }) => {
        if (data.failed) { fail(); return }
        if (!data.ready) return
        clearTimeout(timeout)
        worker.onmessage = event => {
          if (generation !== this.generation) return
          if (event.data.failed) { this.stop(); this.status('off', 'Hand tracking stopped. Restart the camera to try again.'); return }
          this.receive(event.data.hands, event.data.time)
        }
        worker.onerror = () => { this.stop(); this.status('off', 'Hand tracking stopped. Restart the camera to try again.') }
        resolve()
      }
      worker.postMessage({ model })
    })
  }

  stop() {
    this.generation++
    cancelAnimationFrame(this.frameId)
    this.stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    if (this.video) this.video.srcObject = null
    this.worker?.terminate()
    this.detector?.close()
    this.stream = this.video = this.worker = this.detector = undefined
    this.inFlight = false
    this.lastVideo = -1
    this.status('off')
  }
}
