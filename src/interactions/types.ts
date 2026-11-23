import type { BodyGeometry, Bounds, FaceReference } from '../cad/kernel'
import type { BooleanKind, Axis, Frame, PlaneName, Sketch, Transform, Vec3 } from '../models/project'
import type { CornerPattern, EdgeReference, RectangularFace } from '../models/features'
import type { AlignMode, ViewName } from '../voice/parser'
import type { ScreenPoint, TrackedHand } from '../vision/tracking'
import type { Snap } from './snap'

export type Tool = 'select' | 'point' | 'line' | 'rectangle' | 'circle' | 'ellipse' | 'arc' | 'polyline' | 'primitive' |
  'extrude' | 'move' | 'rotate' | 'scale' | 'cut' | 'hole' | 'holePattern' | 'chamfer' | 'union' | 'subtract' | 'intersect' | 'attach' | 'measure'
export type Mode = 'Idle' | 'Hover' | 'Selection' | 'DrawingLine' | 'DrawingRectangle' | 'SketchEditing' | 'Extruding' |
  'Grabbing' | 'Moving' | 'Orbiting' | 'RotatingObject' | 'CuttingPreview' | 'AwaitingDimension' | 'AwaitingAlignment' |
  'AwaitingJoinConfirmation' | 'AwaitingDeleteConfirmation' | 'FeaturePreview' | 'ErrorRecovery'
export type CutChoice = PlaneName | 'view' | 'custom'
export type Preview =
  | { kind: 'sketch'; sketch: Sketch; transform?: Transform; label?: string; snap?: Snap }
  | { kind: 'extrude'; sketch: Sketch; transform: Transform; depth: number }
  | { kind: 'move'; target: string; ids: string[]; from: Transform; to: Transform; snap?: Snap; danger?: boolean; fromHand?: boolean }
  | { kind: 'cut'; frame: Frame; bounds: Bounds; body: string; meshes?: BodyGeometry[]; line?: ScreenPoint[] }
  | { kind: 'measure'; points: Vec3[] }
  | { kind: 'hole'; at: Vec3; normal: Vec3; rectangular: boolean; width: number; height: number }
  | { kind: 'holePattern'; face: RectangularFace; points: Vec3[]; diameter: number }
  | { kind: 'chamfer'; edge: PickedEdge; mesh?: BodyGeometry }
  | { kind: 'orbit'; at: ScreenPoint }
export type Dimension = { kind: 'dimension'; id: string; key: string; label: string; value: number }
export type Extrusion = { kind: 'extrude'; id: string; depth: number }
export type Cut = { kind: 'cut'; id: string; plane: Frame; choice: CutChoice; offset: number; error?: string }
export type Hole = { kind: 'hole'; id: string; face: FaceReference; at: Vec3; mode: 'through' | 'blind' | 'rectangular'; width: number; height: number; depth: number }
type FeaturePhase = 'choosing' | 'checking' | 'ready' | 'invalid'
export type HolePattern = { kind: 'holePattern'; id: string; face?: FaceReference; pattern: CornerPattern; phase: FeaturePhase; error?: string }
export type Chamfer = { kind: 'chamfer'; id: string; edge: PickedEdge; distance: number; phase: FeaturePhase; error?: string }
export type FeatureDraft = HolePattern | Chamfer
export type Alignment = { kind: 'align'; target: string; reference: string; mode: AlignMode; position: Vec3; face?: FaceReference; choice?: boolean }
export type Join = { kind: 'join'; target: string; reference: string; position: Vec3; face?: FaceReference }
export type Dialog = Dimension | Extrusion | Cut | Hole | Alignment | Join | FeatureDraft |
  { kind: 'delete'; ids: string[] } | { kind: 'boolean'; operation: BooleanKind; target: string; tool: string } |
  { kind: 'confirm'; question: string; action: () => void } | { kind: 'voice'; question: string; action: () => void }

export type Pick = { id: string; point: Vec3; normal?: Vec3 }
export type PickedEdge = { id: string; reference: EdgeReference; segments: Vec3[] }
export type StagePort = {
  readonly dimensions: ScreenPoint
  pick(point: ScreenPoint): Pick | undefined
  edgeAt?(point: ScreenPoint): PickedEdge | undefined
  world(point: ScreenPoint, frame: Frame): Vec3 | undefined
  axisDelta(start: ScreenPoint, point: ScreenPoint, origin: Vec3, direction: Vec3): number
  screen(p: Vec3): ScreenPoint
  direction(): Vec3
  orbit(dx: number, dy: number): void
  stopMotion?(): void
  view(name: ViewName): void
  zoom(direction: 1 | -1): void
}
export type InteractionState = {
  tool: Tool; mode: Mode; plane: PlaneName; axis?: Axis; dialog?: Dialog; preview?: Preview;
  hover?: string; aimedEdge?: PickedEdge; hands: TrackedHand[]; message: string; gesture?: string; polylineCount: number;
}
