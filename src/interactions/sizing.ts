import { changeNumeric } from '../commands/commands'
import type { Command } from '../commands/commands'
import { EPS } from '../models/math'
import type { Geometry, Primitive } from '../models/project'

export type NewShape = Extract<Command, { type: 'create' | 'sketch' }>
export type SizeField = { key: string; label: string; value: number }
type Shape = Primitive | Geometry

const labels: Record<string, string> = {
  size: 'Side length', width: 'Width', length: 'Length', height: 'Height', diameter: 'Diameter', innerDiameter: 'Bore diameter',
  radius: 'Radius', radiusX: 'Horizontal radius', radiusY: 'Vertical radius',
}

export function sizeFields(shape: Shape): SizeField[] {
  const field = (key: string, value: number) => ({ key, label: labels[key], value })
  switch (shape.kind) {
    case 'box': case 'prism': return [field('width', shape.width), field('length', shape.length), field('height', shape.height)]
    case 'cube': return [field('size', shape.size)]
    case 'cylinder': case 'cone': return [field('diameter', shape.radius * 2), field('height', shape.height)]
    case 'sphere': return [field('diameter', shape.radius * 2)]
    case 'tube': return [field('diameter', shape.radius * 2), field('innerDiameter', shape.innerRadius * 2), field('height', shape.height)]
    case 'line': return [field('length', shape.length)]
    case 'rectangle': return [field('width', shape.width), field('height', Math.abs(shape.height))]
    case 'circle': case 'arc': return [field('radius', shape.radius)]
    case 'ellipse': return [field('radiusX', shape.radiusX), field('radiusY', shape.radiusY)]
    default: return []
  }
}

export function sizeTarget(shape: Shape, key: string) {
  const fields = sizeFields(shape)
  const exact = fields.find(field => field.key === key)
  if (exact) return { field: exact, factor: 1 }
  const alias: Record<string, [string, number]> = {
    radius: ['diameter', 2], diameter: ['radius', .5], innerRadius: ['innerDiameter', 2],
    length: shape.kind === 'cube' ? ['size', 1] : ['width', 1],
    width: shape.kind === 'cube' ? ['size', 1] : shape.kind === 'circle' || shape.kind === 'arc' ? ['radius', .5] : ['diameter', 1],
    height: ['size', 1],
  }
  const [name, factor] = alias[key] ?? []
  const field = fields.find(field => field.key === name)
  if (field && factor !== undefined) return { field, factor }
}

export function sizeQuestion(kind: Shape['kind'], { key, label }: SizeField) {
  const name = kind === 'prism' ? 'rectangular prism' : kind
  if (kind === 'cube') return 'How long should each side of the cube be?'
  if (key === 'length') return 'How long should the ' + name + ' be?'
  if (key === 'width') return 'How wide should the ' + name + ' be?'
  if (key === 'height' && kind !== 'rectangle') return 'How tall should the ' + name + ' be?'
  return 'What ' + label.toLowerCase() + ' should the ' + name + ' have?'
}

export const shapeOf = (command: NewShape) => command.type === 'create' ? command.primitive : command.sketch.geometry

export function withSize(command: NewShape, key: string, value: number) {
  if (command.type === 'create') return { ...command, primitive: changeNumeric(command.primitive, key, value) }
  let geometry = changeNumeric(command.sketch.geometry, key, value)
  if (geometry.kind === 'rectangle' && !command.source) geometry = { ...geometry, at: [-geometry.width / 2, -geometry.height / 2] }
  return { ...command, sketch: { ...command.sketch, geometry } }
}

export function suggestedSizes(command: NewShape, missing: string[]): NewShape {
  if (command.type !== 'create' || command.primitive.kind !== 'tube') return command
  const { radius, innerRadius } = command.primitive
  if (radius - innerRadius > EPS) return command
  if (missing.includes('innerDiameter')) return withSize(command, 'innerDiameter', radius * 1.2)
  if (missing.includes('diameter')) return withSize(command, 'diameter', Math.min(1e7, innerRadius * 3))
  return command
}

export function checkSize(value: number) {
  if (!Number.isFinite(value) || value < EPS || value > 1e7) throw new Error('Enter a size greater than zero and within the modeling range.')
}

export function validateSizes(command: NewShape) {
  for (const field of sizeFields(shapeOf(command))) checkSize(field.value)
  if (command.type === 'create' && command.primitive.kind === 'tube' && command.primitive.innerRadius >= command.primitive.radius - EPS) {
    throw new Error('The bore diameter must be smaller than the outside diameter.')
  }
}
