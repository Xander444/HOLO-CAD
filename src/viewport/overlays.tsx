import { MoveUpRight, Plus } from 'lucide-react'
import type { BodyGeometry } from '../cad/kernel'
import type { Dialog, Preview } from '../interactions/types'
import { snapNames } from '../interactions/snap'
import { shapeOf, sizeFields } from '../interactions/sizing'
import type { Entity, Sketch, Transform, Unit, Vec3 } from '../models/project'
import { add, formatDimension, midpoint, mul, norm, onPlane, planeNormal, sketchPath, sub } from '../models/math'
import { matrixOf, transformPoint } from '../models/transforms'
import type { ScreenPoint, TrackedHand } from '../vision/tracking'
import type { CadScene } from './scene'

type Segment = { from: Vec3; to: Vec3; value: number; label?: string; hint?: string; tone?: 'amber' | 'cyan'; prefix?: string; offset?: number }
const center = (points: Vec3[]): Vec3 => [0, 1, 2].map(i => (Math.min(...points.map(p => p[i])) + Math.max(...points.map(p => p[i]))) / 2) as Vec3

function primitiveDimension(preview: Extract<Preview, { kind: 'primitive' }>, dialog: Extract<Dialog, { kind: 'creation' }>): Segment[] {
  const shape = shapeOf(dialog.command)
  const field = sizeFields(shape).find(size => size.key === dialog.missing[0])
  if (!field) return []
  const [low, high] = preview.mesh.bounds
  const [x, y, z] = midpoint(low, high)
  const ringHeight = shape.kind === 'sphere' ? z : shape.kind === 'cone' ? low[2] : high[2]
  const radius = field.value / 2
  let from: Vec3 = low, to: Vec3 = [high[0], low[1], low[2]]
  if (field.key === 'height') { from = [high[0], low[1], low[2]]; to = [high[0], low[1], high[2]] }
  else if (field.key === 'length') { from = [high[0], low[1], low[2]]; to = [high[0], high[1], low[2]] }
  else if (field.key === 'diameter' || field.key === 'innerDiameter') { from = [x - radius, y, ringHeight]; to = [x + radius, y, ringHeight] }
  return [{ from, to, label: field.label, value: field.value, tone: 'amber', offset: 23 }]
}

function sketchDimensions(sketch: Sketch, transform?: Transform, hot?: string): Segment[] {
  const points = sketchPath(sketch)
  const world = (p: Vec3) => transform ? transformPoint(p, matrixOf(transform)) : p
  const make = (a: Vec3, b: Vec3, label: string, value: number, key = label.toLowerCase(), offset = 18) => ({
    from: world(a), to: world(b), label, value, tone: hot === key ? 'amber' as const : 'cyan' as const, offset,
  })
  switch (sketch.geometry.kind) {
    case 'line': return [make(points[0], points[1], 'Length', sketch.geometry.length)]
    case 'rectangle': return [
      make(points[0], points[1], 'Width', sketch.geometry.width),
      make(points[1], points[2], 'Height', Math.abs(sketch.geometry.height), 'height', -19),
    ]
    case 'ellipse': return [
      make(onPlane(sketch.frame, sketch.geometry.at), points[0], 'X radius', sketch.geometry.radiusX, 'radiusX'),
      make(onPlane(sketch.frame, sketch.geometry.at), points[18], 'Y radius', sketch.geometry.radiusY, 'radiusY'),
    ]
    case 'circle': case 'arc': return [make(onPlane(sketch.frame, sketch.geometry.at), points[0], 'Radius', sketch.geometry.radius)]
    default: return []
  }
}

function callouts(item: Entity | undefined, mesh: BodyGeometry | undefined, preview: Preview | undefined, dialog: Dialog | undefined): Segment[] {
  if (preview?.kind === 'measure' && preview.points.length === 2) return [{ from: preview.points[0], to: preview.points[1], label: 'Distance', value: norm(sub(preview.points[1], preview.points[0])), tone: 'amber', offset: -16 }]
  if (preview?.kind === 'holePattern' && preview.points.length) {
    const p = preview.points[0], radius = mul(preview.face.frame.u, preview.diameter / 2)
    return [{ from: sub(p, radius), to: add(p, radius), value: preview.diameter, prefix: 'Ø', tone: 'amber', offset: -17 }]
  }
  if (preview?.kind === 'sketch') {
    const list = sketchDimensions(preview.sketch, preview.transform, dialog?.kind === 'creation' ? dialog.missing[0] : undefined)
    if (preview.label && list[0]) list[0].hint = preview.label
    return list
  }
  if (preview?.kind === 'primitive' && dialog?.kind === 'creation') return primitiveDimension(preview, dialog)
  if (preview?.kind === 'extrude') {
    const local = center(sketchPath(preview.sketch))
    const from = transformPoint(local, matrixOf(preview.transform))
    const to = transformPoint(add(local, mul(planeNormal(preview.sketch.frame), preview.depth)), matrixOf(preview.transform))
    return [{ from, to, value: preview.depth, label: 'Depth', tone: 'amber', offset: 23 }]
  }
  if (preview && !['orbit'].includes(preview.kind)) return []
  if (item?.kind === 'sketch' && !item.hidden) return sketchDimensions(item.sketch, item.transform, dialog?.kind === 'dimension' ? dialog.key : undefined)
  if (!item || item.hidden || !mesh || item.kind !== 'body') return []
  const [lo, hi] = mesh.bounds
  const [x, y] = midpoint(lo, hi)
  if (item.recipe.kind === 'primitive' && item.recipe.primitive.kind === 'tube' && item.transform.rotation.every(v => Math.abs(v) < 1e-6)) {
    return [
      { from: [lo[0], y, hi[2]], to: [hi[0], y, hi[2]], value: hi[0] - lo[0], prefix: 'Ø', offset: -24 },
      { from: [hi[0], y, lo[2]], to: [hi[0], y, hi[2]], value: hi[2] - lo[2], offset: 29 },
    ]
  }
  return [{ from: [lo[0], lo[1], lo[2]], to: [hi[0], lo[1], lo[2]], value: hi[0] - lo[0], offset: 24 }]
}

