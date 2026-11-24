import { add, closedSketch, EPS, mul, orientedFrame } from '../models/math'
import { identity, makeBody, uid } from '../models/project'
import { matrixOf, transformDirection, transformOf, transformPoint } from '../models/transforms'
import type { Body, BooleanKind, Entity, Frame, Geometry, PlacedRecipe, Primitive, Project, Recipe, Side, Sketch, Transform, Unit, Vec3 } from '../models/project'
import type { CornerPattern, EdgeReference, PlaneReference } from '../models/features'

export type FeatureCommand =
  | { type: 'holePattern'; id: string; face: PlaneReference; pattern: CornerPattern }
  | { type: 'chamfer'; id: string; edge: EdgeReference; distance: number }
export type Command =
  | FeatureCommand
  | { type: 'create'; primitive: Primitive; at?: Vec3; color?: string }
  | { type: 'sketch'; sketch: Sketch; source?: string }
  | { type: 'extrude'; id: string; depth: number }
  | { type: 'transform'; ids: string[]; target: string; value: Transform; label?: string }
  | { type: 'parameter'; id: string; key: string; value: number; path?: ('left' | 'right' | 'source')[] }
  | { type: 'boolean'; operation: BooleanKind; target: string; tool: string; position?: Vec3 }
  | { type: 'split'; id: string; plane: Frame; parts: { side: Side; piece: number }[] }
  | { type: 'attach'; child: string; parent?: string; position?: Vec3 }
  | { type: 'hole'; id: string; at: Vec3; normal: Vec3; mode: 'through' | 'blind' | 'rectangular'; width: number; height: number; depth: number }
  | { type: 'delete'; ids: string[] }
  | { type: 'duplicate'; ids: string[] }
  | { type: 'appearance'; id: string; color?: string; name?: string; hidden?: boolean }
  | { type: 'project'; name?: string; units?: Unit }
  | { type: 'import'; solids: string[]; name: string }

export type Result = { project: Project; selection: string[]; label: string }
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const placed = (body: Body): PlacedRecipe => ({ recipe: body.recipe, transform: body.transform })
const rootOf = (objects: Entity[], id: string): string | undefined => objects.find(o => o.id === id)?.parent
const unitless = ['angle', 'startAngle', 'sweep', 'x', 'y']

function entity(project: Project, id: string): Entity {
  const result = project.objects.find(o => o.id === id)
  if (!result) throw new Error('Select an existing object first.')
  return result
}

function body(project: Project, id: string): Body {
  const result = entity(project, id)
  if (result.kind !== 'body') throw new Error('Select a 3D solid for this operation.')
  return result
}

export function validateSketch({ geometry: g }: Sketch) {
  const coords = 'at' in g ? g.at : g.points.flat()
  coords.forEach(ensureFinite)
  for (const value of Object.values(g)) if (typeof value === 'number') ensureFinite(value)
  if (g.kind === 'polyline') {
    if (g.points.length < (g.closed ? 3 : 2)) throw new Error('Add more points to this polyline.')
    for (const [i, p] of g.points.entries()) if (i > 0 && Math.hypot(p[0] - g.points[i - 1][0], p[1] - g.points[i - 1][1]) < EPS) {
      throw new Error('Consecutive sketch points need to be distinct.')
    }
  }
  const positive = g.kind === 'line' ? g.length : g.kind === 'circle' || g.kind === 'arc' ? g.radius : g.kind === 'rectangle' ? g.width : g.kind === 'ellipse' ? Math.min(g.radiusX, g.radiusY) : 1
  if (!(positive >= EPS) || (g.kind === 'rectangle' && Math.abs(g.height) < EPS)) throw new Error('Give the sketch a dimension greater than zero.')
  if (g.kind === 'arc' && (Math.abs(g.sweep) < EPS || Math.abs(g.sweep) >= 360)) throw new Error('Use an arc sweep between zero and 360 degrees, or use a circle.')
}

function ensureFinite(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error('Enter a finite value within the supported modeling range.')
}

