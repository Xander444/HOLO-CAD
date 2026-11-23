import type { BodyGeometry, Bounds, FaceReference } from '../cad/kernel'
import type { RenderGeometry } from '../cad/protocol'
import type { Axis, Entity, Frame, Unit, Vec2, Vec3 } from '../models/project'
import { AXES, add, axisIndex, dot, midpoint, mul, norm, onPlane, sub, toPlane, planeNormal, sketchPath } from '../models/math'
import { matrixOf, transformPoint } from '../models/transforms'
import type { Settings, SnapKind } from './settings'
import type { AlignMode } from '../voice/parser'
import type { ScreenPoint } from '../vision/tracking'
import type { StagePort } from './types'

export type Snap = { kind: SnapKind; at: Vec3 }
export type SnapTargets = { anchors: Snap[]; meshes: BodyGeometry[] }
type Projection = Pick<StagePort, 'dimensions' | 'screen'>
const releaseFactor = 1.4

export const snapNames: Record<SnapKind, string> = {
  grid: 'Grid', origin: 'Origin', endpoint: 'Endpoint', midpoint: 'Midpoint', center: 'Center', vertex: 'Vertex', edge: 'Edge', face: 'Face', axis: 'Axis',
}

export function pixelDistance(a: ScreenPoint, b: ScreenPoint, [width, height]: ScreenPoint) {
  return Math.hypot((a[0] - b[0]) * width, (a[1] - b[1]) * height)
}

export function collectSnapTargets(objects: Entity[], geometry: RenderGeometry): SnapTargets {
  const anchors: Snap[] = [{ kind: 'origin', at: [0, 0, 0] }]
  const meshes: BodyGeometry[] = []
  for (const object of objects) {
    if (object.hidden) continue
    const mesh = geometry[object.id]
    if (object.kind === 'body' && mesh) {
      meshes.push(mesh)
      anchors.push(...mesh.snaps, { kind: 'center', at: midpoint(...mesh.bounds) })
    } else if (object.kind === 'sketch') {
      const { sketch, transform } = object
      const matrix = matrixOf(transform)
      const path = sketchPath(sketch).map(p => transformPoint(p, matrix))
      const shape = sketch.geometry
      if (shape.kind === 'circle' || shape.kind === 'ellipse' || shape.kind === 'arc') {
        anchors.push({ kind: 'center', at: transformPoint(onPlane(sketch.frame, shape.at), matrix) })
        if (shape.kind !== 'arc') continue
      }
      if (shape.kind === 'rectangle' || shape.kind === 'polyline') {
        const closed = shape.kind === 'rectangle' || shape.closed
        for (let i = 0; i < path.length - Number(closed); i++) {
          const kind = !closed && (i === 0 || i === path.length - 1) ? 'endpoint' : 'vertex'
          anchors.push({ kind, at: path[i] })
        }
        for (let i = 1; i < path.length; i++) anchors.push({ kind: 'midpoint', at: midpoint(path[i - 1], path[i]) })
      } else if (path.length) {
        anchors.push({ kind: 'endpoint', at: path[0] })
        if (path.length > 1) anchors.push({ kind: 'endpoint', at: path.at(-1)! })
        if (shape.kind === 'line') anchors.push({ kind: 'midpoint', at: midpoint(path[0], path[1]) })
      }
    }
  }
  return { anchors, meshes }
}

function closestEdge(point: Vec3, frame: Frame, normal: Vec3, lines: Float32Array) {
  let closest = Infinity
  let edge: Vec3 | undefined
  for (let i = 0; i + 5 < lines.length; i += 6) {
    const from: Vec3 = [lines[i], lines[i + 1], lines[i + 2]]
    const to: Vec3 = [lines[i + 3], lines[i + 4], lines[i + 5]]
    const a = dot(sub(from, frame.origin), normal), b = dot(sub(to, frame.origin), normal)
    const delta = sub(to, from)
    const squared = dot(delta, delta)
    if (squared < 1e-12) continue
    let t: number
    if (Math.abs(a) <= .015 && Math.abs(b) <= .015) t = Math.min(1, Math.max(0, dot(sub(point, from), delta) / squared))
    else if (a * b <= 0 && a !== b) t = a / (a - b)
    else continue
    const at = add(from, mul(delta, t))
    const difference = sub(at, point)
    const distance = dot(difference, difference)
    if (distance < closest) { closest = distance; edge = at }
  }
  return edge
}

