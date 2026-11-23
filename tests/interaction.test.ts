import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import createOC from 'replicad-opencascadejs'
import { setOC } from 'replicad'
import { buildBody, exportBodies, importBodies, measureBody, splitBody, supportCoordinate, tessellate } from '../src/cad/kernel'
import type { GeometryRequest, GeometryResponse, RenderGeometry } from '../src/cad/protocol'
import { execute } from '../src/commands/commands'
import type { Command } from '../src/commands/commands'
import { begin, record, redo, undo } from '../src/commands/history'
import { GestureEngine } from '../src/gestures/engine'
import { InteractionController } from '../src/interactions/controller'
import { defaults } from '../src/interactions/settings'
import type { StagePort } from '../src/interactions/types'
import { midpoint, onPlane, planeFrame, sketchPath, sub } from '../src/models/math'
import { blankProject, identity, isBody, makeBody } from '../src/models/project'
import type { Body, Project, Vec3 } from '../src/models/project'
import type { Pose, ScreenPoint, TrackedHand } from '../src/vision/tracking'
import { readProject } from '../src/storage/validation'
import { parseIntent, quantity } from '../src/voice/parser'

before(async () => setOC(await createOC({ wasmBinary: await readFile(new URL(import.meta.resolve('replicad-opencascadejs/wasm'))) })))

const render = (project: Project) => {
  const result: RenderGeometry = {}
  for (const object of project.objects.filter(isBody)) {
    const shape = buildBody(object)
    try { result[object.id] = tessellate(shape) } finally { shape.delete() }
  }
  return result
}

function fixture(bodies: Body[] = []) {
  let history = begin({ ...blankProject(), objects: bodies })
  let data = { ...history.current, meshes: render(history.current.project), ready: true, busy: false, saved: false, status: '', error: undefined as string | undefined, undo: false, redo: false }
  const model = {
    get: () => data,
    select: (selection: string[]) => { data = { ...data, selection } },
    notice: (status: string) => { data = { ...data, status } },
    fail: (error: unknown) => { data = { ...data, error: (error as Error).message } },
    save: async () => {},
    commit: async (command: Command) => {
      try {
        const next = execute(data.project, command, data.selection)
        const meshes = render(next.project)
        history = record(history, next, 64, { project: data.project, selection: data.selection })
        data = { ...data, ...next, meshes, error: undefined }
        return true
      } catch (error) { model.fail(error); return false }
    },
    step: async (direction: 'undo' | 'redo') => {
      const current = { ...history, current: { project: data.project, selection: data.selection } }
      const next = (direction === 'undo' ? undo : redo)(current)
      history = next
      data = { ...data, ...next.current, meshes: render(next.current.project) }
      return next !== current
    },
    kernel: {
      request: async <R extends GeometryRequest>(request: R): Promise<Extract<GeometryResponse, { op: R['op'] }>> => {
        let result: GeometryResponse
        if (request.op === 'support') result = { op: 'support', coordinate: supportCoordinate(request.body, request.normal) }
        else if (request.op === 'split') result = { op: 'split', ...splitBody(request.body, request.plane, request.preview) }
        else if (request.op === 'render') result = { op: 'render', results: render({ ...data.project, objects: request.bodies }) }
        else throw new Error('Unexpected kernel request')
        return result as Extract<GeometryResponse, { op: R['op'] }>
      },
    },
  }
  const spoken: string[] = []
  const exports: Blob[] = []
  const controller = new InteractionController(model, {
    settings: () => defaults, speak: message => spoken.push(message), saveAs() {}, open() {}, fresh() {},
    export(format) { exports.push(exportBodies(model.get().project.objects.filter(isBody), format)) },
    snap() {}, commandFocus() {},
  })
  const orbitCalls: number[] = []
  const stage: StagePort = {
    dimensions: [1000, 800],
    world: ([x, y], frame) => onPlane(frame, [(x - .5) * 200, (.5 - y) * 200]),
    screen: ([x, y, z]) => [.5 + x / 200, .5 - y / 200 - z / 500],
    axisDelta: (from, to) => (from[1] - to[1]) * 150,
    direction: () => [0, -1, 0],
    view() {}, zoom() {}, orbit: (x, y) => orbitCalls.push(Math.hypot(x, y)),
    pick: ([x, y]) => {
      const [wx, wy] = [(x - .5) * 200, (.5 - y) * 200]
      for (const object of model.get().project.objects.slice().reverse()) {
        const mesh = model.get().meshes[object.id]
        if (object.hidden || !mesh) continue
        const [lo, hi] = mesh.bounds
        if (wx >= lo[0] && wx <= hi[0] && wy >= lo[1] && wy <= hi[1]) return { id: object.id, point: [wx, wy, hi[2]], normal: [0, 0, 1] }
      }
    },
  }
  controller.stage = stage
  const engine = new GestureEngine(controller.handleGesture)
  let time = 1000
  const frame = (hands: TrackedHand[], count = 1) => {
    for (let i = 0; i < count; i++) engine.update(hands, time += 40, defaults, controller.gestureContext)
  }
  const wait = () => new Promise<void>(resolve => setImmediate(resolve))
  return { controller, model, stage, engine, frame, wait, spoken, orbitCalls, exports }
}

