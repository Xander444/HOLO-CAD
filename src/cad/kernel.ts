import {
  Plane, Vector, assembleWire, basicFaceExtrusion, deserializeShape, exportSTEP, getOC, importSTEP,
  loft, makeBaseBox, makeCircle, makeCompound, makeCylinder, makeEllipse, makeEllipsoid, makeFace,
  makePolygon, makeSphere, measureVolume, revolution,
} from 'replicad'
import type { AnyShape, Edge, Face, Shape3D, Solid } from 'replicad'
import { AXES, DEG, EPS, add, closedSketch, cross, dot, mul, norm, onPlane, orientedFrame, planeNormal, sketchPath, sub, toPlane, unit } from '../models/math'
import type { Body, Frame, PlacedRecipe, Primitive, Recipe, Side, Sketch, Transform, Vec3 } from '../models/project'
import { cornerHoleCenters } from '../models/features'
import type { CornerPattern, EdgeReference, PlaneReference, RectangularFace } from '../models/features'

export type Bounds = [Vec3, Vec3]
export type FaceReference = PlaneReference & { rectangle?: RectangularFace }
export type EdgeRange = { reference: EdgeReference; start: number; count: number }
export type SnapReference = { kind: 'vertex' | 'midpoint' | 'face'; at: Vec3 }
export type BodyGeometry = {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  lines: Float32Array
  bounds: Bounds
  volume: number
  faces: FaceReference[]
  edgeRanges: EdgeRange[]
  snaps: SnapReference[]
}
export type Quality = 'draft' | 'standard' | 'fine'
const qualityOptions = {
  draft: { tolerance: .4, angularTolerance: .28 },
  standard: { tolerance: .12, angularTolerance: .15 },
  fine: { tolerance: .025, angularTolerance: .075 },
}

function sized(value: number, label = 'Dimension') {
  if (!Number.isFinite(value) || value < EPS || value > 1e7) throw new Error(label + ' must be positive and below 10,000,000 mm.')
  return value
}

const components = (p: Vec3, [x, y, z]: Vec3): Vec3 => [p[0] * x, p[1] * y, p[2] * z]
const isotropic = (s: Vec3) => Math.abs(s[0] - s[1]) < 1e-10 && Math.abs(s[0] - s[2]) < 1e-10

function ellipseWire(rx: number, ry: number, center: Vec3, normal: Vec3, u: Vec3, v: Vec3) {
  const edge = Math.abs(rx - ry) < EPS ? makeCircle(rx, center, normal) :
    makeEllipse(Math.max(rx, ry), Math.min(rx, ry), center, normal, rx >= ry ? u : v)
  try { return assembleWire([edge]) } finally { edge.delete() }
}

function sweepFace(face: Face, delta: Vec3) {
  const vector = new Vector(delta)
  try { return basicFaceExtrusion(face, vector) } finally { vector.delete() }
}

function ellipseExtrusion(rx: number, ry: number, height: number): Shape3D {
  if (Math.abs(rx - ry) < EPS) return makeCylinder(rx, height)
  const wire = ellipseWire(rx, ry, [0, 0, 0], AXES.Z, AXES.X, AXES.Y)
  try {
    const face = makeFace(wire)
    try { return sweepFace(face, [0, 0, height]) } finally { face.delete() }
  } finally { wire.delete() }
}

function createPrimitive(p: Primitive, [sx, sy, sz]: Vec3): Shape3D {
  switch (p.kind) {
    case 'box': return makeBaseBox(sized(p.width * sx), sized(p.length * sy), sized(p.height * sz))
    case 'prism': {
      const width = sized(p.width * sx), length = sized(p.length * sy), height = sized(p.height * sz)
      return makeBaseBox(width, length, height)
    }
    case 'cube': return makeBaseBox(sized(p.size * sx), sized(p.size * sy), sized(p.size * sz))
    case 'sphere': {
      const rx = sized(p.radius * sx), ry = sized(p.radius * sy), rz = sized(p.radius * sz)
      return isotropic([sx, sy, sz]) ? makeSphere(rx) : makeEllipsoid(rx, ry, rz)
    }
    case 'cylinder': return ellipseExtrusion(sized(p.radius * sx), sized(p.radius * sy), sized(p.height * sz))
    case 'cone': {
      const rx = sized(p.radius * sx), ry = sized(p.radius * sy), height = sized(p.height * sz)
      if (Math.abs(rx - ry) < EPS) {
        const face = makePolygon([[0, 0, 0], [rx, 0, 0], [0, 0, height]])
        try { return revolution(face) } finally { face.delete() }
      }
      const wire = ellipseWire(rx, ry, [0, 0, 0], AXES.Z, AXES.X, AXES.Y)
      try { return loft([wire], { endPoint: [0, 0, height] }) } finally { wire.delete() }
    }
    case 'tube': {
      if (p.innerRadius >= p.radius - EPS) throw new Error('The inner radius must be smaller than the outer radius.')
      const height = sized(p.height * sz)
      const outside = ellipseExtrusion(sized(p.radius * sx), sized(p.radius * sy), height)
      try {
        const inside = ellipseExtrusion(sized(p.innerRadius * sx), sized(p.innerRadius * sy), height + 2).translateZ(-1)
        try { return outside.cut(inside) } finally { inside.delete() }
      } finally { outside.delete() }
    }
  }
}

