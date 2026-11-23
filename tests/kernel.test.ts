import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import createOC from 'replicad-opencascadejs'
import { setOC } from 'replicad'
import { exportBodies, importBodies, measureBody, splitParts, buildBody, tessellate } from '../src/cad/kernel'
import { exampleProject } from '../src/models/demo'
import { blankProject, defaultPrimitive, identity, makeBody } from '../src/models/project'
import type { Body, Primitive } from '../src/models/project'
import { planeFrame } from '../src/models/math'
import { execute } from '../src/commands/commands'

before(async () => {
  const wasmBinary = await readFile(fileURLToPath(import.meta.resolve('replicad-opencascadejs/wasm')))
  setOC(await createOC({ wasmBinary }))
})
const box = () => makeBody('box', 'Box', { kind: 'primitive', primitive: { kind: 'box', width: 100, length: 50, height: 20 } })
function near(a: number, b: number, tolerance = 1e-6) { assert.ok(Math.abs(a - b) < tolerance, a + ' differs from ' + b) }

test('all seven body families and example tessellate as valid B-reps', () => {
  for (const kind of ['box', 'cube', 'prism', 'sphere', 'cone', 'cylinder', 'tube'] as Primitive['kind'][]) {
    const solid = buildBody(makeBody(kind, kind, { kind: 'primitive', primitive: defaultPrimitive(kind) }))
    try { assert.ok(tessellate(solid).volume > 0, kind) } finally { solid.delete() }
  }
  for (const o of exampleProject().objects as Body[]) {
    const solid = buildBody(o)
    try { assert.ok(tessellate(solid).indices.length > 12, o.name) } finally { solid.delete() }
  }
})

test('cut produces independent closed bodies and conserves volume', () => {
  const original = box()
  const plane = planeFrame('YZ', [14, 0, 0])
  const parts = splitParts(original, plane)
  assert.equal(parts.length, 2)
  const project = { ...blankProject(), objects: [original] }
  const result = execute(project, { type: 'split', id: original.id, plane, parts })
  const measurements = (result.project.objects as Body[]).map(measureBody)
  near(measurements[0].volume + measurements[1].volume, 100000)
  assert.throws(() => splitParts(original, planeFrame('YZ', [70, 0, 0])), /interior/)
})

test('binary STL is closed and STEP round-trips with millimeter bounds', async () => {
  const sample = box()
  const mesh = new DataView(await exportBodies([sample], 'stl', 'fine').arrayBuffer())
  const triangles = mesh.getUint32(80, true)
  assert.equal(mesh.byteLength, 84 + 50 * triangles)
  assert.equal(triangles, 12)
  const edges = new Map<string, number>()
  for (let index = 0; index < triangles; index++) {
    const points = Array.from({ length: 3 }, (_, j) =>
      Array.from({ length: 3 }, (_, k) => mesh.getFloat32(84 + 50 * index + 12 + 12 * j + 4 * k, true)).join(','),
    )
    for (let j = 0; j < 3; j++) {
      const key = [points[j], points[(j + 1) % 3]].sort().join('/')
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  assert.ok([...edges.values()].every(n => n === 2))
  const file = exportBodies([sample], 'step')
  assert.match(await file.text(), /ISO-10303-21/)
  const [data] = await importBodies(file)
  const shape = measureBody(makeBody('reimport', 'Reimport', { kind: 'brep', data }, identity()))
  near(shape.volume, 100000)
  for (const [i, expected] of [100, 50, 20].entries()) near(shape.bounds[1][i] - shape.bounds[0][i], expected)
})