const hand = (id: number, pose: Pose, at: ScreenPoint): TrackedHand => ({
  id, pose, cursor: at, palm: at, pinchRatio: .2, scale: .13, confidence: .99, handedness: id === 1 ? 'Left' : 'Right', landmarks: [],
})
const fixtureBox = (id: string, position: Vec3 = [0, 0, 0], width = 20) => makeBody(
  id, id, { kind: 'primitive', primitive: { kind: 'box', width, length: 20, height: 20 } }, { ...identity(), position },
)
function closeTo(actual: number, expected: number, tolerance = 1e-6) { assert.ok(Math.abs(actual - expected) < tolerance, actual + ' ≠ ' + expected) }

test('mock two-hand pinch, rectangle pull and extrusion share exact pointer geometry', async () => {
  const f = fixture()
  const { controller, model, frame, wait } = f
  frame([hand(1, 'pinch', [.44, .5]), hand(2, 'pinch', [.56, .5])], 6)
  frame([hand(1, 'pinch', [.26, .5]), hand(2, 'pinch', [.74, .5])], 4)
  assert.equal(controller.get().preview?.kind, 'sketch')
  frame([hand(1, 'open', [.26, .5]), hand(2, 'open', [.74, .5])], 4)
  await wait()
  assert.equal(controller.get().dialog?.kind, 'dimension')
  assert.equal(f.spoken[0], 'What length?')
  controller.command('100')
  await wait()
  const line = controller.object
  assert.ok(line?.kind === 'sketch' && line.sketch.geometry.kind === 'line')
  assert.equal(line.sketch.geometry.length, 100)

  frame([], 8)
  frame([hand(1, 'pinch', [.51, .5])], 12)
  frame([hand(1, 'pinch', [.51, .27])], 6)
  assert.equal(controller.get().preview?.kind, 'sketch')
  frame([hand(1, 'open', [.51, .27])], 4)
  await wait()
  controller.command('50')
  await wait()
  const rectangle = controller.object
  assert.ok(rectangle?.kind === 'sketch' && rectangle.sketch.geometry.kind === 'rectangle')
  assert.equal(rectangle.sketch.geometry.width, 100)
  assert.equal(rectangle.sketch.geometry.height, 50)

  controller.setTool('extrude')
  const path = sketchPath(rectangle.sketch)
  const center = midpoint(path[0], path[2])
  const handle = f.stage.screen([center[0], center[1], 20])
  frame([], 8)
  frame([hand(1, 'pinch', handle)], 12)
  frame([hand(1, 'pinch', [handle[0], handle[1] - .11])], 5)
  assert.equal(controller.get().preview?.kind, 'extrude')
  frame([hand(1, 'open', handle)], 4)
  controller.command('20')
  await wait()
  const result = model.get().project.objects.filter(isBody)[0]
  assert.ok(result)
  const gesture = measureBody(result)
  assert.deepEqual(sub(gesture.bounds[1], gesture.bounds[0]), [100, 50, 20])
  closeTo(gesture.volume, 100_000)

  const mouse = fixture()
  const input = mouse.controller
  input.setTool('line')
  assert.ok(input.pointerStart([.26, .5]))
  input.pointerMove([.74, .5])
  input.pointerEnd()
  await mouse.wait()
  input.command('100')
  await mouse.wait()
  input.setTool('rectangle')
  assert.ok(input.pointerStart([.5, .5]))
  input.pointerMove([.5, .25])
  input.pointerEnd()
  await mouse.wait()
  input.command('50')
  await mouse.wait()
  input.command('extrude 20')
  await mouse.wait()
  const mouseBody = mouse.model.get().project.objects.filter(isBody)[0]
  assert.deepEqual(measureBody(mouseBody).bounds, gesture.bounds)
})

