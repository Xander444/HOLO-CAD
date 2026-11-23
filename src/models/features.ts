import { EPS, onPlane } from './math'
import type { Frame, Vec3 } from './project'

export type PlaneReference = { at: Vec3; normal: Vec3 }
export type RectangularFace = { frame: Frame; width: number; height: number }
export type EdgeReference = { start: Vec3; end: Vec3; middle: Vec3 }
export type CornerPattern = { diameter: number; inset: number }
export type FaceDirection = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'
export const faceDirections: Record<FaceDirection, Vec3> = {
  top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
}

export function rectangleCorners({ frame, width, height }: RectangularFace): Vec3[] {
  return [onPlane(frame, [0, 0]), onPlane(frame, [width, 0]), onPlane(frame, [width, height]), onPlane(frame, [0, height])]
}

export function cornerHoleCenters({ frame, width, height }: RectangularFace, { diameter, inset }: CornerPattern): Vec3[] {
  if (!Number.isFinite(diameter) || diameter < EPS) throw new Error('Enter a hole diameter greater than zero.')
  if (!Number.isFinite(inset) || inset <= diameter / 2 + EPS) throw new Error('Set the inset greater than the hole radius so each hole stays within the face.')
  if (Math.min(width, height) - 2 * inset <= diameter + EPS) throw new Error('Reduce the diameter or inset so the four holes stay separate.')
  return [inset, width - inset].flatMap(x => [inset, height - inset].map(y => onPlane(frame, [x, y])))
}
