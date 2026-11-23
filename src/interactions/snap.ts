import type { BodyGeometry, Bounds, FaceReference } from '../cad/kernel'
import type { Axis, Frame, Unit, Vec3 } from '../models/project'
import { AXES, add, axisIndex, dot, midpoint, mul, norm, onPlane, sub, toPlane, planeNormal } from '../models/math'
import type { Settings, SnapKind } from './settings'
import type { AlignMode } from '../voice/parser'
import type { ScreenPoint } from '../vision/tracking'

export type Snap = { kind: SnapKind; at: Vec3 }
export function snapPoint(
  point: Vec3, frame: Frame, settings: Settings, screen: (p: Vec3) => ScreenPoint,
  meshes: BodyGeometry[], paths: Vec3[][],
): { point: Vec3; snap?: Snap } {
  if (!settings.snap) return { point }
  const candidates: Snap[] = [{ kind: 'origin', at: [0, 0, 0] }]
  for (const m of meshes) {
    candidates.push(...m.snaps, { kind: 'center', at: midpoint(...m.bounds) })
    if (settings.snapTypes.edge) {
      let closest = Infinity
      let edge: Vec3 | undefined
      for (let i = 0; i + 5 < m.lines.length; i += 6) {
        const from = m.lines.slice(i, i + 3) as unknown as Vec3
        const to = m.lines.slice(i + 3, i + 6) as unknown as Vec3
        const delta = sub(to, from)
        const distance = dot(delta, delta)
        if (distance < 1e-12) continue
        const projected = add(from, mul(delta, Math.min(1, Math.max(0, dot(sub(point, from), delta) / distance))))
        const offset = norm(sub(projected, point))
        if (offset < closest) { closest = offset; edge = projected }
      }
      if (edge) candidates.push({ kind: 'edge', at: edge })
    }
  }
  for (const path of paths) {
    if (!path.length) continue
    candidates.push({ kind: 'endpoint', at: path[0] }, { kind: 'endpoint', at: path.at(-1)! })
    if (path.length === 2) candidates.push({ kind: 'midpoint', at: midpoint(path[0], path[1]) })
  }
  const cursor = screen(point)
  const normal = planeNormal(frame)
  let nearest: { snap: Snap; distance: number } | undefined
  for (const target of candidates) {
    if (!settings.snapTypes[target.kind] || Math.abs(dot(sub(target.at, frame.origin), normal)) > .015) continue
    const p = screen(target.at)
    const distance = Math.hypot(cursor[0] - p[0], cursor[1] - p[1])
    if (distance < .022 * settings.snapStrength && (!nearest || nearest.distance > distance)) nearest = { snap: target, distance }
  }
  if (nearest) return { point: nearest.snap.at, snap: nearest.snap }
  if (!settings.snapTypes.grid) return { point }
  const size = settings.grid
  const p = toPlane(frame, point).map(x => Math.round(x / size) * size) as [number, number]
  return { point: onPlane(frame, p) }
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

export function snapContact(
  moving: BodyGeometry, delta: Vec3, candidates: { id: string; mesh: BodyGeometry }[], strength: number, axis?: Axis,
  kinds?: Settings['snapTypes'],
): { id: string; delta: Vec3; at: Vec3; face?: FaceReference } | undefined {
  let nearest: ReturnType<typeof snapContact>
  let min = Infinity
  const [a, b] = moving.bounds.map(p => add(p, delta)) as Bounds
  const center = midpoint(a, b)
  const tolerance = 2.4 * strength
  const allowed = (adjustment: Vec3) => !axis || norm(sub(adjustment, constrained(adjustment, axis))) < .015
  function consider(target: string, adjustment: Vec3, at: Vec3, face?: FaceReference) {
    const distance = norm(adjustment)
    if (!allowed(adjustment) || distance > tolerance || distance >= min) return
    min = distance
    nearest = { id: target, delta: add(delta, adjustment), at, face }
  }
  for (const { id, mesh } of candidates) {
    const [low, high] = mesh.bounds
    const size = b.map((x, i) => x - a[i])
    const close = a.every((x, i) => x < high[i] + tolerance && b[i] > low[i] - tolerance)
    if (!close) continue
    if (!kinds || kinds.face) for (const face of mesh.faces) {
      const support = Math.min(...boxCorners([a, b]).map(p => dot(p, face.normal)))
      const d = dot(face.at, face.normal) - support
      const alignment = Math.abs(dot(sub(center, face.at), face.normal))
      if (alignment > Math.max(...size) * .8 + tolerance) continue
      const opposed = moving.faces.some(f => dot(f.normal, face.normal) < -.999)
      if (!opposed) continue
      // Axis-aligned planar supports can be checked exactly from the solid bounds.
      if (Math.max(...face.normal.map(Math.abs)) < .9999) continue
      const projected = add(center, mul(face.normal, dot(sub(face.at, center), face.normal)))
      if (!projected.every((v, i) => v > low[i] - size[i] / 2 && v < high[i] + size[i] / 2)) continue
      consider(id, mul(face.normal, d), face.at, face)
    }
    const sourcePoints: Vec3[] = moving.snaps.filter(p => !kinds || kinds[p.kind]).slice(0, 72).map(p => add(p.at, delta))
    if (!kinds || kinds.center) sourcePoints.push(center)
    const targetPoints = mesh.snaps.filter(p => !kinds || kinds[p.kind]).slice(0, 72).map(p => p.at)
    if (!kinds || kinds.center) targetPoints.push(midpoint(low, high))
    for (const from of sourcePoints) for (const at of targetPoints) {
      const adjust = sub(at, from)
      if (adjust.every(n => Math.abs(n) < tolerance)) consider(id, adjust, at)
    }
  }
  return nearest
}

export function unitsPerStep(units: Unit) {
  return units === 'in' ? .01 : units === 'm' ? .001 : .1
}