test('voice phrases and typed quantities set precise cylinder parameters', async () => {
  const { controller, wait } = fixture()
  controller.command('Create a cylinder with diameter 30 and height 70')
  await wait()
  controller.command('Make the height sixty', 'voice', .94)
  await wait()
  const cylinder = controller.object
  assert.ok(cylinder?.kind === 'body' && cylinder.recipe.kind === 'primitive')
  assert.deepEqual(cylinder.recipe.primitive, { kind: 'cylinder', radius: 15, height: 60 })
  closeTo(measureBody(cylinder).volume, Math.PI * 225 * 60)
  assert.equal(quantity('one hundred and twenty'), 120)
  assert.equal(quantity('twelve point five'), 12.5)
  closeTo(quantity('one and a half inches')!, 38.1)
  assert.equal(quantity('two inches'), 50.8)
  assert.equal(quantity('10 centimeters'), 100)
  assert.equal(quantity('-0.025 m'), -25)
  assert.equal(quantity('1/0 in'), undefined)
  assert.deepEqual(parseIntent('rotate ninety degrees around X'), { kind: 'rotate', degrees: 90, axis: 'X' })
  assert.deepEqual(parseIntent('Move it to X zero Y ten and Z twenty'), { kind: 'move', delta: [0, 10, 20], absolute: true })
  assert.deepEqual(parseIntent('Move to zero, zero, twenty'), { kind: 'move', delta: [0, 0, 20], absolute: true })

  controller.setTool('line')
  controller.pointerStart([.25, .5])
  controller.pointerMove([.45, .5])
  controller.pointerEnd()
  await wait()
  controller.command('Two inches', 'voice', .96)
  await wait()
  const sketch = controller.object
  assert.ok(sketch?.kind === 'sketch' && sketch.sketch.geometry.kind === 'line')
  assert.equal(sketch.sketch.geometry.length, 50.8)
  controller.command('50.8')
  await wait()
  const repeated = controller.object
  assert.ok(repeated?.kind === 'sketch' && repeated.sketch.geometry.kind === 'line')
  assert.equal(repeated.sketch.geometry.length, 50.8)
})

test('center on a picked face uses exact planar support and a preview', async () => {
  const target = fixtureBox('Base', [0, 0, 0], 50)
  const cylinder = makeBody('shaft', 'Shaft', { kind: 'primitive', primitive: { kind: 'cylinder', radius: 4, height: 16 } }, { ...identity(), position: [13, 7, 23] })
  const { controller, model, wait } = fixture([target, cylinder])
  controller.click([.49, .5], false)
  controller.select(cylinder.id, true)
  controller.command('Centered', 'voice', .95)
  await wait()
  assert.equal(controller.get().dialog?.kind, 'align')
  assert.equal(controller.get().preview?.kind, 'move')
  assert.deepEqual(model.get().project.objects[1].transform.position, [13, 7, 23])
  controller.confirm()
  await wait()
  const placed = model.get().project.objects.filter(isBody)[1]
  const result = measureBody(placed)
  assert.deepEqual(midpoint(...result.bounds).slice(0, 2), [0, 0])
  closeTo(result.bounds[0][2], 20)
})

test('snap asks attach or fuse and failed disjoint fusion preserves both solids', async () => {
  const moving = fixtureBox('Moving', [35, 0, 0])
  const base = fixtureBox('Base')
  const f = fixture([base, moving])
  const { controller, model, frame, wait } = f
  const drag = () => {
    frame([hand(1, 'open', [.675, .5])], 8)
    frame([hand(1, 'fist', [.675, .5])], 7)
    frame([hand(1, 'fist', [.60, .5])], 6)
    frame([hand(1, 'open', [.60, .5])], 5)
  }
  drag()
  assert.equal(controller.get().dialog?.kind, 'join')
  assert.equal(f.spoken.at(-1), 'Attach or fuse?')
  controller.command('Attach', 'voice', .96)
  await wait()
  assert.equal(model.get().project.objects.length, 2)
  assert.equal(model.get().project.objects.find(o => o.id === moving.id)?.parent, base.id)
  await model.step('undo')
  drag()
  controller.command('Fuse', 'voice', .95)
  assert.equal(controller.get().dialog?.kind, 'voice')
  controller.command('yes', 'voice', .95)
  await wait()
  const fused = model.get().project.objects.filter(isBody)
  assert.equal(fused.length, 1)
  closeTo(measureBody(fused[0]).volume, 16000)
  await model.step('undo')
  controller.select(base.id)
  controller.select(moving.id, true)
  controller.command('Fuse')
  controller.confirm()
  await wait()
  assert.equal(model.get().project.objects.length, 2)
  assert.match(model.get().error!, /form one solid/)
})

