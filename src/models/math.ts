import type { Axis, Frame, Geometry, PlaneName, Sketch, Unit, Vec2, Vec3 } from './project'

export const AXES: Record<Axis, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }
export const DEG = Math.PI / 180
export const EPS = 1e-5
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const mul = (a: Vec3, b: number): Vec3 => [a[0] * b, a[1] * b, a[2] * b]
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const norm = (a: Vec3) => Math.hypot(...a)
export const unit = (a: Vec3): Vec3 => norm(a) > EPS ? mul(a, 1 / norm(a)) : [0, 0, 0]
export const midpoint = (a: Vec3, b: Vec3) => mul(add(a, b), .5)
export const axisIndex = (axis: Axis) => 'XYZ'.indexOf(axis)
export const planeNormal = ({ u, v }: Frame) => unit(cross(u, v))
export const onPlane = ({ origin, u, v }: Frame, [x, y]: Vec2) => add(origin, add(mul(u, x), mul(v, y)))
export const toPlane = ({ origin, u, v }: Frame, p: Vec3): Vec2 => [dot(sub(p, origin), u), dot(sub(p, origin), v)]

export function planeFrame(name: PlaneName, origin: Vec3 = [0, 0, 0]): Frame {
  return { origin, u: name === 'YZ' ? AXES.Y : AXES.X, v: name === 'XY' ? AXES.Y : AXES.Z }
}

export function orientedFrame(origin: Vec3, normal: Vec3, preferredX?: Vec3): Frame {
  const n = unit(normal)
  if (norm(n) < EPS) throw new Error('The plane needs a direction.')
  const fallback = Math.abs(n[0]) < .92 ? AXES.X : AXES.Y
  const x = preferredX && norm(cross(preferredX, n)) > EPS ? preferredX : fallback
  const u = unit(sub(x, mul(n, dot(x, n))))
  return { origin, u, v: cross(n, u) }
}

export function lineGeometry(start: Vec2, end: Vec2, snapAxis = false): Extract<Geometry, { kind: 'line' }> {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const angle = Math.atan2(dy, dx) / DEG
  const nearest = Math.round(angle / 90) * 90
  return { kind: 'line', at: start, angle: snapAxis && Math.abs(angle - nearest) < 7 ? nearest : angle, length: Math.hypot(dx, dy) }
}

export function extendLine(line: Extract<Geometry, { kind: 'line' }>, point: Vec2): Extract<Geometry, { kind: 'rectangle' }> {
  const angle = line.angle * DEG
  const height = (point[1] - line.at[1]) * Math.cos(angle) - (point[0] - line.at[0]) * Math.sin(angle)
  return { kind: 'rectangle', at: line.at, angle: line.angle, width: line.length, height }
}

export function sketchPath(sketch: Sketch, segments = 72): Vec3[] {
  const { frame, geometry: g } = sketch
  const point = (at: Vec2, x: number, y: number, angle = 0): Vec2 => {
    const a = angle * DEG
    return [at[0] + x * Math.cos(a) - y * Math.sin(a), at[1] + x * Math.sin(a) + y * Math.cos(a)]
  }
  let points: Vec2[]
  switch (g.kind) {
    case 'point': points = [g.at]; break
    case 'line': points = [g.at, point(g.at, g.length, 0, g.angle)]; break
    case 'rectangle':
      points = [[0, 0], [g.width, 0], [g.width, g.height], [0, g.height], [0, 0]]
        .map(([x, y]) => point(g.at, x, y, g.angle))
      break
    case 'polyline': points = g.closed ? [...g.points, g.points[0]] : g.points; break
    case 'circle': case 'ellipse': case 'arc': {
      const rx = g.kind === 'ellipse' ? g.radiusX : g.radius
      const ry = g.kind === 'ellipse' ? g.radiusY : g.radius
      const start = g.kind === 'arc' ? g.startAngle : 0
      const sweep = g.kind === 'arc' ? g.sweep : 360
      points = Array.from({ length: segments + 1 }, (_, i) => {
        const a = (start + sweep * i / segments) * DEG
        return point(g.at, rx * Math.cos(a), ry * Math.sin(a), g.kind === 'ellipse' ? g.angle : 0)
      })
      break
    }
  }
  return points.map(p => onPlane(frame, p))
}

export const closedSketch = (g: Geometry) => ['rectangle', 'circle', 'ellipse'].includes(g.kind) || (g.kind === 'polyline' && g.closed)

export const UNIT_FACTORS: Record<Unit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 }
export const displayValue = (mm: number, units: Unit) => mm / UNIT_FACTORS[units]
export const formatDimension = (mm: number, units: Unit, precision: number) => displayValue(mm, units).toFixed(precision) + ' ' + units