export function applyFeature(target: Body, command: FeatureCommand): Body {
  const unitScale = identity()
  const transform = { ...target.transform, scale: unitScale.scale }
  const inverse = matrixOf(transform).invert()
  const source = { recipe: target.recipe, transform: { ...unitScale, scale: target.transform.scale } }
  if (command.type === 'holePattern') {
    const { face, pattern } = command
    const reference = { at: transformPoint(face.at, inverse), normal: transformDirection(face.normal, inverse) }
    return { ...target, transform, recipe: { kind: 'holePattern', source, face: reference, pattern } }
  }
  const edge = {
    start: transformPoint(command.edge.start, inverse),
    end: transformPoint(command.edge.end, inverse),
    middle: transformPoint(command.edge.middle, inverse),
  }
  return { ...target, transform, recipe: { kind: 'chamfer', source, edge, distance: command.distance } }
}

type Editable = Primitive | Geometry
export function changeNumeric<T extends Editable>(value: T, key: string, input: number): T {
  ensureFinite(input)
  if (key === 'diameter') { key = 'radius'; input /= 2 }
  if (key === 'innerDiameter') { key = 'innerRadius'; input /= 2 }
  if (value.kind === 'cube' && ['width', 'length', 'height'].includes(key)) key = 'size'
  if ((key === 'x' || key === 'y') && 'at' in value) {
    const at = [...value.at]
    at[key === 'x' ? 0 : 1] = input
    return { ...value, at }
  }
  if (key === 'length' && value.kind === 'rectangle') key = 'width'
  if (typeof (value as unknown as Record<string, unknown>)[key] !== 'number') throw new Error(cap(key) + ' is unavailable on this feature.')
  if (key === 'height' && value.kind === 'rectangle') input = Math.sign(value.height) * Math.abs(input)
  if (!unitless.includes(key) && key !== 'height' && input < EPS) throw new Error('Enter a dimension greater than zero.')
  if (key === 'height' && value.kind !== 'rectangle' && input < EPS) throw new Error('Height must be greater than zero.')
  return { ...value, [key]: input }
}

function changeRecipe(recipe: Recipe, key: string, value: number, path: NonNullable<Extract<Command, { type: 'parameter' }>['path']>): Recipe {
  const [head, ...remaining] = path
  if (head === 'source' && (recipe.kind === 'split' || recipe.kind === 'holePattern' || recipe.kind === 'chamfer')) {
    return { ...recipe, source: { ...recipe.source, recipe: changeRecipe(recipe.source.recipe, key, value, remaining) } }
  }
  if (head && head !== 'source' && recipe.kind === 'boolean') return { ...recipe, [head]: { ...recipe[head], recipe: changeRecipe(recipe[head].recipe, key, value, remaining) } }
  if (head) throw new Error('This feature path is unavailable.')
  if (recipe.kind === 'primitive') return { ...recipe, primitive: changeNumeric(recipe.primitive, key, value) }
  if (recipe.kind === 'extrude') {
    if (['depth', 'height'].includes(key)) {
      if (Math.abs(value) < EPS) throw new Error('Extrusion depth must be nonzero.')
      return { ...recipe, depth: value }
    }
    const sketch = { ...recipe.sketch, geometry: changeNumeric(recipe.sketch.geometry, key, value) }
    validateSketch(sketch)
    return { ...recipe, sketch, sourceId: undefined }
  }
  if (recipe.kind === 'holePattern' && (key === 'holeDiameter' || key === 'holeInset')) {
    return { ...recipe, pattern: { ...recipe.pattern, [key === 'holeDiameter' ? 'diameter' : 'inset']: value } }
  }
  if (recipe.kind === 'chamfer' && key === 'chamferDistance') return { ...recipe, distance: value }
  return changeRecipe(recipe, key, value, recipe.kind === 'boolean' ? ['left'] : ['source'])
}

function updateProfile(recipe: Recipe, id: string, sketch: Sketch): Recipe {
  if (recipe.kind === 'extrude' && recipe.sourceId === id) return { ...recipe, sketch }
  if (recipe.kind === 'boolean') {
    const left = updateProfile(recipe.left.recipe, id, sketch)
    const right = updateProfile(recipe.right.recipe, id, sketch)
    return left === recipe.left.recipe && right === recipe.right.recipe ? recipe :
      { ...recipe, left: { ...recipe.left, recipe: left }, right: { ...recipe.right, recipe: right } }
  }
  if (recipe.kind === 'split' || recipe.kind === 'holePattern' || recipe.kind === 'chamfer') {
    const next = updateProfile(recipe.source.recipe, id, sketch)
    return next === recipe.source.recipe ? recipe : { ...recipe, source: { ...recipe.source, recipe: next } }
  }
  return recipe
}