test('sketch snaps hold nearby endpoints and preserve their exact slope over auto axis alignment', async () => {
  const { controller, model, stage, wait } = fixture()
  for (const x of [40, 42]) {
    await model.commit({ type: 'sketch', sketch: { frame: planeFrame('XY'), geometry: { kind: 'line', at: [x, 2.6], angle: 90, length: 12 } } })
  }
  controller.setTool('line')
  // Approach the first endpoint and then move closer to the other, inside the release radius.
  assert.ok(controller.pointerStart(stage.screen([0, 0, 0])))
  const drag = (x: number, y: number, bypass = false) => {
    controller.pointerMove(stage.screen([x, y, 0]), 1000, bypass)
    const { preview } = controller.get()
    assert.ok(preview?.kind === 'sketch')
    const [endX, endY] = sketchPath(preview.sketch).at(-1)!
    return { x: endX, y: endY, snap: preview.snap?.kind }
  }
  for (const x of [39.2, 42.1]) {
    const point = drag(x, 2.68)
    assert.equal(point.snap, 'endpoint')
    closeTo(point.x, 40)
    closeTo(point.y, 2.6)
  }
  closeTo(drag(42.35, 2.68).x, 42)
  const free = drag(42.35, 2.68, true)
  assert.equal(free.snap, undefined)
  closeTo(free.x, 42.35)
  closeTo(free.y, 2.68)
  controller.pointerEnd()
  await wait()
  const sketch = controller.object
  assert.ok(sketch?.kind === 'sketch')
  closeTo(sketchPath(sketch.sketch).at(-1)![1], 2.68)
})

test('axis guidance holds across light jitter and releases beyond its screen-space range', () => {
  const { controller, stage } = fixture()
  controller.setTool('line')
  assert.ok(controller.pointerStart(stage.screen([0, 0, 0])))
  for (const [y, expected] of [[1.2, 'axis'], [1.8, 'axis'], [3.6, 'grid']] as const) {
    controller.pointerMove(stage.screen([40, y, 0]))
    const preview = controller.get().preview
    assert.ok(preview?.kind === 'sketch')
    assert.equal(preview.snap?.kind, expected)
    const [x, endY] = sketchPath(preview.sketch).at(-1)!
    closeTo(x, 40)
    closeTo(endY, expected === 'axis' ? 0 : 4)
  }
})

test('contact snapping holds a nearby face, respects the movement plane, and releases to free placement', () => {
  const base = fixtureBox('Base')
  const moving = fixtureBox('Moving', [35, 0, 0])
  const { controller } = fixture([base, moving])
  controller.setTool('move')
  assert.ok(controller.pointerStart([.675, .5]))
  for (const [x, active, expected] of [[.603, true, 20], [.609, true, 20], [.614, false, 23], [.604, true, 20], [.609, false, 21.8]] as const) {
    controller.pointerMove([x, .5], 1000, expected === 21.8)
    const preview = controller.get().preview
    assert.ok(preview?.kind === 'move')
    assert.equal(preview.snap?.kind === 'face', active)
    closeTo(preview.to.position[0], expected)
  }

  const lifted = fixtureBox('Lifted', [35, 0, 20.4])
  const xy = fixture([base, lifted]).controller
  xy.setTool('move')
  assert.ok(xy.pointerStart([.675, .5]))
  xy.pointerMove([.5, .5])
  const preview = xy.get().preview
  assert.ok(preview?.kind === 'move')
  assert.equal(preview.snap, undefined)
  closeTo(preview.to.position[2], 20.4)
})

