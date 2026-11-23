import type { CornerPattern, EdgeReference, PlaneReference } from './features'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type Axis = 'X' | 'Y' | 'Z'
export type PlaneName = 'XY' | 'XZ' | 'YZ'
export type Unit = 'mm' | 'cm' | 'm' | 'in'
export type Frame = { origin: Vec3; u: Vec3; v: Vec3 }
export type Transform = { position: Vec3; rotation: Vec3; scale: Vec3 }

export type Geometry =
  | { kind: 'point'; at: Vec2 }
  | { kind: 'line'; at: Vec2; angle: number; length: number }
  | { kind: 'rectangle'; at: Vec2; angle: number; width: number; height: number }
  | { kind: 'circle'; at: Vec2; radius: number }
  | { kind: 'ellipse'; at: Vec2; radiusX: number; radiusY: number; angle: number }
  | { kind: 'arc'; at: Vec2; radius: number; startAngle: number; sweep: number }
  | { kind: 'polyline'; points: Vec2[]; closed: boolean }

export type Sketch = { frame: Frame; geometry: Geometry }
export type Primitive =
  | { kind: 'box' | 'prism'; width: number; length: number; height: number }
  | { kind: 'cube'; size: number }
  | { kind: 'cylinder' | 'cone'; radius: number; height: number }
  | { kind: 'sphere'; radius: number }
  | { kind: 'tube'; radius: number; innerRadius: number; height: number }
export type BooleanKind = 'union' | 'subtract' | 'intersect'
export type Side = 'positive' | 'negative'
export type PlacedRecipe = { recipe: Recipe; transform: Transform }
export type Recipe =
  | { kind: 'primitive'; primitive: Primitive }
  | { kind: 'extrude'; sketch: Sketch; depth: number; sourceId?: string }
  | { kind: 'boolean'; operation: BooleanKind; left: PlacedRecipe; right: PlacedRecipe }
  | { kind: 'split'; source: PlacedRecipe; plane: Frame; side: Side; piece: number }
  | { kind: 'holePattern'; source: PlacedRecipe; face: PlaneReference; pattern: CornerPattern }
  | { kind: 'chamfer'; source: PlacedRecipe; edge: EdgeReference; distance: number }
  | { kind: 'brep'; data: string }

type ObjectBase = {
  id: string
  name: string
  transform: Transform
  color: string
  hidden: boolean
  parent?: string
  history: string[]
}
export type Body = ObjectBase & { kind: 'body'; recipe: Recipe }
export type SketchObject = ObjectBase & { kind: 'sketch'; sketch: Sketch }
export type Entity = Body | SketchObject
export type Project = {
  format: 'holocad'
  version: 1
  id: string
  name: string
  created: string
  modified: string
  units: Unit
  objects: Entity[]
  history: string[]
}

export const identity = (): Transform => ({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] })
export const isBody = (entity: Entity): entity is Body => entity.kind === 'body'
export const isSketch = (entity: Entity): entity is SketchObject => entity.kind === 'sketch'
export const uid = () => globalThis.crypto.randomUUID()
export const entityType = (entity: Entity): string => {
  if (entity.kind === 'sketch') return entity.sketch.geometry.kind
  const { recipe } = entity
  return recipe.kind === 'primitive' ? recipe.primitive.kind
    : recipe.kind === 'boolean' ? recipe.operation
    : recipe.kind === 'holePattern' ? 'hole pattern' : recipe.kind === 'chamfer' ? 'chamfer'
    : recipe.kind === 'brep' ? 'imported solid' : recipe.kind === 'split' ? 'split solid' : 'extrusion'
}

export function blankProject(name = 'Untitled project'): Project {
  const date = new Date().toISOString()
  return { format: 'holocad', version: 1, id: uid(), name, created: date, modified: date, units: 'mm', objects: [], history: [] }
}

export function defaultPrimitive(kind: Primitive['kind']): Primitive {
  switch (kind) {
    case 'box': case 'prism': return { kind, width: 44, length: 36, height: 24 }
    case 'cube': return { kind, size: 36 }
    case 'sphere': return { kind, radius: 20 }
    case 'tube': return { kind, radius: 25, innerRadius: 15, height: 28 }
    case 'cone': return { kind, radius: 22, height: 42 }
    case 'cylinder': return { kind, radius: 20, height: 36 }
  }
}

export function makeBody(id: string, name: string, recipe: Recipe, transform = identity(), color = '#40b6cb'): Body {
  return { kind: 'body', id, name, recipe, transform, color, hidden: false, history: [] }
}