export function snapPoint(
  point: Vec3, frame: Frame, settings: Settings, view: Projection, targets: SnapTargets, held?: Snap,
): { point: Vec3; snap?: Snap } {
  if (!settings.snap) return { point }
  const cursor = view.screen(point)
  const size = view.dimensions
  const radius = 8 * settings.snapStrength
  const normal = planeNormal(frame)
  const eligible = (snap: Snap) => settings.snapTypes[snap.kind] && Math.abs(dot(sub(snap.at, frame.origin), normal)) <= .015
  if (held && eligible(held) && targets.anchors.includes(held) && pixelDistance(cursor, view.screen(held.at), size) <= radius * releaseFactor) {
    return { point: held.at, snap: held }
  }
  let nearest: Snap | undefined
  let best = Infinity
  for (const target of targets.anchors) {
    if (!eligible(target)) continue
    const distance = pixelDistance(cursor, view.screen(target.at), size)
    if (distance <= radius && distance < best) { nearest = target; best = distance }
  }
  // Precise anchors take priority over a continuous edge within a few pixels.
  const edgeBias = 3 * settings.snapStrength
  if (settings.snapTypes.edge && best > edgeBias) for (const mesh of targets.meshes) {
    const at = closestEdge(point, frame, normal, mesh.lines)
    if (!at) continue
    const distance = pixelDistance(cursor, view.screen(at), size) + edgeBias
    if (distance <= radius && distance < best) { nearest = { kind: 'edge', at }; best = distance }
  }
  if (nearest) return { point: nearest.at, snap: nearest }
  if (!settings.snapTypes.grid) return { point }
  const at = onPlane(frame, toPlane(frame, point).map(x => roundToGrid(x, settings.grid)) as Vec2)
  return { point: at, snap: { kind: 'grid', at } }
}

export function roundToGrid(value: number, increment: number) { return Math.round(value / increment) * increment }

export function snapLineAxis(
  start: Vec2, raw: Vec2, end: Vec2, world: (p: Vec2) => Vec3, view: Projection, strength: number, previous?: 0 | 1,
): { axis: 0 | 1; point: Vec2; snap: Snap } | undefined {
  const dx = raw[0] - start[0], dy = raw[1] - start[1]
  const axis = Math.abs(dx) >= Math.abs(dy) ? 0 : 1
  const holding = previous === axis
  const angle = holding ? .145 : .095
  if (Math.abs(axis === 0 ? dy : dx) > Math.abs(axis === 0 ? dx : dy) * angle) return
  const point: Vec2 = axis === 0 ? [end[0], start[1]] : [start[0], end[1]]
  const at = world(point)
  const radius = 6 * strength * (holding ? releaseFactor : 1)
  if (pixelDistance(view.screen(world(raw)), view.screen(at), view.dimensions) > radius) return
  return { axis, point, snap: { kind: 'axis', at } }
}

export function constrained(delta: Vec3, axis?: Axis): Vec3 {
  return axis ? mul(AXES[axis], delta[axisIndex(axis)]) : delta
}

export function faceAt(mesh: BodyGeometry, point: Vec3, normal: Vec3): FaceReference | undefined {
  return mesh.faces.filter(face => dot(face.normal, normal) > .995 && Math.abs(dot(sub(point, face.at), face.normal)) < .05)
    .sort((a, b) => norm(sub(a.at, point)) - norm(sub(b.at, point)))[0]
}

export function alignBounds(moving: Bounds, reference: Bounds, mode: AlignMode, face?: FaceReference, support?: number): Vec3 {
  const a = midpoint(...moving), b = midpoint(...reference)
  const delta = sub(b, a)
  if (['X', 'Y', 'Z'].includes(mode)) return constrained(delta, mode as Axis)
  if (mode === 'left') return [reference[0][0] - moving[0][0], 0, 0]
  if (mode === 'top') return [0, 0, reference[1][2] - moving[1][2]]
  if (face && ['face', 'center', 'flush'].includes(mode)) {
    const corners = boxCorners(moving)
    const min = support ?? Math.min(...corners.map(p => dot(p, face.normal)))
    const gap = dot(face.at, face.normal) - min
    return mode === 'flush' ? mul(face.normal, gap) : add(sub(face.at, a), mul(face.normal, dot(a, face.normal) - min))
  }
  if (mode === 'flush') return [0, 0, reference[1][2] - moving[0][2]]
  return delta
}