test('a released move keeps its exact preview visible until the model installs the new placement', async () => {
  const body = fixtureBox('Base')
  const { controller, model, wait } = fixture([body])
  const commit = model.commit
  let release!: () => void
  const worker = new Promise<void>(resolve => { release = resolve })
  model.commit = async command => { await worker; return commit(command) }
  controller.setTool('move')
  assert.ok(controller.pointerStart([.5, .5]))
  controller.pointerMove([.618, .46])
  const preview = controller.get().preview
  assert.ok(preview?.kind === 'move')
  controller.pointerEnd()
  assert.equal(controller.get().preview, preview)
  assert.deepEqual(model.get().project.objects[0].transform.position, [0, 0, 0])
  release()
  await wait()
  assert.deepEqual(model.get().project.objects[0].transform, preview.to)
  assert.equal(controller.get().preview, undefined)
  await model.step('undo')
  assert.deepEqual(model.get().project.objects[0], body)
})

test('a small deliberate hand drag places the body while stationary jitter does not', async () => {
  const { frame, model, wait } = fixture([fixtureBox('Base')])
  const drag = (distance: number) => {
    frame([hand(1, 'open', [.5, .5])], 9)
    frame([hand(1, 'fist', [.5, .5])], 7)
    frame([hand(1, 'fist', [.5 + distance, .5])], 5)
    frame([hand(1, 'open', [.5 + distance, .5])], 5)
  }
  drag(.004)
  await wait()
  assert.deepEqual(model.get().project.objects[0].transform.position, [0, 0, 0])
  drag(.012)
  await wait()
  assert.deepEqual(model.get().project.objects[0].transform.position, [2, 0, 0])
})

test('scissors split a selected solid and history restores complete modeling state', async () => {
  const base = fixtureBox('Base')
  const f = fixture([base])
  const { model, controller, frame, wait } = f
  controller.select(base.id)
  controller.command('Move up 8')
  await wait()
  controller.setTool('cut')
  frame([hand(1, 'scissors', [.4, .5])], 6)
  frame([hand(1, 'scissors', [.65, .5])], 6)
  assert.equal(controller.get().preview?.kind, 'cut')
  frame([hand(1, 'two', [.65, .5])], 4)
  await wait()
  const result = model.get().project.objects.filter(isBody)
  assert.equal(result.length, 2)
  closeTo(result.reduce((total, o) => total + measureBody(o).volume, 0), 8000)
  assert.equal(f.orbitCalls.length, 0)
  await model.step('undo')
  assert.deepEqual(model.get().project.objects[0].transform.position, [0, 0, 8])
  await model.step('undo')
  assert.deepEqual(model.get().project.objects[0].transform.position, [0, 0, 0])
  await model.step('redo')
  await model.step('redo')
  assert.deepEqual(model.get().project.objects, result)
})

test('gesture orbit requires a curved trajectory and leaves objects unchanged', () => {
  const original = fixtureBox('Base')
  const f = fixture([original])
  for (let i = 0; i < 10; i++) f.frame([hand(1, 'two', [.3 + .02 * i, .46])])
  assert.equal(f.orbitCalls.length, 0)
  f.frame([], 17)
  for (let i = 0; i < 13; i++) f.frame([hand(1, 'two', [.5 + .12 * Math.cos(i * .27), .5 + .12 * Math.sin(i * .27)])])
  assert.ok(f.orbitCalls.length > 0)
  assert.deepEqual(f.model.get().project.objects[0], original)
})

test('offscreen drag needs confirmation and tracking loss cancels without a commit', async () => {
  const original = fixtureBox('Base')
  const f = fixture([original])
  const { controller, model, frame, wait } = f
  const grab = () => {
    frame([hand(1, 'open', [.5, .5])], 7)
    frame([hand(1, 'fist', [.5, .5])], 6)
  }
  const outside = () => frame([hand(1, 'fist', [1.08, .5])], 8)
  grab()
  outside()
  frame([], 1)
  assert.equal(controller.get().gesture, 'Tracking paused')
  assert.equal(controller.get().preview?.kind, 'move')
  frame([], 10)
  assert.equal(controller.get().preview, undefined)
  assert.deepEqual(model.get().project.objects[0], original)

  for (const confirm of [false, true]) {
    grab()
    outside()
    frame([hand(1, 'open', [1.06, .5])], 4)
    assert.equal(controller.get().dialog?.kind, 'delete')
    controller.command('yes', 'voice', .31)
    assert.equal(model.get().project.objects.length, 1)
    controller.command(confirm ? 'yes' : 'no', 'voice', .95)
    await wait()
    assert.equal(model.get().project.objects.length, confirm ? 0 : 1)
  }
  await model.step('undo')
  assert.deepEqual(model.get().project.objects[0], original)
})