export function descendants(objects: Entity[], ids: string[]) {
  const included = new Set(ids)
  let changed = true
  while (changed) {
    changed = false
    for (const o of objects) if (o.parent && included.has(o.parent) && !included.has(o.id)) {
      included.add(o.id)
      changed = true
    }
  }
  return included
}

function removed(objects: Entity[], ids: string[], replacement?: string) {
  const selected = new Set(ids)
  return objects.filter(o => !selected.has(o.id)).map(o => {
    if (!o.parent || !selected.has(o.parent)) return o
    let parent = rootOf(objects, o.parent)
    while (parent && selected.has(parent)) parent = rootOf(objects, parent)
    return { ...o, parent: replacement ?? parent }
  })
}

function withHistory<T extends Entity>(object: T, label: string): T {
  return { ...object, history: [...object.history.slice(-95), label] }
}

function nextName(objects: Entity[], prefix: string) {
  const names = new Set(objects.map(o => o.name))
  let number = 1
  while (names.has(prefix + ' ' + number)) number++
  return prefix + ' ' + number
}

export function execute(project: Project, cmd: Command, currentSelection: string[] = []): Result {
  let objects = project.objects
  let selection = currentSelection
  let label: string
  let meta = project
  switch (cmd.type) {
    case 'create': {
      const name = nextName(objects, cap(cmd.primitive.kind))
      label = 'Create ' + name
      const object = makeBody(uid(), name, { kind: 'primitive', primitive: cmd.primitive }, { ...identity(), position: cmd.at ?? [0, 0, 0] }, cmd.color)
      selection = [object.id]
      objects = [...objects, withHistory(object, label)]
      break
    }
    case 'sketch': {
      validateSketch(cmd.sketch)
      const name = nextName(objects, cap(cmd.sketch.geometry.kind))
      const original = cmd.source ? entity(project, cmd.source) : undefined
      label = original ? 'Extend ' + original.name + ' to rectangle' : 'Draw ' + name
      const object: Entity = {
        id: uid(), kind: 'sketch', name, sketch: cmd.sketch, transform: original?.transform ?? identity(),
        hidden: false, color: '#78e2fa', parent: original?.parent, history: [label],
      }
      if (original) objects = objects.map(o => o.id === original.id ? { ...o, hidden: true } : o)
      objects = [...objects, object]
      selection = [object.id]
      break
    }
    case 'extrude': {
      const source = entity(project, cmd.id)
      if (source.kind !== 'sketch' || !closedSketch(source.sketch.geometry)) {
        throw new Error('Solid extrusion needs a closed sketch. Draw a rectangle, circle, ellipse, or closed polyline.')
      }
      ensureFinite(cmd.depth)
      if (Math.abs(cmd.depth) < EPS) throw new Error('Extrusion depth must be nonzero.')
      const name = nextName(objects, 'Extrusion')
      label = 'Extrude ' + source.name + ' · ' + cmd.depth + ' mm'
      const solid = withHistory(makeBody(uid(), name, { kind: 'extrude', sketch: source.sketch, sourceId: source.id, depth: cmd.depth }, source.transform), label)
      solid.parent = source.parent
      objects = [...objects.map(o => o.id === source.id ? { ...o, hidden: true } : o), solid]
      selection = [solid.id]
      break
    }
    case 'transform': {
      const target = entity(project, cmd.target)
      ;[...cmd.value.position, ...cmd.value.rotation, ...cmd.value.scale].forEach(ensureFinite)
      if (cmd.value.scale.some(s => s < EPS)) throw new Error('Each scale factor must be greater than zero.')
      const ids = descendants(objects, cmd.ids)
      const delta = matrixOf(cmd.value).multiply(matrixOf(target.transform).invert())
      if (delta.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9)) return { project, selection, label: 'Position unchanged' }
      label = (cmd.label ?? 'Transform') + ' ' + target.name
      objects = objects.map(o => {
        if (!ids.has(o.id)) return o
        const transform = o.id === cmd.target ? cmd.value : transformOf(delta.clone().multiply(matrixOf(o.transform)))
        return withHistory({ ...o, transform }, label)
      })
      selection = cmd.ids
      break
    }
    case 'parameter': {
      const object = entity(project, cmd.id)
      ensureFinite(cmd.value)
      label = 'Set ' + object.name + ' ' + cmd.key + ' · ' + cmd.value
      if (object.kind === 'sketch') {
        const sketch = { ...object.sketch, geometry: changeNumeric(object.sketch.geometry, cmd.key, cmd.value) }
        validateSketch(sketch)
        objects = objects.map(o => {
          if (o.id === object.id) return withHistory({ ...object, sketch }, label)
          if (o.kind === 'sketch') return o
          const recipe = updateProfile(o.recipe, object.id, sketch)
          return recipe === o.recipe ? o : withHistory({ ...o, recipe }, label)
        })
      } else {
        const recipe = changeRecipe(object.recipe, cmd.key, cmd.value, cmd.path ?? [])
        objects = objects.map(o => o.id === cmd.id ? withHistory({ ...object, recipe }, label) : o)
      }
      selection = [cmd.id]
      break
    }
    case 'boolean': {
      if (cmd.target === cmd.tool) throw new Error('Select two distinct solids.')
      const target = body(project, cmd.target)
      const tool = body(project, cmd.tool)
      const moving = cmd.position ? { ...target, transform: { ...target.transform, position: cmd.position } } : target
      const name = nextName(objects, cmd.operation === 'union' ? 'Fusion' : cmd.operation === 'subtract' ? 'Difference' : 'Intersection')
      label = cap(cmd.operation) + ' · ' + target.name + ' / ' + tool.name
      const solid = withHistory(makeBody(uid(), name, { kind: 'boolean', operation: cmd.operation, left: placed(moving), right: placed(tool) }, identity(), target.color), label)
      solid.parent = target.parent === tool.id ? tool.parent : target.parent
      if (solid.parent && descendants(objects, [target.id, tool.id]).has(solid.parent)) solid.parent = undefined
      if (cmd.position) {
        const delta = add(cmd.position, mul(target.transform.position, -1))
        const children = descendants(objects, [target.id])
        objects = objects.map(o => children.has(o.id) ? { ...o, transform: { ...o.transform, position: add(o.transform.position, delta) } } : o)
      }
      objects = [...removed(objects, [target.id, tool.id], solid.id), solid]
      selection = [solid.id]
      break
    }
    case 'split': {
      const source = body(project, cmd.id)
      if (cmd.parts.length < 2) throw new Error('The plane must create at least two solid pieces.')
      label = 'Split ' + source.name + ' · ' + cmd.parts.length + ' pieces'
      const parts = cmd.parts.map((part, i) => {
        const solid = withHistory(makeBody(uid(), source.name + ' · ' + (i + 1), { kind: 'split', source: placed(source), plane: cmd.plane, ...part }, identity(), i % 2 ? '#58c1ae' : source.color), label)
        solid.parent = source.parent
        return solid
      })
      objects = [...removed(objects, [source.id]), ...parts]
      selection = parts.map(o => o.id)
      break
    }
    case 'attach': {
      const child = entity(project, cmd.child)
      const parent = cmd.parent ? entity(project, cmd.parent) : undefined
      const children = descendants(objects, [child.id])
      if (parent && children.has(parent.id)) throw new Error('This attachment would create a circular relationship.')
      const delta = cmd.position ? add(cmd.position, mul(child.transform.position, -1)) : [0, 0, 0] as Vec3
      label = parent ? 'Attach ' + child.name + ' to ' + parent.name : 'Detach ' + child.name
      objects = objects.map(o => {
        if (!children.has(o.id)) return o
        const transform = { ...o.transform, position: add(o.transform.position, delta) }
        return o.id === child.id ? withHistory({ ...o, transform, parent: parent?.id }, label) : { ...o, transform }
      })
      selection = parent ? [parent.id, child.id] : [child.id]
      break
    }
    case 'hole': {
      const target = body(project, cmd.id)
      ;[cmd.width, cmd.height, cmd.depth].forEach(ensureFinite)
      if (Math.min(cmd.width, cmd.height, cmd.depth) <= EPS) throw new Error('Hole dimensions must be greater than zero.')
      const frame = orientedFrame(add(cmd.at, mul(cmd.normal, .05)), cmd.normal)
      const geometry: Geometry = cmd.mode === 'rectangular' ? { kind: 'rectangle', at: [-cmd.width / 2, -cmd.height / 2], width: cmd.width, height: cmd.height, angle: 0 } :
        { kind: 'circle', at: [0, 0], radius: cmd.width / 2 }
      const recipe: Recipe = {
        kind: 'boolean', operation: 'subtract', left: placed(target),
        right: { recipe: { kind: 'extrude', sketch: { frame, geometry }, depth: -cmd.depth - .05 }, transform: identity() },
      }
      label = (cmd.mode === 'rectangular' ? 'Rectangular cutout' : cmd.mode === 'through' ? 'Through-hole' : 'Blind hole') + ' · ' + target.name
      objects = objects.map(o => o.id === target.id ? withHistory({ ...target, recipe, transform: identity() }, label) : o)
      selection = [target.id]
      break
    }
    case 'holePattern': case 'chamfer': {
      const target = body(project, cmd.id)
      const candidate = applyFeature(target, cmd)
      label = cmd.type === 'holePattern' ? 'Add four-hole pattern · ' + target.name : 'Chamfer edge · ' + target.name
      objects = objects.map(o => o.id === target.id ? withHistory(candidate, label) : o)
      selection = [target.id]
      break
    }
    case 'duplicate': {
      const included = descendants(objects, cmd.ids)
      const originals = objects.filter(o => included.has(o.id))
      if (!originals.length) throw new Error('Select an object to duplicate.')
      const ids = new Map(originals.map(o => [o.id, uid()]))
      label = 'Duplicate ' + (cmd.ids.length === 1 ? entity(project, cmd.ids[0]).name : 'selected objects')
      const copies = originals.map(o => withHistory({
        ...o, id: ids.get(o.id)!, name: o.name + ' copy', parent: o.parent ? ids.get(o.parent) : undefined,
        transform: { ...o.transform, position: add(o.transform.position, [12, 12, 0]) },
      }, label))
      objects = [...objects, ...copies]
      selection = cmd.ids.map(id => ids.get(id)!)
      break
    }
    case 'delete': {
      if (!cmd.ids.length) throw new Error('Select an object to delete.')
      label = 'Delete ' + (cmd.ids.length === 1 ? entity(project, cmd.ids[0]).name : cmd.ids.length + ' objects')
      objects = removed(objects, cmd.ids)
      selection = []
      break
    }
    case 'appearance': {
      const object = entity(project, cmd.id)
      const name = cmd.name?.trim().slice(0, 100) || object.name
      label = cmd.hidden !== undefined ? (cmd.hidden ? 'Hide ' : 'Show ') + object.name : 'Edit ' + object.name
      objects = objects.map(o => o.id === cmd.id ? withHistory({ ...o, name, color: cmd.color ?? o.color, hidden: cmd.hidden ?? o.hidden }, label) : o)
      break
    }
    case 'project': {
      meta = { ...project, name: cmd.name?.trim().slice(0, 100) || project.name, units: cmd.units ?? project.units }
      label = cmd.name ? 'Rename project' : 'Set display units'
      break
    }
    case 'import': {
      label = 'Import STEP · ' + cmd.name
      const copies = cmd.solids.map((data, i) => withHistory(makeBody(uid(), cmd.name + (cmd.solids.length > 1 ? ' ' + (i + 1) : ''), { kind: 'brep', data }), label))
      objects = [...objects, ...copies]
      selection = copies.map(o => o.id)
      break
    }
  }
  if (objects.length > 512) throw new Error('This workspace supports up to 512 objects per project.')
  return { project: { ...meta, objects, modified: new Date().toISOString(), history: [...project.history.slice(-199), label] }, selection, label }
}