export function boxCorners([a, b]: Bounds): Vec3[] {
  return [a[0], b[0]].flatMap(x => [a[1], b[1]].flatMap(y => [a[2], b[2]].map(z => [x, y, z] as Vec3)))
}

type Contact = { key: string; id: string; delta: Vec3; snap: Snap; face?: FaceReference }
export function snapContact(moving: BodyGeometry, delta: Vec3, candidates: { id: string; mesh: BodyGeometry }[], {
  view, settings, axis, normal, held,
}: { view: Projection; settings: Settings; axis?: Axis; normal?: Vec3; held?: string }): Contact | undefined {
  if (!settings.snap) return
  let nearest: Contact | undefined
  let retained: Contact | undefined
  let min = Infinity
  const [a, b] = moving.bounds.map(p => add(p, delta)) as Bounds
  const center = midpoint(a, b)
  const screenCenter = view.screen(center)
  const dimensions = view.dimensions
  const tolerance = 2.4 * settings.snapStrength
  const radius = 7 * settings.snapStrength
  const nearby = tolerance * (held ? releaseFactor : 1)
  const kinds = settings.snapTypes
  const size = b.map((x, i) => x - a[i])
  const sourcePoints: Snap[] = moving.snaps.filter(p => kinds[p.kind]).slice(0, 72)
  if (kinds.center) sourcePoints.push({ kind: 'center', at: midpoint(...moving.bounds) })
  function consider(id: string, key: string, adjustment: Vec3, snap: Snap, face?: FaceReference) {
    const same = key === held
    const range = same ? releaseFactor : 1
    const distance = norm(adjustment)
    if (distance > tolerance * range || (!same && distance >= min)) return
    if (axis && norm(sub(adjustment, constrained(adjustment, axis))) > .015) return
    if (normal && Math.abs(dot(adjustment, normal)) > .015) return
    if (pixelDistance(screenCenter, view.screen(add(center, adjustment)), dimensions) > radius * range) return
    const contact = { id, key, delta: add(delta, adjustment), snap, face }
    if (same) retained = contact
    else { nearest = contact; min = distance }
  }
  for (const { id, mesh } of candidates) {
    const [low, high] = mesh.bounds
    const close = a.every((x, i) => x <= high[i] + nearby && b[i] >= low[i] - nearby)
    if (!close) continue
    if (kinds.face) for (const [i, face] of mesh.faces.entries()) {
      // Axis-aligned planar supports can be checked exactly from the solid bounds.
      if (Math.max(...face.normal.map(Math.abs)) < .9999) continue
      const extreme = face.normal.map((n, i) => n < 0 ? b[i] : a[i]) as Vec3
      const support = dot(extreme, face.normal)
      const d = dot(face.at, face.normal) - support
      const alignment = Math.abs(dot(sub(center, face.at), face.normal))
      if (alignment > Math.max(...size) * .8 + nearby || !moving.faces.some(f => dot(f.normal, face.normal) < -.999)) continue
      const projected = add(center, mul(face.normal, dot(sub(face.at, center), face.normal)))
      if (!projected.every((v, i) => v > low[i] - size[i] / 2 && v < high[i] + size[i] / 2)) continue
      consider(id, id + ':face:' + i, mul(face.normal, d), { kind: 'face', at: face.at }, face)
    }
    const targetPoints: Snap[] = mesh.snaps.filter(p => kinds[p.kind]).slice(0, 72)
    if (kinds.center) targetPoints.push({ kind: 'center', at: midpoint(low, high) })
    for (const [i, source] of sourcePoints.entries()) {
      const from = add(source.at, delta)
      for (const [j, target] of targetPoints.entries()) {
        const adjustment = sub(target.at, from)
        if (adjustment.every(n => Math.abs(n) <= nearby)) consider(id, id + ':point:' + i + ':' + j, adjustment, target)
      }
    }
    if (retained) return retained
  }
  return nearest
}

export function unitsPerStep(units: Unit) {
  return units === 'in' ? .01 : units === 'm' ? .001 : .1
}