test('editable project reconstruction, blind hole and rectangular cutout retain exact volumes', () => {
  const base = fixtureBox('Plate', [0, 0, 0], 60)
  const tool = makeBody('drill', 'Drill', { kind: 'primitive', primitive: { kind: 'cylinder', radius: 4, height: 30 } }, { ...identity(), position: [0, 0, -5] })
  let project = { ...blankProject(), objects: [base, tool] } as Project
  project = execute(project, { type: 'boolean', operation: 'subtract', target: base.id, tool: tool.id }).project
  const saved = JSON.stringify(project)
  const loaded = readProject(JSON.parse(saved))
  assert.deepEqual(loaded, JSON.parse(saved))
  const [difference] = loaded.objects.filter(isBody)
  closeTo(measureBody(difference).volume, 24000 - Math.PI * 16 * 20)
  const blind = execute(loaded, { type: 'hole', id: difference.id, mode: 'blind', at: [16, 0, 20], normal: [0, 0, 1], width: 6, height: 6, depth: 8 }).project
  closeTo(measureBody(blind.objects.filter(isBody)[0]).volume, 24000 - Math.PI * 16 * 20 - Math.PI * 9 * 8)
  const rect = execute(blind, { type: 'hole', id: difference.id, mode: 'rectangular', at: [-16, 0, 20], normal: [0, 0, 1], width: 8, height: 12, depth: 60 }).project
  closeTo(measureBody(rect.objects.filter(isBody)[0]).volume, 24000 - Math.PI * 16 * 20 - Math.PI * 9 * 8 - 8 * 12 * 20)
  assert.throws(() => readProject({ ...project, version: 2 }), /unsupported/)
  assert.throws(() => readProject({ ...project, objects: [{ ...difference, parent: difference.id }] }), /circular/)
})

test('negative extrusion, scaling and open-sketch rejection preserve precise parameters', () => {
  const blank = blankProject()
  const rectangle = execute(blank, { type: 'sketch', sketch: { frame: planeFrame('XY'), geometry: { kind: 'rectangle', at: [0, 0], angle: 0, width: 20, height: 40 } } })
  const extruded = execute(rectangle.project, { type: 'extrude', id: rectangle.selection[0], depth: -12 })
  const [body] = extruded.project.objects.filter(isBody)
  closeTo(measureBody(body).bounds[0][2], -12)
  const reparam = execute(extruded.project, { type: 'parameter', id: rectangle.selection[0], key: 'width', value: 30 })
  closeTo(measureBody(reparam.project.objects.filter(isBody)[0]).volume, 14400)
  const scaled = { ...body, transform: { ...identity(), scale: [2, 1, .5] as Vec3 } }
  assert.deepEqual(measureBody(scaled).bounds, [[0, 0, -6], [40, 40, 0]])
  const line = execute(blank, { type: 'sketch', sketch: { frame: planeFrame('XY'), geometry: { kind: 'line', at: [0, 0], angle: 0, length: 20 } } })
  assert.throws(() => execute(line.project, { type: 'extrude', id: line.selection[0], depth: 20 }), /closed sketch/)
})

test('spoken names and follow-up phrases edit the intended solid without a pointer', async () => {
  const { controller, model, wait, spoken } = fixture()
  assert.equal(controller.command('Hey HOLO-CAD, create a red box 50 by 30 by 20', 'voice', .96), true)
  await wait()
  controller.command('Rename it to Mounting Base', 'voice', .96)
  await wait()
  controller.command('Build a cylinder thirty millimeters wide and sixty tall', 'voice', .96)
  await wait()
  controller.command('Select the base', 'voice', .96)
  assert.equal(controller.object?.name, 'Mounting Base')
  controller.command('What is selected?', 'voice', .96)
  assert.match(spoken.at(-1)!, /Mounting Base is selected/)
  controller.command('Make it taller by five', 'voice', .96)
  await wait()
  controller.command('Set that to forty', 'voice', .96)
  await wait()
  controller.command('Make it five millimeters wider', 'voice', .96)
  await wait()
  controller.command('Move the base up ten millimeters', 'voice', .96)
  await wait()
  const base = controller.object
  assert.ok(base && isBody(base))
  assert.equal(base.color, '#d87377')
  const bounds = measureBody(base).bounds
  assert.deepEqual(sub(bounds[1], bounds[0]), [55, 30, 40])
  assert.equal(bounds[0][2], 10)
  controller.command('How tall is it?', 'voice', .96)
  assert.match(spoken.at(-1)!, /40\.00 mm/)
  controller.command('Select the base and cylinder one', 'voice', .96)
  assert.equal(model.get().selection.length, 2)
  assert.equal(controller.object?.name, 'Cylinder 1')
  controller.command('Set that to sixty', 'voice', .95)
  assert.match(model.get().error!, /specific dimension/)
  assert.equal(controller.command('the weather is much colder today', 'voice', .98), false)
})