function extrude(sketch: Sketch, depth: number, scale: Vec3) {
  sized(Math.abs(depth), 'Extrusion depth')
  const { frame, geometry } = sketch
  if (!closedSketch(geometry)) throw new Error('Solid extrusion needs a closed profile. Select a rectangle, a circle, an ellipse, or a closed polyline.')
  let face: Face
  if (geometry.kind === 'circle' || geometry.kind === 'ellipse') {
    if (!isotropic(scale)) throw new Error('Use uniform scaling for a curved extrusion or edit its profile radii.')
    const a = geometry.kind === 'ellipse' ? geometry.angle * DEG : 0
    const u = add(mul(frame.u, Math.cos(a)), mul(frame.v, Math.sin(a)))
    const v = add(mul(frame.u, -Math.sin(a)), mul(frame.v, Math.cos(a)))
    const wire = ellipseWire(
      sized(geometry.kind === 'circle' ? geometry.radius : geometry.radiusX),
      sized(geometry.kind === 'circle' ? geometry.radius : geometry.radiusY),
      onPlane(frame, geometry.at), planeNormal(frame), u, v,
    )
    try { face = makeFace(wire) } finally { wire.delete() }
    try {
      const shape = sweepFace(face, mul(planeNormal(frame), depth))
      return scale[0] === 1 ? shape : shape.scale(scale[0])
    } finally { face.delete() }
  }
  const path = sketchPath(sketch).slice(0, -1)
  if (path.length < 3) throw new Error('A closed sketch needs at least three distinct points.')
  face = makePolygon(path.map(p => components(p, scale)))
  try { return sweepFace(face, components(mul(planeNormal(frame), depth), scale)) }
  finally { face.delete() }
}

export function exactBounds(shape: AnyShape): Bounds {
  const oc = getOC()
  const bounds = new oc.Bnd_Box()
  try {
    oc.BRepBndLib.AddOptimal(shape.wrapped, bounds, false, false)
    const min = bounds.CornerMin()
    const max = bounds.CornerMax()
    try { return [[min.X(), min.Y(), min.Z()], [max.X(), max.Y(), max.Z()]] }
    finally { min.delete(); max.delete() }
  } finally { bounds.delete() }
}

function checkSolid(shape: Shape3D, single = false) {
  const oc = getOC()
  const check = new oc.BRepCheck_Analyzer(shape.wrapped, true)
  const solids = shape.solids
  try {
    if (!check.IsValid() || !solids.length || solids.some(s => !(measureVolume(s) > EPS))) {
      throw new Error('OpenCascade could not produce a valid solid. Check profile dimensions or whether the bodies overlap.')
    }
    if (single && solids.length !== 1) throw new Error('Fuse needs touching or overlapping bodies that form one solid. Use Attach to keep separate bodies.')
  } finally {
    check.delete()
    solids.forEach(s => s.delete())
  }
}

