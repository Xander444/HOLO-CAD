import type { Body, Frame, Side, Vec3 } from '../models/project'
import type { BodyGeometry, Quality } from './kernel'

export type RenderGeometry = Record<string, BodyGeometry>
export type GeometryRequest =
  | { op: 'init' }
  | { op: 'render'; bodies: Body[] }
  | { op: 'split'; body: Body; plane: Frame; preview?: boolean }
  | { op: 'support'; body: Body; normal: Vec3 }
  | { op: 'export'; bodies: Body[]; format: 'stl' | 'step'; quality: Quality }
  | { op: 'import'; file: Blob }

export type GeometryResponse =
  | { op: 'init' }
  | { op: 'render'; results: RenderGeometry }
  | { op: 'split'; parts: { side: Side; piece: number }[]; preview?: BodyGeometry[] }
  | { op: 'support'; coordinate: number }
  | { op: 'export'; blob: Blob }
  | { op: 'import'; solids: string[] }

export type WorkerRequest = { id: number; request: GeometryRequest }
export type WorkerResponse = { id: number; result: GeometryResponse } | { id: number; error: string }
