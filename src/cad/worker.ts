import initCascade from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import { setOC } from 'replicad'
import { buildBody, exportBodies, importBodies, splitBody, supportCoordinate, tessellate } from './kernel'
import type { BodyGeometry } from './kernel'
import type { GeometryRequest, GeometryResponse, RenderGeometry, WorkerRequest, WorkerResponse } from './protocol'

const initialized = initCascade({ locateFile: () => new URL(wasmUrl, self.location.href).href }).then(setOC)
const cache = new Map<string, BodyGeometry>()
let entries = 0

async function evaluate(request: GeometryRequest): Promise<GeometryResponse> {
  await initialized
  switch (request.op) {
    case 'init': return { op: 'init' }
    case 'render': {
      const results: RenderGeometry = Object.create(null)
      for (const body of request.bodies) {
        const key = JSON.stringify([body.recipe, body.transform])
        let mesh = cache.get(key)
        if (!mesh) {
          const shape = buildBody(body)
          try { mesh = tessellate(shape) } finally { shape.delete() }
          const size = mesh.positions.length + mesh.normals.length + mesh.indices.length + mesh.lines.length
          while (cache.size && (entries + size > 6_000_000 || cache.size >= 96)) {
            const first = cache.keys().next().value!
            const old = cache.get(first)!
            entries -= old.positions.length + old.normals.length + old.indices.length + old.lines.length
            cache.delete(first)
          }
          if (size <= 6_000_000) { cache.set(key, mesh); entries += size }
        } else {
          cache.delete(key)
          cache.set(key, mesh)
        }
        results[body.id] = mesh
      }
      return { op: 'render', results }
    }
    case 'split': return { op: 'split', ...splitBody(request.body, request.plane, request.preview) }
    case 'export': return { op: 'export', blob: exportBodies(request.bodies, request.format, request.quality) }
    case 'import': return { op: 'import', solids: await importBodies(request.file) }
    case 'support': return { op: 'support', coordinate: supportCoordinate(request.body, request.normal) }
  }
}

let queue = Promise.resolve()
self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  queue = queue.then(async () => {
    const { id, request } = data
    let response: WorkerResponse
    try { response = { id, result: await evaluate(request) } }
    catch (error) {
      response = { id, error: error instanceof Error ? error.message : 'OpenCascade could not complete the operation. Check the dimensions and geometry.' }
    }
    self.postMessage(response)
  })
}