function DimensionDrawing({ item, scene, unit, precision, index }: { item: Segment; scene: CadScene; unit: Unit; precision: number; index: number }) {
  const [width, height] = scene.dimensions
  const pixel = (p: Vec3) => { const [x, y] = scene.screen(p); return [x * width, y * height] }
  const [x1, y1] = pixel(item.from), [x2, y2] = pixel(item.to)
  const size = Math.hypot(x2 - x1, y2 - y1)
  if (size < 6 || !Number.isFinite(size)) return null
  const offset = item.offset ?? -18
  const xx = -(y2 - y1) / size * offset, yy = (x2 - x1) / size * offset
  const [ax, ay, bx, by] = [x1 + xx, y1 + yy, x2 + xx, y2 + yy]
  const cx = (ax + bx) / 2, cy = (ay + by) / 2
  if (cx < -38 || cy < 0 || cx > width + 38 || cy > height) return null
  const ux = (bx - ax) / size, uy = (by - ay) / size
  return <g className={'dimension '+ (item.tone ?? 'cyan')} data-dimension={item.label ?? 'Size'}>
    <path className="dimension-extension" d={'M' + x1 + ' ' + y1 + 'L' + ax + ' ' + ay + 'M' + x2 + ' ' + y2 + 'L' + bx + ' ' + by} />
    <line className="dimension-line" x1={ax} x2={bx} y1={ay} y2={by} />
    <path className="dimension-head" d={'M'+(ax+ux*5-uy*2.6)+' '+(ay+uy*5+ux*2.6)+'L'+ax+' '+ay+'L'+(ax+ux*5+uy*2.6)+' '+(ay+uy*5-ux*2.6)+'M'+(bx-ux*5-uy*2.6)+' '+(by-uy*5+ux*2.6)+'L'+bx+' '+by+'L'+(bx-ux*5+uy*2.6)+' '+(by-uy*5-ux*2.6)} />
    {item.tone === 'amber' && <><circle cx={x1} cy={y1} r={2.5} /><circle cx={x2} cy={y2} r={2.5} /></>}
    <foreignObject x={cx - 67} y={cy - (item.hint ? 25 : 14)} width={134} height={40} key={index}>
      <div className="callout-wrap"><div className="callout">{item.tone === 'amber' && item.label && <span>{item.label}</span>}{item.prefix}{formatDimension(item.value, unit, precision)}</div>
      {item.hint && <small>{item.hint}</small>}</div>
    </foreignObject>
  </g>
}

function screenAt(p: ScreenPoint) { return { left: p[0] * 100 + '%', top: p[1] * 100 + '%' } }
export function Overlays({ scene, object, mesh, preview, dialog, unit, precision, hands, gesture }: {
  scene: CadScene; object?: Entity; mesh?: BodyGeometry; preview?: Preview; dialog?: Dialog;
  unit: Unit; precision: number; hands: TrackedHand[]; gesture?: string;
}) {
  const [width, height] = scene.dimensions
  const annotations = callouts(object, mesh, preview, dialog)
  const snap = preview?.kind === 'move' || preview?.kind === 'sketch' ? preview.snap : undefined
  return <div className="scene-overlay" aria-hidden="true">
    <svg className="dimensions" viewBox={'0 0 ' + width + ' ' + height}>
      {annotations.map((a, i) => <DimensionDrawing key={i} item={a} scene={scene} unit={unit} precision={precision} index={i} />)}
      {preview?.kind === 'cut' && preview.line && preview.line.length > 1 && <line className="scissor-line" x1={preview.line[0][0] * width}
        y1={preview.line[0][1] * height} x2={preview.line[1][0] * width} y2={preview.line[1][1] * height} />}
    </svg>
    {preview?.kind === 'orbit' && <div className="orbit-indicator" style={screenAt(preview.at)}><MoveUpRight size={16} /></div>}
    {preview?.kind === 'move' && preview.danger && <div className="deletion-boundary"><span>Deletion area</span></div>}
    {snap && <div className="snap-marker" data-snap={snap.kind} style={screenAt(scene.screen(snap.at))}>
      <i />{snap.kind !== 'grid' && <span>{snapNames[snap.kind]}</span>}
    </div>}
    {hands.map(hand => <div key={hand.id} className={'hand-point pose-' + hand.pose}
      style={screenAt(hand.cursor.map(v => Math.min(.997, Math.max(.003, v))) as ScreenPoint)}>
      <Plus size={14} />{gesture && <span>{gesture}</span>}
    </div>)}
  </div>
}

export function orientationProjection(scene: CadScene, v: Vec3): [number, number] {
  const base: Vec3 = [0, 0, 0]
  const [w, h] = scene.dimensions
  const from = scene.screen(base), to = scene.screen(add(base, mul(v, 8)))
  const x = (to[0] - from[0]) * w, y = (to[1] - from[1]) * h
  const size = Math.hypot(x, y)
  const scale = Math.min(1, Math.max(.14, size / 24))
  return size > .01 ? [x / size * 24 * scale, y / size * 24 * scale] : [0, 0]
}