test('cut confirmations through an always-running recognizer require reliable speech', async () => {
  const { controller, model, wait } = fixture([fixtureBox('Base')])
  const original = model.get().project
  assert.equal(controller.command('yes', 'voice', .97), false)
  controller.command('split the base', 'voice', .96)
  assert.equal(controller.get().dialog?.kind, 'cut')
  controller.command('go ahead', 'voice', .2)
  assert.equal(model.get().project, original)
  controller.command('keep both pieces', 'voice', .96)
  await wait()
  assert.equal(model.get().project.objects.filter(isBody).length, 2)
})

test('new hand signs select, confirm, fit, undo, and redo on a single hold', async () => {
  const { controller, model, frame, wait, stage } = fixture([fixtureBox('Base')])
  const views: string[] = []
  stage.view = value => { views.push(value) }
  frame([hand(1, 'point', [.5, .5])], 18)
  assert.equal(controller.object?.name, 'Base')
  frame([], 16)
  frame([hand(1, 'three', [.5, .5])], 36)
  assert.deepEqual(views, ['fit'])
  frame([], 16)
  controller.command('create rectangle 30 by 20')
  await wait()
  controller.command('extrude')
  frame([hand(1, 'thumbs-up', [.55, .5])], 18)
  await wait()
  assert.equal(model.get().project.objects.filter(isBody).length, 2)
  frame([], 16)
  frame([hand(1, 'horns', [.55, .5])], 36)
  await wait()
  assert.equal(model.get().project.objects.filter(isBody).length, 1)
  assert.equal(model.get().project.objects.filter(o => o.kind === 'sketch').length, 1)
  frame([], 16)
  frame([hand(1, 'shaka', [.55, .5])], 36)
  await wait()
  assert.equal(model.get().project.objects.filter(isBody).length, 2)
  controller.command('delete')
  frame([], 16)
  frame([hand(1, 'thumbs-up', [.55, .5])], 20)
  assert.equal(controller.get().dialog?.kind, 'delete')
  frame([], 16)
  frame([hand(1, 'thumbs-down', [.55, .5])], 20)
  assert.equal(controller.get().dialog, undefined)
  assert.equal(model.get().project.objects.filter(isBody).length, 2)
})

