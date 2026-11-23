import type { Entity, Geometry, Primitive, Recipe } from './project'

export type Parameter = { key: string; label: string; value: number; unit: 'length' | 'angle'; path?: ('left' | 'right' | 'source')[] }
export type ParameterGroup = { label: string; values: Parameter[] }
const labels: Record<string, string> = {
  width: 'Width', height: 'Height', length: 'Length', size: 'Side', diameter: 'Diameter',
  innerDiameter: 'Bore diameter', depth: 'Depth', radiusX: 'X radius', radiusY: 'Y radius', angle: 'Angle',
  startAngle: 'Start angle', sweep: 'Sweep', x: 'Sketch U', y: 'Sketch V',
}
function params(input: Geometry | Primitive): Parameter[] {
  const list: Parameter[] = []
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'number') continue
    const mapped = key === 'radius' ? 'diameter' : key === 'innerRadius' ? 'innerDiameter' : key
    list.push({ key: mapped, label: labels[mapped] ?? mapped, value: mapped === key ? value : value * 2, unit: ['angle', 'startAngle', 'sweep'].includes(key) ? 'angle' : 'length' })
  }
  if ('at' in input) {
    const [x, y] = input.at
    list.push({ key: 'x', value: x, label: labels.x, unit: 'length' }, { key: 'y', value: y, label: labels.y, unit: 'length' })
  }
  return list
}
function recipeGroups(recipe: Recipe, path: NonNullable<Parameter['path']> = []): ParameterGroup[] {
  const wrap = (label: string, values: Parameter[]) => ({ label, values: values.map(parameter => ({ ...parameter, path })) })
  switch (recipe.kind) {
    case 'primitive': return [wrap(recipe.primitive.kind, params(recipe.primitive))]
    case 'extrude': return [wrap('Extrusion', [{ key: 'depth', label: 'Depth', value: recipe.depth, unit: 'length' }, ...params(recipe.sketch.geometry)])]
    case 'boolean': return [...recipeGroups(recipe.left.recipe, [...path, 'left']), ...recipeGroups(recipe.right.recipe, [...path, 'right'])]
    case 'split': return recipeGroups(recipe.source.recipe, [...path, 'source'])
    case 'holePattern': return [wrap('Four-hole pattern', [
      { key: 'holeDiameter', label: 'Hole diameter', value: recipe.pattern.diameter, unit: 'length' },
      { key: 'holeInset', label: 'Hole inset', value: recipe.pattern.inset, unit: 'length' },
    ]), ...recipeGroups(recipe.source.recipe, [...path, 'source'])]
    case 'chamfer': return [wrap('Chamfer', [
      { key: 'chamferDistance', label: 'Chamfer distance', value: recipe.distance, unit: 'length' },
    ]), ...recipeGroups(recipe.source.recipe, [...path, 'source'])]
    case 'brep': return []
  }
}
export function parameters(entity: Entity): ParameterGroup[] {
  if (entity.kind === 'body') return recipeGroups(entity.recipe).filter(group => group.values.length)
  const values = params(entity.sketch.geometry)
  return values.length ? [{ label: entity.sketch.geometry.kind, values }] : []
}