function computeSplit(source: Shape3D, frame: Frame) {
  const plane = new Plane(frame.origin, frame.u, planeNormal(frame))
  const pieces: Record<Side, Solid[]> = { negative: [], positive: [] }
  try {
    const result = source.split(plane)
    try {
      for (const side of ['negative', 'positive'] as const) {
        pieces[side] = result[side]?.solids ?? []
        const order = new Map(pieces[side].map(s => [s, exactBounds(s).flat()]))
        pieces[side].sort((a, b) => {
          const x = order.get(a)!, y = order.get(b)!
          return x.reduce((cmp, value, i) => cmp || value - y[i], 0)
        })
      }
      if (!pieces.negative.length || !pieces.positive.length) throw new Error('The plane must pass through the interior of the solid.')
      const original = measureVolume(source)
      const total = [...pieces.negative, ...pieces.positive].reduce((sum, piece) => sum + measureVolume(piece), 0)
      if (Math.abs(original - total) > Math.max(1e-5, original * 1e-6)) throw new Error('The cut did not conserve the original solid volume.')
      return pieces
    } catch (error) {
      Object.values(pieces).flat().forEach(piece => piece.delete())
      throw error
    } finally { Object.values(result).forEach(shape => shape?.delete()) }
  } finally { plane.delete() }
}

function rectangularFace(face: Face, normal: Vec3): RectangularFace | undefined {
  const wire = face.clone().outerWire()
  try {
    const edges = wire.edges
    try {
      if (edges.length !== 4 || edges.some(edge => edge.geomType !== 'LINE')) return
      const ends = edges.flatMap(edge => [readVector(edge.startPoint), readVector(edge.endPoint)])
      const direction = sub(ends[1], ends[0])
      if (norm(direction) < EPS) return
      const basis = orientedFrame(ends[0], normal, direction)
      const local = ends.map(point => toPlane(basis, point))
      const loU = Math.min(...local.map(([u]) => u)), hiU = Math.max(...local.map(([u]) => u))
      const loV = Math.min(...local.map(([, v]) => v)), hiV = Math.max(...local.map(([, v]) => v))
      const width = hiU - loU, height = hiV - loV
      if (width < EPS || height < EPS) return
      const indexes = new Set<number>()
      for (const [u, v] of local) {
        const lowU = Math.abs(u - loU) < EPS, lowV = Math.abs(v - loV) < EPS
        if ((!lowU && Math.abs(u - hiU) >= EPS) || (!lowV && Math.abs(v - hiV) >= EPS)) return
        indexes.add(Number(lowU) + 2 * Number(lowV))
      }
      if (indexes.size !== 4) return
      return { frame: { ...basis, origin: onPlane(basis, [loU, loV]) }, width, height }
    } finally { edges.forEach(edge => edge.delete()) }
  } finally { wire.delete() }
}

function planarFace(face: Face): FaceReference | undefined {
  if (face.geomType !== 'PLANE') return
  const at = readVector(face.center)
  const normal = readVector(face.normalAt(at))
  return { at, normal, rectangle: rectangularFace(face, normal) }
}

function patternFace(shape: Shape3D, reference: PlaneReference) {
  const faces = shape.faces
  try {
    const matches = faces.flatMap(face => {
      if (face.geomType !== 'PLANE') return []
      const at = readVector(face.center), normal = readVector(face.normalAt(at))
      return dot(reference.normal, normal) > .9999 ? [{ face, normal, distance: norm(sub(at, reference.at)) }] : []
    }).sort((a, b) => a.distance - b.distance)
    const target = matches[0]
    if (!target || (matches[1] && matches[1].distance - target.distance < EPS)) {
      throw new Error('The saved pattern face is ambiguous. Undo the geometry change and choose the face again.')
    }
    const rectangle = rectangularFace(target.face, target.normal)
    if (!rectangle) throw new Error('A four-corner pattern needs a rectangular planar face.')
    return rectangle
  } finally { faces.forEach(face => face.delete()) }
}

function cutPattern(source: Shape3D, face: PlaneReference, pattern: CornerPattern) {
  const rectangle = patternFace(source, face)
  const points = cornerHoleCenters(rectangle, pattern)
  const bounds = exactBounds(source)
  const depth = norm(sub(bounds[1], bounds[0])) + 2
  const normal = planeNormal(rectangle.frame)
  let current = source.clone()
  try {
    for (const point of points) {
      const cutter = makeCylinder(pattern.diameter / 2, depth, add(point, mul(normal, .05)), mul(normal, -1))
      try {
        const next = current.cut(cutter)
        const removed = measureVolume(current) - measureVolume(next)
        if (!(removed > EPS)) {
          next.delete()
          throw new Error('A hole didn’t remove material. Adjust the inset or choose a different face.')
        }
        current.delete()
        current = next
      } finally { cutter.delete() }
    }
    return current
  } catch (error) { current.delete(); throw error }
}