async function waitForPreview(controller: InteractionController, phase: 'ready' | 'invalid') {
  for (let i = 0; i < 120; i++) {
    const dialog = controller.get().dialog
    if ((dialog?.kind === 'chamfer' || dialog?.kind === 'holePattern') && dialog.phase === phase) return dialog
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  assert.fail('Preview did not reach ' + phase + ': ' + JSON.stringify(controller.get().dialog))
}

test('voice-only mounting plate workflow applies one editable four-hole feature and exports STEP', async () => {
  const { controller, model, wait, exports } = fixture()
  const say = (command: string) => assert.equal(controller.command(command, 'voice', .98), true, command)
  say('Create a box 100 by 60 by 7')
  await wait()
  say('Rename it to Voice Test Plate')
  await wait()
  say('Make it 8 millimeters tall')
  await wait()
  const before = controller.object
  assert.ok(before && isBody(before))
  assert.equal(before.name, 'Voice Test Plate')
  closeTo(measureBody(before).volume, 48000)

  say('Add four 6 mm through-holes to the top face, 10 mm in from the corners')
  const first = controller.get().preview
  assert.ok(first?.kind === 'holePattern')
  assert.equal(first.diameter, 6)
  assert.equal(first.points.length, 4)
  assert.deepEqual(first.points.map(p => p.join(',')).sort(), ['-40,-20,8', '-40,20,8', '40,-20,8', '40,20,8'])

  say('Make them 50 mm')
  await waitForPreview(controller, 'invalid')
  say('Apply')
  assert.equal(controller.object, before)
  say('Make them 8 mm')
  const draft = await waitForPreview(controller, 'ready')
  assert.equal(draft.kind === 'holePattern' && draft.pattern.diameter, 8)
  assert.equal(controller.object, before)
  say('Apply')
  await wait()
  const perforated = controller.object
  assert.ok(perforated && isBody(perforated) && perforated.recipe.kind === 'holePattern')
  assert.equal(perforated.id, before.id)
  assert.equal(perforated.recipe.pattern.inset, 10)
  closeTo(measureBody(perforated).volume, 48000 - 4 * Math.PI * 4 ** 2 * 8)

  say('Undo')
  await wait()
  assert.equal(controller.object, before)
  say('Redo')
  await wait()
  assert.equal(controller.object, perforated)
  say('Export STEP')
  assert.equal(exports.length, 1)
  const reopened = await importBodies(exports[0])
  assert.equal(reopened.length, 1)
  const part = makeBody('from-step', 'STEP plate', { kind: 'brep', data: reopened[0] })
  closeTo(measureBody(part).volume, measureBody(perforated).volume, .0001)
  const saved = readProject(JSON.parse(JSON.stringify(model.get().project))).objects[0]
  assert.ok(isBody(saved))
  closeTo(measureBody(saved).volume, measureBody(perforated).volume)

  say('Set hole diameter to ten')
  await wait()
  const adjusted = controller.object
  assert.ok(adjusted && isBody(adjusted) && adjusted.recipe.kind === 'holePattern')
  closeTo(measureBody(adjusted).volume, 48000 - 4 * Math.PI * 5 ** 2 * 8)
})

test('a missing hole-pattern face asks for clarification and cancellation drops a queued preview', async () => {
  const original = fixtureBox('Plate', [2, 3, 4], 100)
  const { controller, model, spoken } = fixture([original])
  controller.select(original.id)
  controller.command('Create a hole pattern')
  const dialog = controller.get().dialog
  assert.ok(dialog?.kind === 'holePattern')
  assert.equal(dialog.phase, 'choosing')
  assert.match(spoken.at(-1)!, /Which face/)
  assert.equal(controller.get().preview, undefined)
  controller.command('Use top face')
  const chosen = controller.get().dialog
  assert.ok(chosen?.kind === 'holePattern' && chosen.face?.rectangle)
  controller.command('Cancel')
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(controller.get().dialog, undefined)
  assert.equal(model.get().project.objects[0], original)
})

test('pointing and speaking chamfers only the highlighted edge after approval', async () => {
  const object = makeBody('plate', 'Plate', { kind: 'primitive', primitive: { kind: 'box', width: 100, length: 60, height: 8 } })
  const { controller, model, stage, wait } = fixture([object])
  controller.command('Chamfer this by 2 mm', 'voice', .97)
  assert.match(model.get().error!, /exposed edge/)
  assert.equal(controller.get().dialog, undefined)
  const mesh = model.get().meshes[object.id]
  const range = mesh.edgeRanges.find(part => {
    const { start, end } = part.reference
    return start[2] === 8 && end[2] === 8 && Math.abs(end[0] - start[0]) > 90
  })
  assert.ok(range)
  const segments: Vec3[] = []
  for (let i = range.start; i < range.start + range.count; i++) segments.push(Array.from(mesh.lines.slice(i * 3, i * 3 + 3)) as Vec3)
  stage.edgeAt = () => ({ id: object.id, reference: range.reference, segments })
  controller.tracking([hand(1, 'point', [.5, .5])])
  assert.equal(controller.get().aimedEdge?.reference, range.reference)
  controller.command('Chamfer this by 2 mm', 'voice', .98)
  const preview = await waitForPreview(controller, 'ready')
  assert.equal(preview.kind === 'chamfer' && preview.distance, 2)
  assert.equal(model.get().project.objects[0], object)

  controller.command('Set chamfer size to 100 mm')
  const invalid = await waitForPreview(controller, 'invalid')
  assert.match(invalid.error!, /smaller distance/)
  controller.command('Set chamfer size to 2 mm')
  await waitForPreview(controller, 'ready')
  controller.command('Apply', 'voice', .98)
  await wait()
  const beveled = controller.object
  assert.ok(beveled && isBody(beveled) && beveled.recipe.kind === 'chamfer')
  closeTo(measureBody(beveled).volume, 47800)
  controller.command('Set chamfer size to 1 mm')
  await wait()
  const edited = controller.object
  assert.ok(edited && isBody(edited))
  closeTo(measureBody(edited).volume, 47950)
  const saved = readProject(JSON.parse(JSON.stringify(model.get().project))).objects[0]
  assert.ok(isBody(saved))
  closeTo(measureBody(saved).volume, 47950)
})
