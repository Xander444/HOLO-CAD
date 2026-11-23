import type { GeometryRequest, GeometryResponse, WorkerResponse } from './protocol'

export class GeometryClient {
  private worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  private sequence = 0
  private pending = new Map<number, { resolve: (result: GeometryResponse) => void; reject: (error: Error) => void }>()
  private failed?: Error

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const task = this.pending.get(data.id)
      if (!task) return
      this.pending.delete(data.id)
      if ('error' in data) task.reject(new Error(data.error))
      else task.resolve(data.result)
    }
    this.worker.onerror = () => this.fail(new Error('The CAD worker could not start. Reload the page and verify WebAssembly is enabled.'))
    this.worker.onmessageerror = () => this.fail(new Error('The CAD worker lost its connection. Reload the workspace.'))
  }

  request<R extends GeometryRequest>(request: R): Promise<Extract<GeometryResponse, { op: R['op'] }>> {
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      this.pending.set(id, { resolve: result => resolve(result as Extract<GeometryResponse, { op: R['op'] }>), reject })
      this.worker.postMessage({ id, request })
    })
  }

  private fail(error: Error) {
    this.failed = error
    for (const task of this.pending.values()) task.reject(error)
    this.pending.clear()
  }

  close() {
    this.worker.terminate()
    this.fail(new Error('The CAD worker has closed.'))
  }
}