function readEdge(edge: Edge): EdgeReference {
  return { start: readVector(edge.startPoint), end: readVector(edge.endPoint), middle: readVector(edge.pointAt(.5)) }
}

function bevelEdge(source: Shape3D, reference: EdgeReference, distance: number) {
  sized(distance, 'Chamfer distance')
  const edges = source.edges
  try {
    const matches = edges.filter(edge => {
      const { start, end, middle } = readEdge(edge)
      if (norm(sub(middle, reference.middle)) > EPS * 4) return false
      return (norm(sub(start, reference.start)) < EPS * 4 && norm(sub(end, reference.end)) < EPS * 4) ||
        (norm(sub(end, reference.start)) < EPS * 4 && norm(sub(start, reference.end)) < EPS * 4)
    })
    if (matches.length !== 1) throw new Error('The saved chamfer edge could not be identified. Choose an exposed edge again.')
    let result: Shape3D | undefined
    try {
      result = source.chamfer(distance, finder => finder.when(({ element }) => element.isSame(matches[0])))
      checkSolid(result)
      if (measureVolume(source) - measureVolume(result) <= EPS) throw new Error('Chamfer removed no material.')
      return result
    } catch {
      result?.delete()
      throw new Error('OpenCascade could not chamfer this edge at that distance. Try a smaller distance or a different edge.')
    }
  } finally { edges.forEach(edge => edge.delete()) }
}

function createRecipe(recipe: Recipe, scale: Vec3): Shape3D {
  if (recipe.kind === 'primitive') return createPrimitive(recipe.primitive, scale)
  if (recipe.kind === 'extrude') return extrude(recipe.sketch, recipe.depth, scale)
  if (!isotropic(scale)) throw new Error('Use uniform scaling on this body or edit its source feature.')
  let shape: Shape3D
  switch (recipe.kind) {
    case 'brep': shape = deserializeShape(recipe.data).asShape3D(); break
    case 'boolean': {
      const left = buildBody(recipe.left)
      try {
        const right = buildBody(recipe.right)
        try {
          shape = recipe.operation === 'union' ? left.fuse(right) :
            recipe.operation === 'subtract' ? left.cut(right) : left.intersect(right)
          if (recipe.operation === 'union') {
            try { checkSolid(shape, true) } catch (error) { shape.delete(); throw error }
          }
          if (recipe.operation === 'subtract' && measureVolume(left) - measureVolume(shape) <= EPS) {
            shape.delete()
            throw new Error('The tool does not remove material. Move it into the target solid.')
          }
        } finally { right.delete() }
      } finally { left.delete() }
      break
    }
    case 'split': {
      const source = buildBody(recipe.source)
      try {
        const pieces = computeSplit(source, recipe.plane)
        const chosen = pieces[recipe.side][recipe.piece]
        for (const solid of Object.values(pieces).flat()) if (solid !== chosen) solid.delete()
        if (!chosen) throw new Error('This cut piece no longer exists at the current dimensions.')
        shape = chosen
      } finally { source.delete() }
      break
    }
    case 'holePattern': case 'chamfer': {
      const source = buildBody(recipe.source)
      try {
        shape = recipe.kind === 'holePattern' ? cutPattern(source, recipe.face, recipe.pattern) : bevelEdge(source, recipe.edge, recipe.distance)
      } finally { source.delete() }
      break
    }
  }
  return scale[0] === 1 ? shape : shape.scale(scale[0])
}

// Replicad's returned transforms consume the input wrapper.
function orient(shape: Shape3D, transform: Transform) {
  let current = shape
  for (const [i, axis] of (['X', 'Y', 'Z'] as const).entries()) {
    if (transform.rotation[i]) current = current.rotate(transform.rotation[i], [0, 0, 0], AXES[axis])
  }
  if (transform.position.some(Boolean)) current = current.translate(transform.position)
  return current
}

export function buildBody({ recipe, transform }: PlacedRecipe): Shape3D {
  transform.scale.forEach(s => sized(s, 'Scale'))
  return orient(createRecipe(recipe, transform.scale), transform)
}

