import { blankProject, identity, makeBody } from './project'
import type { Project, Recipe, Vec3 } from './project'
import { planeFrame } from './math'

const primitive = (radius: number, height: number): Recipe => ({ kind: 'primitive', primitive: { kind: 'cylinder', radius, height } })

export function exampleProject(): Project {
  const project = blankProject('Rotor housing')
  project.id = 'rotor-housing'
  let plate: Recipe = {
    kind: 'extrude', depth: 11, sketch: {
      frame: planeFrame('XY'), geometry: {
        kind: 'polyline', closed: true,
        points: [[-53, -29], [-39, -43], [39, -43], [53, -29], [53, 29], [39, 43], [-39, 43], [-53, 29]],
      },
    },
  }
  const mountingPoints: Vec3[] = [[-38, -28, -1], [38, -28, -1], [38, 28, -1], [-38, 28, -1]]
  for (const at of [...mountingPoints, [0, 0, -1] as Vec3]) {
    plate = {
      kind: 'boolean', operation: 'subtract',
      left: { recipe: plate, transform: identity() },
      right: { recipe: primitive(at[0] === 0 ? 19 : 6, 14), transform: { ...identity(), position: at } },
    }
  }
  const base = makeBody('mounting-plate', 'Mounting plate', plate, identity(), '#3a98af')
  base.history = ['Extrude mounting profile · 11 mm', 'Bore and four mounting holes']
  const collar = makeBody('bearing-collar', 'Bearing collar', {
    kind: 'primitive', primitive: { kind: 'tube', radius: 32, innerRadius: 19, height: 21 },
  }, { ...identity(), position: [0, 0, 15] }, '#49bbcb')
  collar.history = ['Create tube · Ø64 × 21 mm']
  collar.parent = base.id
  const shoulder = makeBody('shoulder-ring', 'Shoulder ring', {
    kind: 'primitive', primitive: { kind: 'tube', radius: 36, innerRadius: 19, height: 4 },
  }, { ...identity(), position: [0, 0, 11] }, '#58b5c7')
  shoulder.parent = base.id
  shoulder.history = ['Create tube · Ø72 × 4 mm']
  project.objects = [base, collar, shoulder]
  project.history = ['Open rotor housing example']
  return project
}
