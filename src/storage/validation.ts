import { z } from 'zod'
import { dot, norm } from '../models/math'
import { validateSketch } from '../commands/commands'
import type { Project, Recipe } from '../models/project'

const value = z.number().finite().min(-1e7).max(1e7)
const pos = value.min(.00001)
const v2 = z.tuple([value, value])
const v3 = z.tuple([value, value, value])
const frame = z.object({ origin: v3, u: v3, v: v3 }).refine(
  f => Math.abs(norm(f.u) - 1) < 1e-5 && Math.abs(norm(f.v) - 1) < 1e-5 && Math.abs(dot(f.u, f.v)) < 1e-5,
  'Construction plane axes must be perpendicular unit vectors.',
)
const transform = z.object({ position: v3, rotation: v3, scale: z.tuple([pos, pos, pos]) })
const geometry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), at: v2 }),
  z.object({ kind: z.literal('line'), at: v2, angle: value, length: pos }),
  z.object({ kind: z.literal('rectangle'), at: v2, angle: value, width: pos, height: value }),
  z.object({ kind: z.literal('circle'), at: v2, radius: pos }),
  z.object({ kind: z.literal('ellipse'), at: v2, radiusX: pos, radiusY: pos, angle: value }),
  z.object({ kind: z.literal('arc'), at: v2, radius: pos, startAngle: value, sweep: value }),
  z.object({ kind: z.literal('polyline'), points: z.array(v2).min(2).max(10000), closed: z.boolean() }),
])
const sketch = z.object({ frame, geometry }).superRefine((s, ctx) => {
  try { validateSketch(s) } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message })
  }
})
const primitive = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['box', 'prism']), width: pos, length: pos, height: pos }),
  z.object({ kind: z.literal('cube'), size: pos }),
  z.object({ kind: z.enum(['cylinder', 'cone']), radius: pos, height: pos }),
  z.object({ kind: z.literal('sphere'), radius: pos }),
  z.object({ kind: z.literal('tube'), radius: pos, innerRadius: pos, height: pos }),
])
const uuid = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_-]+$/)
const placed = z.object({ recipe: z.lazy(() => recipe), transform })
const recipe: z.ZodType<Recipe> = z.lazy(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('primitive'), primitive }),
  z.object({ kind: z.literal('extrude'), sketch, depth: value.refine(d => Math.abs(d) >= .00001), sourceId: uuid.optional() }),
  z.object({ kind: z.literal('boolean'), operation: z.enum(['union', 'subtract', 'intersect']), left: placed, right: placed }),
  z.object({ kind: z.literal('split'), source: placed, plane: frame, side: z.enum(['positive', 'negative']), piece: z.number().int().min(0).max(511) }),
  z.object({ kind: z.literal('holePattern'), source: placed,
    face: z.object({ at: v3, normal: v3.refine(n => Math.abs(norm(n) - 1) < 1e-5) }),
    pattern: z.object({ diameter: pos, inset: pos }),
  }),
  z.object({ kind: z.literal('chamfer'), source: placed, edge: z.object({ start: v3, end: v3, middle: v3 }), distance: pos }),
  z.object({ kind: z.literal('brep'), data: z.string().min(16).max(15_000_000) }),
]))
const base = {
  id: uuid, name: z.string().min(1).max(200), color: z.string().regex(/^#[0-9a-f]{6}$/i), hidden: z.boolean(),
  transform, parent: uuid.optional(), history: z.array(z.string().max(400)).max(200),
}
const object = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('body'), recipe }),
  z.object({ ...base, kind: z.literal('sketch'), sketch }),
])
const projectSchema = z.object({
  format: z.literal('holocad'), version: z.literal(1), id: uuid, name: base.name,
  created: z.iso.datetime(), modified: z.iso.datetime(),
  units: z.enum(['mm', 'cm', 'm', 'in']), objects: z.array(object).max(512), history: base.history,
})

function checkDepth(data: unknown) {
  const stack: { node: unknown; depth: number }[] = [{ node: data, depth: 0 }]
  while (stack.length) {
    const { node, depth } = stack.pop()!
    if (!node || typeof node !== 'object') continue
    if (depth > 104) throw new Error('This project exceeds the supported feature nesting depth.')
    for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push({ node: child, depth: depth + 1 })
  }
}
export function readProject(data: unknown): Project {
  if (typeof data !== 'object' || data === null || !('format' in data) || data.format !== 'holocad') throw new Error('Choose an editable .holocad.json file or import a STEP file.')
  if (!('version' in data) || data.version !== 1) throw new Error('This project uses an unsupported HOLO-CAD file version.')
  checkDepth(data)
  const result = projectSchema.safeParse(data)
  if (!result.success) throw new Error('Invalid project data at ' + (result.error.issues[0].path.join('.') || 'project') + '.')
  const project = result.data
  const ids = new Map(project.objects.map(o => [o.id, o]))
  if (ids.size !== project.objects.length) throw new Error('The project has duplicate object identifiers.')
  for (const o of project.objects) {
    const seen = new Set([o.id])
    let current = o
    while (current.parent) {
      if (seen.has(current.parent)) throw new Error('The project contains a circular attachment.')
      seen.add(current.parent)
      const parent = ids.get(current.parent)
      if (!parent) throw new Error('An attached object has a missing parent.')
      current = parent
    }
  }
  return project
}

export async function decodeProject(file: File) {
  if (file.size > 20_000_000) throw new Error('Choose a project file smaller than 20 MB.')
  let data: unknown
  try { data = JSON.parse(await file.text()) } catch { throw new Error('The project file contains invalid JSON.') }
  return readProject(data)
}