export function splitBody(body: Body, frame: Frame, showPieces = false) {
  const shape = buildBody(body)
  try {
    const result = computeSplit(shape, frame)
    try {
      const parts: { side: Side; piece: number }[] = []
      const preview = showPieces ? [] as BodyGeometry[] : undefined
      for (const side of ['negative', 'positive'] as const) {
        result[side].forEach((solid, piece) => {
          parts.push({ side, piece })
          if (preview) preview.push(tessellate(solid, 'draft'))
          else checkSolid(solid)
        })
      }
      return { parts, preview }
    } finally { Object.values(result).flat().forEach(piece => piece.delete()) }
  } finally { shape.delete() }
}
export const splitParts = (body: Body, frame: Frame) => splitBody(body, frame).parts

function readVector(vector: Vector): Vec3 {
  try { return vector.toTuple() } finally { vector.delete() }
}

export function tessellate(shape: Shape3D, quality: Quality = 'standard'): BodyGeometry {
  checkSolid(shape)
  const bounds = exactBounds(shape)
  const mesh = shape.mesh(qualityOptions[quality])
  const edgeMesh = shape.meshEdges(qualityOptions[quality])
  const snaps: SnapReference[] = []
  const faces: FaceReference[] = []
  const edgeRanges: EdgeRange[] = []
  const ranges = new Map(edgeMesh.edgeGroups.map(group => [group.edgeId, group]))
  const edges = shape.edges
  const planeFaces = shape.faces
  try {
    for (const face of planeFaces) {
      const reference = planarFace(face)
      if (!reference) continue
      faces.push(reference)
      snaps.push({ kind: 'face', at: reference.at })
    }
    for (const edge of edges) {
      const range = ranges.get(edge.hashCode)
      if (!range || range.count < 2) continue
      const reference = readEdge(edge)
      edgeRanges.push({ reference, start: range.start, count: range.count })
      const { start, end, middle } = reference
      if (norm(sub(start, end)) <= EPS) continue
      snaps.push({ kind: 'vertex', at: start }, { kind: 'vertex', at: end })
      snaps.push({ kind: 'midpoint', at: middle })
    }
  } finally { [...edges, ...planeFaces].forEach(shape => shape.delete()) }
  return {
    positions: new Float32Array(mesh.vertices), normals: new Float32Array(mesh.normals),
    indices: new Uint32Array(mesh.triangles), lines: new Float32Array(edgeMesh.lines),
    bounds, volume: measureVolume(shape), faces, edgeRanges, snaps,
  }
}

export function measureBody(body: Body): { volume: number; bounds: Bounds } {
  const shape = buildBody(body)
  try { checkSolid(shape); return { volume: measureVolume(shape), bounds: exactBounds(shape) } }
  finally { shape.delete() }
}

export function exportBodies(bodies: Body[], format: 'stl' | 'step', quality: Quality = 'standard'): Blob {
  if (!bodies.length) throw new Error('There are no visible solids to export.')
  const shapes: Shape3D[] = []
  try {
    for (const body of bodies) {
      const shape = buildBody(body)
      shapes.push(shape)
      checkSolid(shape)
    }
    if (format === 'step') {
      return exportSTEP(shapes.map((shape, i) => ({ shape, name: bodies[i].name, color: bodies[i].color })), { unit: 'MM', modelUnit: 'MM' })
    }
    const compound = makeCompound(shapes)
    try { return compound.blobSTL({ binary: true, ...qualityOptions[quality] }) }
    finally { compound.delete() }
  } finally { shapes.forEach(shape => shape.delete()) }
}

export async function importBodies(file: Blob): Promise<string[]> {
  const shape = await importSTEP(file)
  const solids = shape.solids
  try {
    if (!solids.length) throw new Error('The STEP file does not contain any solid bodies.')
    return solids.map(solid => { checkSolid(solid); return solid.serialize() })
  } finally { solids.forEach(s => s.delete()); shape.delete() }
}

export function supportCoordinate(body: Body, direction: Vec3) {
  const normal = unit(direction)
  const cos = Math.min(1, Math.max(-1, dot(AXES.Z, normal)))
  let shape = buildBody(body)
  try {
    if (cos < 1 - 1e-12) {
      const axis = cos < -1 + 1e-12 ? AXES.X : unit(cross(normal, AXES.Z))
      shape = shape.rotate(Math.acos(cos) / DEG, [0, 0, 0], axis)
    }
    return exactBounds(shape)[0][2]
  } finally { shape.delete() }
}
