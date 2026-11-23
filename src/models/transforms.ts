import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import type { Frame, Transform, Vec3 } from './project'
import { DEG, orientedFrame, planeNormal } from './math'

export function matrixOf(transform: Transform) {
  const [x, y, z] = transform.rotation.map(v => v * DEG)
  const rotation = new Quaternion().setFromEuler(new Euler(x, y, z, 'ZYX'))
  return new Matrix4().compose(new Vector3(...transform.position), rotation, new Vector3(...transform.scale))
}

export function transformOf(matrix: Matrix4): Transform {
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3()
  matrix.decompose(position, rotation, scale)
  const euler = new Euler().setFromQuaternion(rotation, 'ZYX')
  const transform: Transform = {
    position: position.toArray(), rotation: [euler.x / DEG, euler.y / DEG, euler.z / DEG], scale: scale.toArray(),
  }
  if (matrixOf(transform).elements.some((v, i) => Math.abs(v - matrix.elements[i]) > 1e-6 * Math.max(1, Math.abs(v)))) {
    throw new Error('This group transformation would shear a child body. Use uniform scaling or detach it first.')
  }
  return transform
}

export const transformPoint = (p: Vec3, matrix: Matrix4): Vec3 => new Vector3(...p).applyMatrix4(matrix).toArray()
export const transformDirection = (p: Vec3, matrix: Matrix4): Vec3 => new Vector3(...p).transformDirection(matrix).toArray()

export function transformFrame(frame: Frame, transform: Transform): Frame {
  const matrix = matrixOf(transform)
  const origin = transformPoint(frame.origin, matrix)
  const u = new Vector3(...frame.u).transformDirection(matrix)
  const v = new Vector3(...frame.v).transformDirection(matrix)
  return orientedFrame(origin, u.clone().cross(v).toArray(), u.toArray())
}

export function transformedNormal(frame: Frame, transform: Transform) {
  return planeNormal(transformFrame(frame, transform))
}
