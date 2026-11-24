import type { BodyGeometry, FaceReference } from '../cad/kernel'
import type { RenderGeometry } from '../cad/protocol'
import { applyFeature, descendants } from '../commands/commands'
import type { Command, FeatureCommand } from '../commands/commands'
import type { WorkspaceModel } from '../app/model'
import {
  AXES, DEG, EPS, add, axisIndex, closedSketch, cross, dot, extendLine, formatDimension, lineGeometry,
  midpoint, mul, norm, onPlane, orientedFrame, planeFrame, planeNormal, sketchPath, sub, toPlane, UNIT_FACTORS,
} from '../models/math'
import { defaultPrimitive, entityType, identity, makeBody, uid } from '../models/project'
import { parameters } from '../models/parameters'
import { cornerHoleCenters, faceDirections } from '../models/features'
import type { CornerPattern } from '../models/features'
import type { Axis, Body, BooleanKind, Entity, Frame, Geometry, PlaneName, SketchObject, Transform, Vec2, Vec3 } from '../models/project'
import { matrixOf, transformFrame, transformPoint, transformedNormal } from '../models/transforms'
import type { Pose, ScreenPoint, TrackedHand } from '../vision/tracking'
import type { Event, Context, GestureMode } from '../gestures/engine'
import { dimensionList, objectNameKey, parseIntent, primitiveFromIntent, quantity } from '../voice/parser'
import type { AlignMode, FeatureFace, Intent, WorkspacePanel } from '../voice/parser'
import { alignBounds, collectSnapTargets, faceAt, roundToGrid, snapContact, snapLineAxis, snapNames, snapPoint } from './snap'
import type { Snap, SnapTargets } from './snap'
import type { Settings } from './settings'
import { checkSize, shapeOf, sizeFields, sizeQuestion, sizeTarget, suggestedSizes, validateSizes, withSize } from './sizing'
import type { NewShape } from './sizing'
import type { Alignment, Chamfer, Creation, Cut, CutChoice, Dialog, Dimension, Extrusion, FeatureDraft, Hole, HolePattern, InteractionState, Join, Mode, Pick as StagePick, PickedEdge, Preview, StagePort, Tool } from './types'

type Drawing = {
  kind: 'draw'; tool: Tool; frame: Frame; start: Vec2; source?: SketchObject; exact?: number;
  firstSnap?: Snap; endSnap?: Snap; axisSnap?: 0 | 1;
}
type Move = {
  kind: 'move'; object: Entity; ids: string[]; start: ScreenPoint; origin: Vec3; outside?: number;
  contact?: Join; heldContact?: string; fromHand: boolean;
}
type Active = Drawing | Move |
  { kind: 'extrude'; dialog: Extrusion; start: ScreenPoint; depth: number } |
  { kind: 'cut'; points: ScreenPoint[]; initial: Cut } | { kind: 'orbit'; previous: ScreenPoint } |
  { kind: 'select'; id: string }
type Actions = {
  saveAs(): void; open(): void; fresh(): void; export(format: 'stl' | 'step'): void;
  speak(message: string): void; settings(): Settings; snap(): void; commandFocus(): void;
  stopPrompt?(): void; help?(): void; mute?(): void; panel?(panel: WorkspacePanel, show: boolean): void;
}
const drawingTools: Tool[] = ['point', 'line', 'rectangle', 'circle', 'ellipse', 'arc', 'polyline']
const modeTool: Partial<Record<Tool, Mode>> = {
  line: 'DrawingLine', rectangle: 'DrawingRectangle', extrude: 'Extruding', cut: 'CuttingPreview', move: 'Moving', rotate: 'RotatingObject',
}
const toolMessage: Partial<Record<Tool, string>> = {
  line: 'Drag to draw a line on the construction plane.', rectangle: 'Drag to draw a rectangle, or drag outward from a selected line.',
  point: 'Click to place a sketch point.', polyline: 'Click to add points. Enter closes the profile.',
  circle: 'Drag from the center to set the circle radius.', ellipse: 'Drag from the center to set both radii.',
  arc: 'Drag from the center to set radius and start angle. Edit Sweep in Properties.',
  move: 'Drag a body or use its axis handles.', rotate: 'Drag a rotation ring, or enter an angle.',
  scale: 'Drag a scale handle, or enter a factor.', measure: 'Pick two points to measure the distance.',
  chamfer: 'Point or click near the middle of an exposed edge.',
  select: 'Click to select. Shift-click to select multiple objects.',
}
const operationName: Record<BooleanKind, string> = { union: 'Fuse', subtract: 'Subtract', intersect: 'Intersect' }
const depthQuestion = 'How deep should the extrusion be?'
const initial: InteractionState = { tool: 'select', plane: 'XY', mode: 'Idle', hands: [], message: '', polylineCount: 0 }
const before = (p: ScreenPoint, q: ScreenPoint) => Math.hypot(p[0] - q[0], p[1] - q[1])
type Model = Pick<WorkspaceModel, 'get' | 'select' | 'commit' | 'fail' | 'notice' | 'step' | 'save'> &
  { readonly kernel: Pick<WorkspaceModel['kernel'], 'request'> }

// This controller owns interaction previews. Only WorkspaceModel.commit can change a project.
export class InteractionController {
  stage?: StagePort
  private snapshot: InteractionState = initial
  private listeners = new Set<() => void>()
  private active?: Active
  private sketchPoints: Vec2[] = []
  private measured: Vec3[] = []
  private mouseUntil = 0
  private gestureBlockedUntil = 0
  private working = false
  private picked?: StagePick
  private facePicks = new Map<string, StagePick>()
  private alignmentRevision = 0
  private lastDimension?: { id: string; key: string; time: number }
  private cutRevision = 0
  private cutTimer?: ReturnType<typeof setTimeout>
  private cutPending = false
  private cutQueued?: Cut
  private featureSequence = 0
  private featureTimer?: ReturnType<typeof setTimeout>
  private featureSource?: Body
  private pointerEdge?: PickedEdge
  private sketchTargets?: { objects: Entity[]; meshes: RenderGeometry; targets: SnapTargets }

  constructor(readonly model: Model, private actions: Actions) {}
  get = () => this.snapshot
  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb) }
  private patch(state: Partial<InteractionState>) {
    this.snapshot = { ...this.snapshot, ...state }
    for (const listener of this.listeners) listener()
  }
  get settings() { return this.actions.settings() }
  get object() {
    const { project, selection } = this.model.get()
    return project.objects.find(o => o.id === selection.at(-1))
  }
  private get baseMode(): Mode { return this.object ? 'Selection' : 'Idle' }
  private get frame() { return planeFrame(this.snapshot.plane) }
  private get canEdit() { const { ready, busy } = this.model.get(); return ready && !busy && !this.working }
  private get units() { return this.model.get().project.units }
  private get selectedIds() { return this.model.get().selection }
  private get entities() { return this.model.get().project.objects }
  private get meshes() { return this.model.get().meshes }

  private error(error: unknown) {
    this.model.fail(error)
    this.patch({ mode: 'ErrorRecovery' })
  }
  private dialog(dialog: Dialog, message: string, speak = false) {
    const mode: Mode = dialog.kind === 'dimension' || dialog.kind === 'creation' ? 'AwaitingDimension' : dialog.kind === 'extrude' ? 'Extruding' :
      dialog.kind === 'cut' ? 'CuttingPreview' : dialog.kind === 'delete' ? 'AwaitingDeleteConfirmation' :
      dialog.kind === 'holePattern' || dialog.kind === 'chamfer' ? 'FeaturePreview' :
      dialog.kind === 'align' ? 'AwaitingAlignment' : ['join', 'boolean', 'confirm', 'voice'].includes(dialog.kind) ? 'AwaitingJoinConfirmation' : 'SketchEditing'
    this.patch({ dialog, mode, message })
    if (speak) this.actions.speak(message)
  }
  private async commit(command: Command, clear = true) {
    if (!this.canEdit) return false
    this.working = true
    try {
      const ok = await this.model.commit(command)
      if (ok && clear) this.patch({ preview: undefined, dialog: undefined, mode: this.baseMode, gesture: undefined, message: '' })
      else if (!ok) {
        this.patch({ mode: 'ErrorRecovery' })
        const error = this.model.get().error
        if (error) this.actions.speak(error)
      }
      return ok
    } finally { this.working = false }
  }

  cancel = () => {
    if (this.snapshot.dialog) this.actions.stopPrompt?.()
    if (this.active?.kind === 'orbit') this.stage?.stopMotion?.()
    this.active = undefined
    this.sketchPoints = []
    this.measured = []
    this.cutRevision++
    this.alignmentRevision++
    this.cutQueued = undefined
    clearTimeout(this.cutTimer)
    this.featureSequence++
    this.featureSource = undefined
    clearTimeout(this.featureTimer)
    this.pointerEdge = undefined
    this.gestureBlockedUntil = performance.now() + 250
    this.patch({ preview: undefined, dialog: undefined, mode: this.baseMode, gesture: undefined, message: '', polylineCount: 0 })
  }
  clear = () => { this.cancel(); this.model.select([]); this.picked = undefined; this.patch({ tool: 'select', mode: 'Idle' }) }
  reset = () => { this.clear(); this.facePicks.clear(); this.lastDimension = undefined; this.patch({ plane: 'XY', axis: undefined }) }
  mouse = (down: boolean) => { this.mouseUntil = down ? Infinity : performance.now() + 550 }

  setPlane(plane: PlaneName) {
    if (this.snapshot.dialog?.kind === 'cut') { this.setCut({ choice: plane }); return }
    this.cancel()
    this.patch({ plane, message: plane + ' construction plane' })
  }
  setAxis(axis?: Axis) {
    this.patch({ axis, message: axis ? 'Constrained to ' + axis : 'Axis constraint cleared' })
  }
  setTool(tool: Tool) {
    if (!this.canEdit) return
    this.cancel()
    this.patch({ tool, mode: modeTool[tool] ?? this.baseMode, message: toolMessage[tool] ?? '' })
    if (tool === 'extrude') this.beginExtrude(this.object, true)
    if (tool === 'cut') this.beginCut(this.object)
    if (tool === 'hole') this.beginHole(this.object)
    if (tool === 'holePattern') this.beginPattern()
    if (tool === 'union' || tool === 'subtract' || tool === 'intersect') this.boolean(tool)
    if (tool === 'attach') this.attach()
  }
  select(id: string, multi = false) {
    const ids = this.selectedIds
    const current = multi ? ids.includes(id) ? ids.filter(v => v !== id) : [...ids, id] : [id]
    if (this.snapshot.dialog && this.snapshot.dialog.kind !== 'dimension') this.cancel()
    else if (this.snapshot.dialog?.kind === 'dimension' && (this.snapshot.dialog.id !== id || multi)) this.cancel()
    if (this.picked?.id !== id) this.picked = undefined
    this.model.select(current)
    if (!this.snapshot.dialog) this.patch({ mode: this.baseMode, message: '' })
  }
  hover(p: ScreenPoint | undefined) {
    if (this.active || this.snapshot.dialog) return
    const hit = p ? this.stage?.pick(p)?.id : undefined
    if (this.snapshot.tool === 'chamfer') this.pointerEdge = p && this.stage?.edgeAt?.(p)
    const edge = this.snapshot.tool === 'chamfer' ? this.pointerEdge : this.snapshot.aimedEdge
    const aimedEdge = edge?.reference === this.snapshot.aimedEdge?.reference ? this.snapshot.aimedEdge : edge
    if (hit === this.snapshot.hover && aimedEdge === this.snapshot.aimedEdge) return
    this.patch({ hover: hit, aimedEdge, mode: hit ? 'Hover' : this.baseMode })
  }

  create = (shape: Parameters<typeof defaultPrimitive>[0]) => {
    this.beginCreation({ type: 'create', primitive: defaultPrimitive(shape), at: this.creationPoint() })
  }

  private beginCreation(command: NewShape, supplied: string[] = []) {
    if (!this.canEdit) return
    const missing = sizeFields(shapeOf(command)).map(field => field.key).filter(key => !supplied.includes(key))
    const draft = suggestedSizes(command, missing)
    validateSizes(draft)
    this.cancel()
    this.patch({ tool: 'select' })
    if (missing.length) this.showCreation({ kind: 'creation', command: draft, missing }, true)
    else void this.commit(draft)
  }

  private showCreation(draft: Creation, speak: boolean) {
    const { command, missing } = draft
    const shape = shapeOf(command)
    const field = sizeFields(shape).find(size => size.key === missing[0])!
    const source = command.type === 'sketch' ? this.entities.find(object => object.id === command.source) : undefined
    this.patch({ preview: command.type === 'sketch' ? { kind: 'sketch', sketch: command.sketch, transform: source?.transform } : undefined })
    this.dialog(draft, sizeQuestion(shape.kind, field), speak)
    if (command.type === 'create') {
      const id = uid()
      const body = makeBody(id, 'Preview', { kind: 'primitive', primitive: command.primitive }, { ...identity(), position: command.at ?? [0, 0, 0] }, command.color)
      void this.model.kernel.request({ op: 'render', bodies: [body] }).then(({ results }) => {
        const current = this.snapshot.dialog
        if (current?.kind === 'creation' && current.command === command && !this.working && results[id]) {
          this.patch({ preview: { kind: 'primitive', mesh: results[id], color: command.color } })
        }
      }).catch(() => {
        // A missing preview leaves the size fields available for correction or confirmation.
      })
    }
  }

  private creationAnswer(dialog: Creation, answers: { key: string; value: number; adjustment?: 'set' | 'add' | 'multiply' }[]) {
    let { command, missing } = dialog
    let lastKey: string | undefined
    try {
      for (const answer of answers) {
        const target = sizeTarget(shapeOf(command), answer.key)
        if (!target) throw new Error('That dimension is unavailable on this shape.')
        const { field, factor } = target
        const value = answer.adjustment === 'add' ? field.value + answer.value * factor :
          answer.adjustment === 'multiply' ? field.value * answer.value : answer.value * factor
        checkSize(value)
        command = withSize(command, field.key, value)
        missing = missing.filter(key => key !== field.key)
        lastKey = field.key
      }
      command = suggestedSizes(command, missing)
      validateSizes(command)
    } catch (error) {
      this.patch({ dialog: { ...dialog, error: (error as Error).message } })
      return
    }
    const next = { ...dialog, command, missing, error: undefined }
    if (missing.length) this.showCreation(next, missing[0] !== dialog.missing[0])
    else {
      this.patch({ dialog: next, message: 'Creating ' + shapeOf(command).kind + '…' })
      void this.finishCreation(next, lastKey)
    }
  }

  private async finishCreation(draft: Creation, lastKey?: string) {
    if (!this.canEdit || this.snapshot.dialog !== draft) return
    this.actions.stopPrompt?.()
    if (await this.commit(draft.command)) {
      if (lastKey && this.object) this.lastDimension = { id: this.object.id, key: lastKey, time: performance.now() }
    } else if (this.snapshot.dialog === draft) {
      const missing = draft.missing.length ? draft.missing : sizeFields(shapeOf(draft.command)).map(field => field.key)
      this.showCreation({ ...draft, missing }, false)
    }
  }
  private creationPoint(): Vec3 {
    const { project } = this.model.get()
    if (!project.objects.some(o => !o.hidden && o.kind === 'body')) return [0, 0, 0]
    const last = this.object && this.meshes[this.object.id]
    return last ? [last.bounds[1][0] + 26, midpoint(...last.bounds)[1], 0] : [0, 0, 0]
  }
  delete(ids = this.selectedIds) {
    if (!ids.length) { this.error(new Error('Select an object to delete.')); return }
    this.dialog({ kind: 'delete', ids }, ids.length === 1 ? 'Delete this object?' : 'Delete ' + ids.length + ' selected objects?', true)
  }
  duplicate() { void this.commit({ type: 'duplicate', ids: this.selectedIds }) }
  update(command: Command) { void this.commit(command, false) }
  transform(ids: string[], target: string, value: Transform, label?: string) {
    this.patch({ preview: undefined })
    void this.commit({ type: 'transform', ids, target, value, label })
  }

  private world(p: ScreenPoint, frame: Frame, bypass = false, held?: Snap) {
    const stage = this.stage
    const raw = stage?.world(p, frame)
    if (!stage || !raw) return
    const settings = this.settings
    if (bypass || !settings.snap) return { raw, point: raw }
    const objects = this.entities, meshes = this.meshes
    if (this.sketchTargets?.objects !== objects || this.sketchTargets.meshes !== meshes) {
      this.sketchTargets = { objects, meshes, targets: collectSnapTargets(objects, meshes) }
    }
    return { raw, ...snapPoint(raw, frame, settings, stage, this.sketchTargets.targets, held) }
  }
  private localPoint(p: ScreenPoint, frame: Frame, source?: SketchObject, bypass = false, held?: Snap) {
    const worldFrame = source ? transformFrame(frame, source.transform) : frame
    const hit = this.world(p, worldFrame, bypass, held)
    if (!hit) return
    const inverse = source && matrixOf(source.transform).invert()
    const local = (point: Vec3) => toPlane(frame, inverse ? transformPoint(point, inverse) : point)
    return { point: local(hit.point), raw: local(hit.raw), snap: hit.snap }
  }
  private startDraw(tool: Tool, p: ScreenPoint, source?: SketchObject, bypass = false) {
    const frame = source?.sketch.frame ?? this.frame
    const start = this.localPoint(p, frame, source, bypass)
    if (!start) return false
    this.active = { kind: 'draw', tool, start: start.point, firstSnap: start.snap, frame, source }
    this.patch({ dialog: undefined, mode: modeTool[tool] ?? 'SketchEditing', message: '' })
    return true
  }
  private draw(active: Drawing, p: ScreenPoint, first?: ScreenPoint, bypass = false) {
    const { frame, source } = active
    const end = this.localPoint(p, frame, source, bypass, active.endSnap)
    const start = first ? this.localPoint(first, frame, source, bypass, active.firstSnap) : undefined
    if (!end || (first && !start)) return
    if (start) active.firstSnap = start.snap
    const a = start?.point ?? active.start
    const point = end.point
    const dx = point[0] - a[0], dy = point[1] - a[1]
    active.endSnap = end.snap
    let snap = end.snap
    let geometry: Geometry
    let label: string | undefined
    switch (active.tool) {
      case 'line': {
        const axis = this.snapshot.axis
        const previous = active.axisSnap
        active.axisSnap = undefined
        if (axis) {
          const dir = AXES[axis]
          const x = dot(dir, frame.u), y = dot(dir, frame.v)
          if (Math.abs(x) + Math.abs(y) < EPS) {
            this.patch({ preview: undefined, message: axis + ' is perpendicular to the active plane.' })
            return
          }
          const along = (x * dx + y * dy) / (x * x + y * y)
          const constrained: Vec2 = [a[0] + x * along, a[1] + y * along]
          geometry = lineGeometry(a, constrained)
          label = axis + ' axis'
          if (Math.hypot(point[0] - constrained[0], point[1] - constrained[1]) > EPS) snap = undefined
        } else {
          const settings = this.settings
          const guide = !bypass && this.stage && settings.snap && settings.snapTypes.axis && (!snap || snap.kind === 'grid') ?
            snapLineAxis(a, end.raw, point, p => onPlane(frame, p), this.stage, settings.snapStrength, previous) : undefined
          geometry = lineGeometry(a, guide?.point ?? point)
          if (guide) { active.axisSnap = guide.axis; snap = guide.snap }
        }
        break
      }
      case 'rectangle': {
        const line = active.source?.sketch.geometry
        geometry = line?.kind === 'line' ? extendLine(line, point) :
          { kind: 'rectangle', at: a, angle: dx < 0 ? 180 : 0, width: Math.abs(dx), height: dx < 0 ? -dy : dy }
        break
      }
      case 'circle': geometry = { kind: 'circle', at: a, radius: Math.hypot(dx, dy) }; break
      case 'ellipse': geometry = { kind: 'ellipse', at: a, radiusX: Math.abs(dx), radiusY: Math.abs(dy), angle: 0 }; break
      case 'arc': geometry = { kind: 'arc', at: a, radius: Math.hypot(dx, dy), startAngle: Math.atan2(dy, dx) / DEG, sweep: 90 }; break
      default: geometry = { kind: 'point', at: point }
    }
    if (active.exact !== undefined) {
      geometry = preciseSketchDimension(geometry, active.exact)
      snap = undefined
    }
    this.patch({ preview: { kind: 'sketch', sketch: { frame, geometry }, transform: source?.transform, label, snap },
      message: snap && snap.kind !== 'grid' ? snapNames[snap.kind] + ' snap' : '' })
  }
  private async finishDraw(active: Drawing) {
    const preview = this.snapshot.preview
    if (preview?.kind !== 'sketch') return
    const geometry = preview.sketch.geometry
    const done = await this.commit({ type: 'sketch', sketch: preview.sketch, source: active.source?.id })
    if (!done) { this.patch({ preview: undefined }); return }
    const object = this.object
    if (object?.kind !== 'sketch') return
    const fields = sizeFields(geometry).map(field => field.key)
    const first = geometry.kind === 'rectangle' ? 'height' : fields[0]
    const remaining = fields.filter(key => !(active.source && key === 'width') && !(active.exact !== undefined && key === first))
    if (remaining.length) this.askDrawnSize(object, remaining, true)
  }

  private askDrawnSize(object: SketchObject, remaining: string[], speak: boolean) {
    const shape = object.sketch.geometry
    const field = sizeFields(shape).find(value => value.key === remaining[0])!
    this.dialog({ kind: 'dimension', id: object.id, remaining, ...field }, sizeQuestion(shape.kind, field), speak)
  }

  private async drawnAnswer(dialog: Dimension, key: string, amount: number, adjustment?: 'set' | 'add' | 'multiply') {
    const object = this.entities.find(candidate => candidate.id === dialog.id)
    if (object?.kind !== 'sketch') return
    const target = sizeTarget(object.sketch.geometry, key)
    if (!target) {
      if (this.parameter(object, key)) await this.setDimension(object, key, amount, adjustment)
      else this.patch({ dialog: { ...dialog, error: 'That dimension is unavailable on this sketch.' } })
      return
    }
    const { field, factor } = target
    const value = adjustment === 'add' ? field.value + amount * factor : adjustment === 'multiply' ? field.value * amount : amount * factor
    try { checkSize(value) } catch (error) {
      this.patch({ dialog: { ...dialog, error: (error as Error).message } })
      return
    }
    if (!await this.commit({ type: 'parameter', id: object.id, key: field.key, value }, false) || this.snapshot.dialog !== dialog) return
    this.lastDimension = { id: object.id, key: field.key, time: performance.now() }
    const remaining = dialog.remaining.filter(key => key !== field.key)
    const updated = this.object
    if (remaining.length && updated?.kind === 'sketch') this.askDrawnSize(updated, remaining, remaining[0] !== dialog.key)
    else {
      this.actions.stopPrompt?.()
      this.patch({ dialog: undefined, mode: this.baseMode, message: '' })
    }
  }

  private pickLine(p: ScreenPoint) {
    const selected = this.object
    if (selected?.kind !== 'sketch' || selected.sketch.geometry.kind !== 'line' || !this.stage) return
    const [a, b] = sketchPath(selected.sketch).map(v => this.stage!.screen(transformPoint(v, matrixOf(selected.transform))))
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / Math.max(EPS, dx * dx + dy * dy)))
    if (before(p, [a[0] + dx * t, a[1] + dy * t]) < .045) return selected
  }
  private sketchCenter(object: SketchObject): Vec3 {
    const points = sketchPath(object.sketch).map(p => transformPoint(p, matrixOf(object.transform)))
    return [0, 1, 2].map(i => (Math.min(...points.map(p => p[i])) + Math.max(...points.map(p => p[i]))) / 2) as Vec3
  }
  private beginExtrude(object: Entity | undefined, speak = false) {
    if (object?.kind !== 'sketch' || !closedSketch(object.sketch.geometry)) {
      this.error(new Error('Select a closed sketch to extrude. You can extend a line into a rectangle first.'))
      return
    }
    const dialog: Extrusion = { kind: 'extrude', id: object.id, depth: 20 }
    this.dialog(dialog, speak ? depthQuestion : 'Pull to set the depth.', speak)
    this.previewExtrude(dialog)
  }
  previewExtrude(dialog: Extrusion) {
    const object = this.entities.find(o => o.id === dialog.id)
    if (object?.kind !== 'sketch') return
    this.patch({ dialog: { ...dialog, error: undefined }, preview: { kind: 'extrude', sketch: object.sketch, transform: object.transform, depth: dialog.depth } })
  }
  private async finishExtrude(id: string, depth: number) {
    const dialog = this.snapshot.dialog
    if (!Number.isFinite(depth) || Math.abs(depth) < EPS || Math.abs(depth) > 1e7) {
      const error = 'Enter a nonzero depth within the modeling range.'
      if (dialog?.kind === 'extrude') this.patch({ dialog: { ...dialog, error }, message: depthQuestion })
      else this.error(new Error(error))
      return
    }
    this.active = undefined
    if (dialog?.kind === 'extrude') this.actions.stopPrompt?.()
    if (await this.commit({ type: 'extrude', id, depth })) this.patch({ tool: 'select' })
  }

  private beginMove(object: Entity, point: ScreenPoint, fromHand = false) {
    const ids = this.selectedIds.includes(object.id) ? this.selectedIds : [object.id]
    this.model.select(ids)
    const origin = this.meshes[object.id] ? midpoint(...this.meshes[object.id].bounds) :
      object.kind === 'sketch' ? this.sketchCenter(object) : object.transform.position
    this.active = { kind: 'move', object, ids, start: point, origin, fromHand }
    this.patch({ dialog: undefined, mode: 'Grabbing', preview: undefined, message: '' })
  }
  private move(active: Move, point: ScreenPoint, time: number, bypass: boolean) {
    if (!this.stage) return
    const axis = this.snapshot.axis
    const settings = this.settings
    let delta: Vec3
    let motionPlane: Frame | undefined
    if (axis) delta = mul(AXES[axis], this.stage.axisDelta(active.start, point, active.origin, AXES[axis]))
    else {
      let frame = planeFrame(this.snapshot.plane, active.origin)
      let from = this.stage.world(active.start, frame)
      let to = this.stage.world(point, frame)
      if (!from || !to) {
        frame = orientedFrame(active.origin, this.stage.direction())
        from = this.stage.world(active.start, frame)
        to = this.stage.world(point, frame)
      }
      if (!from || !to) return
      delta = sub(to, from)
      motionPlane = { ...frame, origin: [0, 0, 0] }
    }
    const beyond = point.some(value => value < -.018 || value > 1.018)
    active.outside = beyond ? active.outside ?? time : undefined
    const danger = active.outside !== undefined && time - active.outside >= 190
    const moving = this.meshes[active.object.id]
    const owned = descendants(this.entities, active.ids)
    const candidates = this.entities.filter(o => !o.hidden && !owned.has(o.id) && this.meshes[o.id] && o.id !== active.object.parent)
      .map(o => ({ id: o.id, mesh: this.meshes[o.id] }))
    const contact = !bypass && !beyond && settings.snap && moving ? snapContact(moving, delta, candidates, {
      view: this.stage, settings, axis, normal: motionPlane && planeNormal(motionPlane), held: active.heldContact,
    }) : undefined
    active.heldContact = contact?.key
    let offset = contact?.delta ?? delta
    if (!contact && !bypass && settings.snap && settings.snapTypes.grid) {
      const round = (v: number) => roundToGrid(v, settings.grid)
      offset = motionPlane ? onPlane(motionPlane, toPlane(motionPlane, delta).map(round) as Vec2) : delta.map(round) as Vec3
    }
    const position = add(active.object.transform.position, offset)
    active.contact = contact ? { kind: 'join', target: active.object.id, reference: contact.id, position, face: contact.face } : undefined
    this.patch({
      mode: 'Moving', preview: { kind: 'move', target: active.object.id, ids: [...owned], from: active.object.transform,
        to: { ...active.object.transform, position }, snap: contact?.snap, danger, fromHand: active.fromHand },
      message: danger ? 'Release to request deletion' : contact ? snapNames[contact.snap.kind] + ' snap' :
        position.map((v, i) => 'XYZ'[i] + ' ' + formatDimension(v, this.units, settings.precision)).join(' · '),
    })
  }
  private finishMove(active: Move) {
    const preview = this.snapshot.preview
    if (preview?.kind !== 'move') { this.patch({ mode: this.baseMode }); return }
    if (preview.danger) { this.delete(active.ids); return }
    if (active.contact) { this.dialog(active.contact, 'Attach or fuse?', true); return }
    const command: Command = { type: 'transform', ids: active.ids, target: active.object.id, value: preview.to, label: 'Move' }
    void this.commit(command).then(ok => {
      if (!ok && this.snapshot.preview === preview) this.patch({ preview: undefined })
    })
  }

  private beginCut(object: Entity | undefined, cuttingPlane?: Frame) {
    if (object?.kind !== 'body' || !this.meshes[object.id]) { this.error(new Error('Select a solid to split.')); return }
    const center = midpoint(...this.meshes[object.id].bounds)
    const dialog: Cut = { kind: 'cut', id: object.id, plane: cuttingPlane ?? planeFrame('YZ', center), choice: cuttingPlane ? 'view' : 'YZ', offset: 0 }
    this.dialog(dialog, 'Position the cutting plane. Say confirm to keep both sides.', true)
    this.previewCut(dialog)
    return dialog
  }
  setCut(change: { choice?: CutChoice; offset?: number; normal?: Vec3 }) {
    const dialog = this.snapshot.dialog
    if (dialog?.kind !== 'cut') return
    const choice = change.choice ?? dialog.choice
    const offset = change.offset ?? dialog.offset
    if (!Number.isFinite(offset)) return
    const origin = midpoint(...this.meshes[dialog.id].bounds)
    try {
      const frame = choice === 'view' || choice === 'custom' ?
        orientedFrame(origin, change.normal ?? (change.choice === 'view' ? this.stage?.direction() ?? AXES.Y : planeNormal(dialog.plane))) :
        planeFrame(choice, origin)
      frame.origin = add(origin, mul(planeNormal(frame), offset))
      this.previewCut({ ...dialog, choice, offset, plane: frame, error: undefined })
    } catch (error) { this.error(error) }
  }
  private previewCut(dialog: Cut, line?: ScreenPoint[]) {
    const revision = ++this.cutRevision
    const bounds = this.meshes[dialog.id]?.bounds
    if (!bounds) return
    this.patch({ dialog, preview: { kind: 'cut', body: dialog.id, frame: dialog.plane, bounds, line } })
    clearTimeout(this.cutTimer)
    this.cutTimer = setTimeout(() => {
      if (revision !== this.cutRevision) return
      this.cutQueued = dialog
      void this.renderCut()
    }, 180)
  }
  private async renderCut() {
    if (this.cutPending || !this.cutQueued) return
    const dialog = this.cutQueued
    this.cutQueued = undefined
    const current = this.snapshot.dialog
    if (current?.kind !== 'cut' || current.plane !== dialog.plane) return
    const revision = this.cutRevision
    const object = this.entities.find(o => o.id === dialog.id)
    if (object?.kind !== 'body') return
    this.cutPending = true
    try {
      const { preview } = await this.model.kernel.request({ op: 'split', body: object, plane: dialog.plane, preview: true })
      if (revision === this.cutRevision && this.snapshot.preview?.kind === 'cut') this.patch({ preview: { ...this.snapshot.preview, meshes: preview } })
    } catch (e) {
      if (revision === this.cutRevision) this.patch({ dialog: { ...dialog, error: e instanceof Error ? e.message : 'The cut misses the solid.' } })
    } finally { this.cutPending = false; void this.renderCut() }
  }
  private async finishCut(dialog: Cut) {
    if (!this.canEdit) return
    const object = this.entities.find(o => o.id === dialog.id)
    if (object?.kind !== 'body') return
    this.cutRevision++
    this.working = true
    let parts
    try {
      this.model.notice('Computing exact split')
      parts = (await this.model.kernel.request({ op: 'split', body: object, plane: dialog.plane })).parts
    } catch (error) { this.error(error) }
    finally { this.working = false }
    if (parts && await this.commit({ type: 'split', id: dialog.id, plane: dialog.plane, parts })) this.patch({ tool: 'select' })
  }
  private cutDrag(active: Extract<Active, { kind: 'cut' }>, point: ScreenPoint) {
    const start = active.points[0]
    const dialog = this.snapshot.dialog?.kind === 'cut' ? this.snapshot.dialog : active.initial
    if (dialog.choice !== 'view') {
      const normal = planeNormal(dialog.plane), pivot = midpoint(...this.meshes[dialog.id].bounds)
      const shift = this.stage?.axisDelta(start, point, pivot, normal) ?? 0
      this.setCut({ offset: active.initial.offset + shift })
      return
    }
    if (!this.stage || before(start, point) < .018) return
    const center = midpoint(...this.meshes[dialog.id].bounds), view = this.stage.direction()
    const frame = orientedFrame(center, view)
    const a = this.stage.world(start, frame), b = this.stage.world(point, frame)
    if (!a || !b || norm(sub(a, b)) < EPS) return
    this.previewCut({ ...dialog, error: undefined, plane: orientedFrame(midpoint(a, b), cross(sub(b, a), view)) }, [start, point])
  }

  private beginHole(object: Entity | undefined, pick = this.picked) {
    if (object?.kind !== 'body') { this.error(new Error('Select a solid and a planar face for the hole.')); return }
    const info = this.meshes[object.id]
    if (!info) return
    const face = pick?.id === object.id && pick.normal ? faceAt(info, pick.point, pick.normal) :
      [...info.faces].sort((a, b) => b.normal[2] - a.normal[2] || b.at[2] - a.at[2])[0]
    if (!face) { this.error(new Error('Choose a planar face for this operation.')); return }
    const at = pick?.id === object.id ? pick.point : face.at
    const hole: Hole = { kind: 'hole', id: object.id, at, face, mode: 'through', width: 10, height: 10, depth: 6 }
    this.dialog(hole, 'What diameter should the hole have?', true)
    this.previewHole(hole)
  }
  previewHole(dialog: Hole) {
    this.patch({ dialog, preview: { kind: 'hole', at: dialog.at, normal: dialog.face.normal, rectangular: dialog.mode === 'rectangular', width: dialog.width, height: dialog.height } })
  }

  private patternFace(id: string, requested: FeatureFace): FaceReference | undefined {
    const mesh = this.meshes[id]
    if (!mesh) return
    if (requested === 'pointed') {
      const hand = this.snapshot.hands.filter(h => h.pose === 'point')
      const hit = (hand.length === 1 ? this.stage?.pick(hand[0].cursor) : undefined) ?? this.facePicks.get(id)
      return hit?.id === id && hit.normal ? faceAt(mesh, hit.point, hit.normal) : undefined
    }
    const normal = faceDirections[requested]
    const faces = mesh.faces.filter(face => dot(normal, face.normal) > .985)
      .sort((a, b) => dot(normal, sub(b.at, a.at)))
    if (faces[1] && Math.abs(dot(normal, sub(faces[1].at, faces[0].at))) < EPS) return
    return faces[0]
  }

  private beginPattern(options: { face?: FeatureFace; diameter?: number; inset?: number } = {}) {
    const object = this.object
    if (object?.kind !== 'body' || object.hidden) { this.error(new Error('Select a visible solid for the hole pattern.')); return }
    this.cancel()
    const face = this.patternFace(object.id, options.face ?? 'pointed')
    const draft: HolePattern = { kind: 'holePattern', id: object.id, face, pattern: { diameter: options.diameter ?? 6, inset: options.inset ?? 10 }, phase: 'choosing' }
    this.previewFeature(draft)
    if (!face?.rectangle) this.actions.speak(this.snapshot.message)
  }

  choosePatternFace(face: FeatureFace) {
    const draft = this.snapshot.dialog
    if (draft?.kind !== 'holePattern') { this.beginPattern({ face }); return }
    const selected = this.patternFace(draft.id, face)
    this.previewFeature({ ...draft, face: selected })
    if (!selected?.rectangle) this.actions.speak(this.snapshot.message)
  }

  private beginChamfer(distance = 2, aim = this.snapshot.aimedEdge) {
    const current = this.snapshot.dialog
    if (current?.kind === 'chamfer') { this.previewFeature({ ...current, distance }); return }
    const object = this.entities.find(o => o.id === aim?.id)
    if (!aim || object?.kind !== 'body' || object.hidden || !this.meshes[object.id]?.edgeRanges.some(edge => edge.reference === aim.reference)) {
      this.error(new Error('Point at the middle of one exposed edge and keep pointing until the chamfer preview opens.'))
      return
    }
    this.model.select([object.id])
    this.previewFeature({ kind: 'chamfer', id: object.id, edge: aim, distance, phase: 'checking' })
  }

  changeFeature(key: 'holeDiameter' | 'holeInset' | 'chamferDistance', value: number) {
    const draft = this.snapshot.dialog
    if (draft?.kind === 'holePattern' && key !== 'chamferDistance') {
      this.previewFeature({ ...draft, pattern: { ...draft.pattern, [key === 'holeDiameter' ? 'diameter' : 'inset']: value } })
    } else if (draft?.kind === 'chamfer' && key === 'chamferDistance') {
      this.previewFeature({ ...draft, distance: value })
    }
  }

  private featureCommand(draft: FeatureDraft): FeatureCommand | undefined {
    if (draft.kind === 'chamfer') return { type: 'chamfer', id: draft.id, edge: draft.edge.reference, distance: draft.distance }
    if (draft.face?.rectangle) return { type: 'holePattern', id: draft.id, face: { at: draft.face.at, normal: draft.face.normal }, pattern: draft.pattern }
  }

  private previewFeature(draft: FeatureDraft) {
    const sequence = ++this.featureSequence
    clearTimeout(this.featureTimer)
    let preview: Preview | undefined
    try {
      if (draft.kind === 'holePattern') {
        const face = draft.face?.rectangle
        if (!face) {
          const message = draft.face ? 'This face isn’t rectangular. Click a rectangular face or say “use top face”.' :
            'Which face? Say “use top face”, point and say “use this face”, or click a rectangular face.'
          this.patch({ preview: undefined })
          this.dialog({ ...draft, phase: 'choosing', error: undefined }, message)
          return
        }
        preview = { kind: 'holePattern', face, points: [], diameter: draft.pattern.diameter }
        preview.points = cornerHoleCenters(face, draft.pattern)
      } else {
        preview = { kind: 'chamfer', edge: draft.edge }
        if (!Number.isFinite(draft.distance) || draft.distance <= EPS) throw new Error('Enter a chamfer distance greater than zero.')
      }
    } catch (error) {
      this.patch({ preview })
      this.dialog({ ...draft, phase: 'invalid', error: (error as Error).message }, 'Adjust the preview dimensions')
      return
    }
    const cmd = this.featureCommand(draft)
    const body = this.entities.find(o => o.id === draft.id)
    if (!cmd || body?.kind !== 'body') return
    this.featureSource = body
    this.patch({ preview })
    this.dialog({ ...draft, phase: 'checking', error: undefined }, 'Checking the feature preview')
    this.featureTimer = setTimeout(() => {
      void Promise.resolve().then(() => this.model.kernel.request({ op: 'render', bodies: [applyFeature(body, cmd)] })).then(({ results }) => {
        if (sequence !== this.featureSequence) return
        if (draft.kind === 'chamfer') this.patch({ preview: { kind: 'chamfer', edge: draft.edge, mesh: results[draft.id] } })
        this.dialog({ ...draft, phase: 'ready', error: undefined }, draft.kind === 'holePattern' ? 'Four holes previewed. Say “apply” to create them.' : 'Chamfer previewed. Say “apply” to cut the edge.')
      }).catch(error => {
        if (sequence === this.featureSequence) this.dialog({ ...draft, phase: 'invalid', error: (error as Error).message }, 'Check the feature preview')
      })
    }, 65)
  }

  private async finishFeature(draft: FeatureDraft) {
    if (draft.phase !== 'ready') {
      if (draft.phase === 'checking') this.actions.speak('The preview is still checking.')
      return
    }
    if (this.entities.find(o => o.id === draft.id) !== this.featureSource) {
      this.cancel()
      this.error(new Error('The target solid changed during the preview. Open the tool again.'))
      return
    }
    const command = this.featureCommand(draft)
    if (command && await this.commit(command)) this.patch({ tool: 'select', aimedEdge: undefined })
  }

  private boolean(operation: BooleanKind) {
    const [target, tool] = this.selectedIds
    if (!target || !tool || this.selectedIds.length !== 2 || !this.meshes[target] || !this.meshes[tool]) {
      this.error(new Error('Select two solids with Shift-click. The first selection is the target.')); return
    }
    this.dialog({ kind: 'boolean', operation, target, tool }, operationName[operation] + ' the selected solids?', true)
  }
  private attach() {
    const dialog = this.snapshot.dialog
    if (dialog?.kind === 'join') { void this.resolveJoin(dialog, 'attach'); return }
    const [parent, child] = this.selectedIds
    if (!parent || !child) { this.error(new Error('Select the parent, then Shift-click the object to attach.')); return }
    void this.commit({ type: 'attach', child, parent })
  }
  private async resolveJoin(dialog: Join, operation: 'attach' | 'fuse' | 'move') {
    if (operation === 'attach') await this.commit({ type: 'attach', child: dialog.target, parent: dialog.reference, position: dialog.position })
    else if (operation === 'fuse') await this.commit({ type: 'boolean', operation: 'union', target: dialog.target, tool: dialog.reference, position: dialog.position })
    else {
      const object = this.entities.find(o => o.id === dialog.target)
      if (object) await this.commit({ type: 'transform', ids: this.selectedIds, target: object.id, value: { ...object.transform, position: dialog.position }, label: 'Place' })
    }
  }
  join = (operation: 'attach' | 'fuse' | 'move') => {
    const dialog = this.snapshot.dialog
    if (dialog?.kind === 'join') void this.resolveJoin(dialog, operation)
  }

  async align(mode: AlignMode) {
    const pending = this.snapshot.dialog
    const [first, second] = this.selectedIds
    const paired = pending?.kind === 'join' || pending?.kind === 'align'
    const target = paired ? pending.target : second
    const reference = paired ? pending.reference : first
    if (!target || !reference || !this.meshes[target] || !this.meshes[reference]) {
      this.error(new Error('Select a reference solid, then Shift-click the solid to align.')); return
    }
    const moving = this.meshes[target], anchor = this.meshes[reference]
    const object = this.entities.find(o => o.id === target)!
    const refPick = this.facePicks.get(reference)
    const face = paired && pending.face ? pending.face : refPick?.normal ? faceAt(anchor, refPick.point, refPick.normal) : undefined
    const planar = ['center', 'face', 'flush'].includes(mode) ? face ??
      (mode === 'face' || mode === 'flush' ? [...anchor.faces].sort((a, b) => b.normal[2] - a.normal[2])[0] : undefined) : undefined
    const revision = ++this.alignmentRevision
    let support: number | undefined
    if (planar && object.kind === 'body') {
      try { support = (await this.model.kernel.request({ op: 'support', body: object, normal: planar.normal })).coordinate }
      catch (error) { this.error(error); return }
      if (revision !== this.alignmentRevision || this.entities.find(o => o.id === target) !== object) return
    }
    const offset = alignBounds(moving.bounds, anchor.bounds, mode, planar, support)
    const position = add(object.transform.position, offset)
    const choice = mode === 'center' && !planar && !paired && anchor.faces.length > 0
    const next: Alignment = { kind: 'align', target, reference, mode, position, face: planar, choice }
    const ids = [...descendants(this.entities, [target])]
    const snap: Snap = planar ? { kind: 'face', at: planar.at } : { kind: 'center', at: midpoint(...anchor.bounds) }
    this.patch({ preview: { kind: 'move', target, ids, from: object.transform, to: { ...object.transform, position }, snap } })
    this.dialog(next, choice ? 'Align centers or center on the top face?' : 'Confirm alignment?', true)
  }

  pointerStart(p: ScreenPoint, extrusionHandle = false, bypass = false) {
    if (!this.canEdit || this.active) return false
    const { tool, dialog } = this.snapshot
    if (extrusionHandle || dialog?.kind === 'extrude') {
      const draft = dialog?.kind === 'extrude' ? dialog : undefined
      if (!draft) return false
      this.active = { kind: 'extrude', dialog: draft, start: p, depth: draft.depth }
      this.actions.stopPrompt?.()
      this.patch({ message: 'Pull to set the depth.' })
      return true
    }
    if (dialog?.kind === 'cut') {
      this.active = { kind: 'cut', points: [p], initial: dialog }
      return true
    }
    if (dialog && !['dimension', 'hole'].includes(dialog.kind)) return false
    if (drawingTools.includes(tool) && tool !== 'polyline' && tool !== 'point') return this.startDraw(tool, p, tool === 'rectangle' ? this.pickLine(p) : undefined, bypass)
    if (tool === 'move') {
      const hit = this.stage?.pick(p)
      const object = this.entities.find(o => o.id === hit?.id)
      if (object) { this.beginMove(object, p); return true }
    }
    return false
  }
  pointerMove(p: ScreenPoint, time = performance.now(), bypass = false) {
    const active = this.active
    if (!active) { this.hover(p); return }
    switch (active.kind) {
      case 'draw': this.draw(active, p, undefined, bypass); break
      case 'move': this.move(active, p, time, bypass); break
      case 'extrude': {
        const object = this.entities.find(o => o.id === active.dialog.id)
        if (object?.kind !== 'sketch') return
        const delta = this.stage?.axisDelta(active.start, p, this.sketchCenter(object), transformedNormal(object.sketch.frame, object.transform)) ?? 0
        const depth = active.depth + delta / Math.max(EPS, norm(sub(
          transformPoint(planeNormal(object.sketch.frame), matrixOf(object.transform)), object.transform.position,
        )))
        this.previewExtrude({ ...active.dialog, depth })
        break
      }
      case 'cut': this.cutDrag(active, p); break
    }
  }
  pointerEnd() {
    const active = this.active
    this.active = undefined
    if (!active) return
    if (active.kind === 'draw') void this.finishDraw(active)
    if (active.kind === 'move') this.finishMove(active)
    if (active.kind === 'extrude' && this.snapshot.dialog?.kind === 'extrude') this.dialog(this.snapshot.dialog, depthQuestion, true)
  }
  click(p: ScreenPoint, multi: boolean, bypass = false) {
    if (!this.canEdit) return
    const { tool, dialog } = this.snapshot
    const hit = this.stage?.pick(p)
    if (dialog?.kind === 'holePattern') {
      if (hit?.id === dialog.id && hit.normal) this.previewFeature({ ...dialog, face: faceAt(this.meshes[hit.id], hit.point, hit.normal) })
      return
    }
    if (tool === 'chamfer' && !dialog) {
      const edge = this.stage?.edgeAt?.(p)
      if (edge) this.beginChamfer(2, edge)
      else this.error(new Error('Click near the middle of one exposed edge.'))
      return
    }
    if (tool === 'hole' || dialog?.kind === 'hole') {
      if (hit) {
        const solid = this.entities.find(o => o.id === hit.id)
        this.picked = hit
        this.model.select([hit.id])
        if (dialog?.kind === 'hole' && dialog.id === hit.id && hit.normal && this.meshes[hit.id]) {
          const face = faceAt(this.meshes[hit.id], hit.point, hit.normal)
          if (face) this.previewHole({ ...dialog, face, at: hit.point })
          else this.error(new Error('Choose a planar face.'))
        } else this.beginHole(solid, hit)
      }
      return
    }
    if (dialog && !['dimension'].includes(dialog.kind)) return
    if (tool === 'measure') {
      const at = hit?.point ?? this.world(p, this.frame, bypass)?.point
      if (at) {
        this.measured = [...(this.measured.length >= 2 ? [] : this.measured), at]
        this.patch({ preview: { kind: 'measure', points: this.measured }, message: this.measured.length === 2 ? 'Distance measured' : 'Pick the second point.' })
      }
      return
    }
    if (tool === 'point' || tool === 'polyline') {
      const point = this.localPoint(p, this.frame, undefined, bypass)?.point
      if (!point) return
      if (tool === 'point') { void this.commit({ type: 'sketch', sketch: { frame: this.frame, geometry: { kind: 'point', at: point } } }); return }
      const [first] = this.sketchPoints
      const last = this.sketchPoints.at(-1)
      const near = ([x, y]: Vec2) => Math.hypot(x - point[0], y - point[1]) < EPS
      if (last && near(last)) return
      if (first && this.sketchPoints.length >= 3 && near(first)) { this.polyline(true); return }
      this.sketchPoints = [...this.sketchPoints, point]
      this.patch({ mode: 'SketchEditing', polylineCount: this.sketchPoints.length, preview: {
        kind: 'sketch', sketch: { frame: this.frame, geometry: { kind: 'polyline', points: this.sketchPoints, closed: false } },
      } })
      return
    }
    if (hit) {
      this.picked = hit
      if (hit.normal) this.facePicks.set(hit.id, hit)
      this.select(hit.id, multi)
    } else if (!multi && ['select', 'move', 'rotate', 'scale'].includes(tool)) {
      this.model.select([])
      this.picked = undefined
      this.patch({ dialog: undefined, mode: 'Idle', message: '' })
    }
  }
  polyline(closed: boolean) {
    const points = this.sketchPoints
    if (points.length < (closed ? 3 : 2)) { this.error(new Error(closed ? 'A closed profile needs at least three points.' : 'A polyline needs at least two points.')); return }
    this.sketchPoints = []
    this.patch({ polylineCount: 0 })
    void this.commit({ type: 'sketch', sketch: { frame: this.frame, geometry: { kind: 'polyline', points, closed } } })
  }

  confirm = () => {
    const d = this.snapshot.dialog
    if (!d) {
      if (this.snapshot.tool === 'polyline' && this.sketchPoints.length) this.polyline(true)
      else this.actions.commandFocus()
      return
    }
    switch (d.kind) {
      case 'creation': void this.finishCreation(d); break
      case 'dimension': this.cancel(); break
      case 'extrude': void this.finishExtrude(d.id, d.depth); break
      case 'delete': void this.commit({ type: 'delete', ids: d.ids }); break
      case 'boolean': void this.commit({ type: 'boolean', operation: d.operation, target: d.target, tool: d.tool }); break
      case 'cut': void this.finishCut(d); break
      case 'holePattern': case 'chamfer': void this.finishFeature(d); break
      case 'align': {
        const object = this.entities.find(o => o.id === d.target)
        if (object) void this.commit({
          type: 'transform', ids: [d.target], target: d.target, value: { ...object.transform, position: d.position }, label: 'Align',
        })
        break
      }
      case 'hole': {
        const [lo, hi] = this.meshes[d.id].bounds
        const diagonal = norm(sub(hi, lo))
        void this.commit({ type: 'hole', id: d.id, at: d.at, normal: d.face.normal, mode: d.mode, width: d.width, height: d.height, depth: d.mode === 'blind' ? d.depth : diagonal + 2 })
        break
      }
      case 'join': this.patch({ message: 'Choose Attach, Fuse, or Place only.' }); break
      case 'voice': case 'confirm': this.cancel(); d.action(); break
    }
  }
  guarded(question: string, action: () => void) { this.dialog({ kind: 'confirm', question, action }, question, true) }

  get gestureContext(): Context {
    const { tool, dialog } = this.snapshot
    const editable = this.canEdit && !this.active
    const optical = editable && (!dialog || dialog.kind === 'dimension')
    const allow = ['select', 'line', 'rectangle', 'move', 'rotate', 'scale', 'cut', 'extrude'].includes(tool)
    return {
      allowLine: optical && ['select', 'line'].includes(tool),
      allowOrbit: optical && ['select', 'move', 'rotate', 'scale'].includes(tool),
      sign: (p, pose) => {
        if (!this.canEdit) return
        if (pose === 'thumbs-down' && (dialog || this.active || this.snapshot.preview)) return { sign: 'cancel' }
        if (pose === 'thumbs-up' && !this.active && dialog && ['creation', 'dimension', 'extrude', 'align'].includes(dialog.kind)) return { sign: 'confirm' }
        if (dialog || this.active || tool !== 'select') return
        if (pose === 'three') return { sign: 'fit' }
        if (pose === 'horns') return { sign: 'undo' }
        if (pose === 'shaka') return { sign: 'redo' }
        if (pose === 'point') {
          const hit = this.stage?.pick(p)
          if (hit) return { sign: 'select', target: hit.id }
        }
      },
      hit: (p: ScreenPoint, pose: Pose) => {
        if (!editable || !allow || !this.stage) return
        const selected = this.object
        if (pose === 'scissors' && (optical || dialog?.kind === 'cut') && selected?.kind === 'body' && ['select', 'cut'].includes(tool)) {
          return { mode: 'scissors', target: selected.id }
        }
        if (pose === 'pinch' && (optical || dialog?.kind === 'extrude') && selected?.kind === 'sketch') {
          if (this.pickLine(p) && ['rectangle', 'select', 'line'].includes(tool)) return { mode: 'rectangle', target: selected.id }
          if (closedSketch(selected.sketch.geometry)) {
            const center = this.sketchCenter(selected)
            const n = transformedNormal(selected.sketch.frame, selected.transform)
            const handle = this.stage.screen(add(center, mul(n, dialog?.kind === 'extrude' ? dialog.depth : 14)))
            if (before(handle, p) < .07) return { mode: 'extrude', target: selected.id }
          }
        }
        if (!optical) return
        const hit = this.stage.pick(p)
        if (!hit) return
        if (pose === 'fist' && this.meshes[hit.id] && ['select', 'move'].includes(tool)) return { mode: 'grab', target: hit.id }
        if (pose === 'pinch' && tool === 'select') return { mode: 'select', target: hit.id }
      },
    }
  }
  tracking(hands: TrackedHand[]) {
    const pointing = hands.filter(hand => hand.pose === 'point')
    const editable = this.canEdit && !this.active && !this.snapshot.dialog
    const edge = editable && ['select', 'chamfer'].includes(this.snapshot.tool) && pointing.length === 1 ? this.stage?.edgeAt?.(pointing[0].cursor) :
      editable && this.snapshot.tool === 'chamfer' ? this.pointerEdge : undefined
    const aimedEdge = edge?.reference === this.snapshot.aimedEdge?.reference ? this.snapshot.aimedEdge : edge
    this.patch({ hands, aimedEdge })
  }
  allowTracking(time: number) { return this.canEdit && time > this.mouseUntil && time > this.gestureBlockedUntil }
  handleGesture = (event: Event) => {
    if (event.type === 'sign') {
      switch (event.sign) {
        case 'confirm': this.confirm(); return
        case 'cancel': this.cancel(); this.model.notice('Canceled'); return
        case 'fit': this.stage?.view('fit'); this.model.notice('Fit all objects'); return
        case 'undo': case 'redo': this.cancel(); void this.model.step(event.sign); return
        case 'select': if (event.target) this.selectIds([event.target]); return
      }
    }
    if (event.type === 'freeze') {
      this.patch({ message: 'Tracking interrupted. Holding preview.', gesture: 'Tracking paused' })
      if (this.active?.kind === 'move') this.active.outside = undefined
      if (this.active?.kind === 'orbit') this.stage?.stopMotion?.()
      return
    }
    if (event.type === 'cancel') {
      if (this.active || this.snapshot.gesture) {
        this.cancel()
        this.patch({ message: event.reason })
      }
      return
    }
    const [p, q] = event.points
    const labels: Record<GestureMode, string> = { line: 'Two-hand pinch', rectangle: 'Rectangle pull', extrude: 'Extrusion pull', grab: 'Grab', orbit: 'Two-finger orbit', scissors: 'Scissors', select: 'Pinch to select' }
    if (event.type === 'start') {
      if (this.active) return
      this.stage?.stopMotion?.()
      const object = this.entities.find(o => o.id === event.target)
      this.patch({ gesture: labels[event.mode] })
      switch (event.mode) {
        case 'line': if (this.startDraw('line', p) && this.active) this.draw(this.active as Drawing, q, p); break
        case 'rectangle': if (object?.kind === 'sketch') this.startDraw('rectangle', p, object); break
        case 'extrude': {
          if (this.snapshot.dialog?.kind !== 'extrude') this.beginExtrude(object)
          if (this.snapshot.dialog?.kind === 'extrude') this.pointerStart(p, true)
          break
        }
        case 'grab': if (object) this.beginMove(object, p, true); break
        case 'orbit': this.active = { kind: 'orbit', previous: p }; this.patch({ mode: 'Orbiting', preview: { kind: 'orbit', at: p } }); break
        case 'scissors': {
          const dialog = this.snapshot.dialog?.kind === 'cut' ? this.snapshot.dialog :
            this.beginCut(object, orientedFrame(this.stage?.world(p, this.frame) ?? [0, 0, 0], this.stage?.direction() ?? AXES.Y))
          if (dialog) this.active = { kind: 'cut', initial: dialog, points: [p] }
          break
        }
        case 'select': if (object) this.active = { kind: 'select', id: object.id }; break
      }
      return
    }
    const active = this.active
    if (!active) return
    if (event.type === 'update') {
      if (this.snapshot.gesture === 'Tracking paused') this.patch({ gesture: labels[event.mode], message: '' })
      if (event.mode === 'line' && active.kind === 'draw') this.draw(active, q, p)
      else if (active.kind === 'orbit') {
        this.stage?.orbit((p[0] - active.previous[0]) * 6, (p[1] - active.previous[1]) * 4)
        active.previous = p
        this.patch({ preview: { kind: 'orbit', at: p } })
      } else this.pointerMove(p, event.time)
      return
    }
    this.patch({ gesture: undefined })
    if (active.kind === 'cut') {
      this.active = undefined
      if (this.snapshot.dialog?.kind === 'cut') void this.finishCut(this.snapshot.dialog)
    } else if (active.kind === 'select') {
      this.active = undefined
      this.select(active.id)
    } else if (active.kind === 'orbit') {
      this.stage?.stopMotion?.()
      this.active = undefined
      this.patch({ preview: undefined, mode: this.baseMode })
    } else this.pointerEnd()
  }

  command(text: string, source: 'text' | 'voice' = 'text', confidence = 1) {
    const intent = parseIntent(text)
    if (!intent) {
      const dialog = this.snapshot.dialog
      if (dialog?.kind === 'creation') {
        const values = dimensionList(text)
        if (values && this.canEdit) {
          const fields = sizeFields(shapeOf(dialog.command)).map(field => field.key)
          const keys = values.length === fields.length ? fields : dialog.missing
          if (values.length <= keys.length) this.creationAnswer(dialog, values.map((value, i) => ({ key: keys[i], value })))
          else this.patch({ dialog: { ...dialog, error: 'Give one value for each requested size.' } })
          return true
        }
      }
      if (source === 'text' && (dialog?.kind === 'creation' || dialog?.kind === 'dimension' || dialog?.kind === 'extrude')) {
        this.patch({ dialog: { ...dialog, error: 'Enter a number with an optional unit, such as “25 mm”.' } })
        return false
      }
      if (source === 'text') this.error(new Error('Try “create a cube”, “top view”, or “what can I say?”.'))
      return false
    }
    if (!this.canEdit && !['mute', 'help', 'panel', 'cancel'].includes(intent.kind)) {
      if (this.model.get().ready) this.model.notice('The workspace is updating. Try again when it is ready.')
      return true
    }
    if (source === 'voice' && !this.snapshot.dialog && (intent.kind === 'confirm' || (/^no[.!]?$/i.test(text.trim()) && !this.active))) return false
    const action = intent.kind === 'namedAction' ? intent.action.kind : intent.kind
    const destructive = ['delete', 'fuse', 'subtract', 'intersect', 'cut', 'hole', 'new', 'confirm', 'attach', 'both'].includes(action)
    if (source === 'voice' && destructive && confidence < .63) {
      this.error(new Error('Speech was unclear. Repeat the command or use the confirmation buttons.'))
      return true
    }
    try {
      if (source === 'voice' && this.settings.confirmVoice && intent.kind === 'fuse' && this.snapshot.dialog?.kind === 'join') {
        const join = this.snapshot.dialog
        this.dialog({ kind: 'voice', question: 'Confirm fuse?', action: () => { void this.resolveJoin(join, 'fuse') } }, 'Confirm fuse?', true)
        return true
      }
      this.runIntent(intent)
    } catch (error) {
      this.error(error)
      if (source === 'voice' && error instanceof Error) this.actions.speak(error.message)
    }
    return true
  }

  private namedObject(name: string) {
    const key = objectNameKey(name)
    if (['it', 'that', 'this', 'selected', 'current', 'selected object', 'selected part', 'selected body', 'current part'].includes(key) && this.object) {
      return this.object
    }
    const visible = this.entities.filter(object => !object.hidden)
    if (['first', 'first object', 'first part', 'last', 'last object', 'last part'].includes(key) && visible.length) {
      return key.startsWith('first') ? visible[0] : visible.at(-1)!
    }
    if (!key) throw new Error('Say the name of the object to select.')
    const exact = this.entities.filter(object => objectNameKey(object.name) === key)
    const matches = exact.length ? exact : this.entities.filter(object => {
      const words = objectNameKey(object.name).split(' ')
      return key.split(' ').every(word => words.includes(word))
    })
    if (matches.length !== 1) {
      if (matches.length) throw new Error('“' + name + '” matches ' + matches.slice(0, 3).map(o => o.name).join(', ') + '. Say the full name.')
      throw new Error('I couldn’t find “' + name + '”. Say “list objects” to hear the names.')
    }
    return matches[0]
  }

  private selectNames(names: string[], add: boolean) {
    const objects = names.map(name => this.namedObject(name))
    this.selectIds([...new Set([...(add ? this.selectedIds : []), ...objects.map(o => o.id)])])
  }

  private selectIds(ids: string[]) {
    this.cancel()
    this.model.select(ids)
    this.patch({ mode: this.baseMode, tool: 'select', message: '' })
    this.model.notice(ids.length > 1 ? ids.length + ' objects selected' : this.object ? 'Selected ' + this.object.name : 'Selection cleared')
  }

  private parameter(object: Entity, key: string) {
    const groups = parameters(object)
    const candidates = ['holeDiameter', 'holeInset', 'chamferDistance'].includes(key) ? groups.flatMap(group => group.values) : groups[0]?.values ?? []
    const actual = object.kind === 'body' && object.recipe.kind === 'extrude' && key === 'height' ? 'depth' : key
    const exact = candidates.find(p => p.key === actual)
    if (exact) return exact
    const alternate = actual === 'radius' ? 'diameter' : actual === 'innerRadius' ? 'innerDiameter' :
      actual === 'width' ? 'diameter' : ['height', 'length', 'width'].includes(actual) ? 'size' : ''
    const value = candidates.find(p => p.key === alternate) ??
      (actual === 'width' ? candidates.find(p => p.key === 'size') : undefined)
    if (!value) return undefined
    return actual.toLowerCase().endsWith('radius') ? { ...value, key: actual, value: value.value / 2, label: actual === 'radius' ? 'Radius' : 'Inner radius' } : value
  }

  private async setDimension(object: Entity, key: string, value: number, mode?: 'set' | 'add' | 'multiply') {
    const parameter = this.parameter(object, key)
    if (mode && mode !== 'set' && !parameter) {
      this.error(new Error('Select a part with an editable ' + key + '.'))
      return
    }
    const next = mode === 'add' ? Math.abs(parameter!.value) + value : mode === 'multiply' ? Math.abs(parameter!.value) * value : value
    const signed = mode && parameter?.key === 'depth' && parameter.value < 0 && mode !== 'set' ? -next : next
    const chosen = parameter?.key ?? key
    if (await this.commit({ type: 'parameter', id: object.id, key: chosen, value: signed, path: parameter?.path })) {
      this.lastDimension = { id: object.id, key: chosen, time: performance.now() }
    }
  }

  private describe(subject: string) {
    const dialog = this.snapshot.dialog
    if (dialog?.kind === 'creation') {
      const target = sizeTarget(shapeOf(dialog.command), subject)
      if (target) {
        this.actions.speak('The current ' + subject + ' is ' + formatDimension(target.field.value / target.factor, this.units, this.settings.precision) + '.')
        return
      }
    }
    const object = this.object
    let summary: string
    if (subject === 'selection') {
      summary = this.selectedIds.length > 1 ? this.selectedIds.map(id => this.entities.find(o => o.id === id)?.name).filter(Boolean).join(', ') + ' selected.' :
        object ? object.name + ' is selected. It is a ' + entityType(object) + '.' : 'Select an object by name, or say “list objects”.'
    } else if (subject === 'objects') {
      const names = this.entities.filter(o => !o.hidden).map(o => o.name)
      summary = names.length ? names.slice(0, 7).join(', ') + (names.length > 7 ? ', and ' + (names.length - 7) + ' more.' : '.') : 'This project has no visible objects.'
    } else if (!object) {
      summary = 'Select an object to inspect its dimensions.'
    } else {
      const parameter = this.parameter(object, subject)
      const mesh = this.meshes[object.id]
      if (parameter) {
        summary = object.name + ' ' + parameter.label.toLowerCase() + ' is ' + (parameter.unit === 'angle' ? parameter.value + ' degrees' : formatDimension(Math.abs(parameter.value), this.units, this.settings.precision)) + '.'
      } else if (mesh && subject === 'volume') {
        summary = object.name + ' volume is ' + (mesh.volume / UNIT_FACTORS[this.units] ** 3).toFixed(this.settings.precision) + ' cubic ' + this.units + '.'
      } else if (mesh && ['width', 'length', 'height'].includes(subject)) {
        const index = ['width', 'length', 'height'].indexOf(subject)
        summary = object.name + ' measures ' + formatDimension(mesh.bounds[1][index] - mesh.bounds[0][index], this.units, this.settings.precision) + ' along ' + 'XYZ'[index] + '.'
      } else summary = object.name + ' has no ' + subject + ' dimension.'
    }
    this.model.notice(summary)
    this.patch({ message: summary })
    this.actions.speak(summary)
  }

  private runIntent(intent: Intent) {
    const object = this.object
    const dialog = this.snapshot.dialog
    switch (intent.kind) {
      case 'dimension': {
        if (dialog?.kind === 'creation') { this.creationAnswer(dialog, [{ key: dialog.missing[0], value: intent.value }]); return }
        if (dialog?.kind === 'dimension') { void this.drawnAnswer(dialog, dialog.key, intent.value); return }
        if (this.active?.kind === 'draw' && this.snapshot.preview?.kind === 'sketch') {
          checkSize(intent.value)
          this.active.exact = intent.value
          const preview = this.snapshot.preview
          this.patch({ preview: { ...preview, snap: undefined, sketch: { ...preview.sketch, geometry: preciseSketchDimension(preview.sketch.geometry, intent.value) } }, message: '' })
          return
        }
        if (dialog?.kind === 'extrude') { void this.finishExtrude(dialog.id, intent.value); return }
        if (dialog?.kind === 'cut') { this.setCut({ offset: intent.value }); return }
        if (dialog?.kind === 'hole') { this.previewHole({ ...dialog, width: intent.value }); return }
        if (dialog?.kind === 'holePattern') { this.changeFeature('holeDiameter', intent.value); return }
        if (dialog?.kind === 'chamfer') { this.changeFeature('chamferDistance', intent.value); return }
        if (object && this.lastDimension?.id === object.id && performance.now() - this.lastDimension.time < 90_000) {
          void this.setDimension(object, this.lastDimension.key, intent.value)
          return
        }
        const g = object?.kind === 'sketch' ? object.sketch.geometry.kind : undefined
        if (object && g && ['line', 'rectangle', 'circle', 'arc'].includes(g)) {
          void this.commit({ type: 'parameter', id: object.id, key: g === 'line' ? 'length' : g === 'rectangle' ? 'height' : 'radius', value: intent.value })
          return
        }
        if (this.snapshot.tool === 'rotate' || this.snapshot.tool === 'scale') {
          const number = quantity(intent.raw, this.snapshot.tool === 'rotate' ? 'angle' : 'scalar') ?? intent.value
          this.runIntent(this.snapshot.tool === 'rotate' ? { kind: 'rotate', degrees: number } : { kind: 'scale', factor: number })
          return
        }
        throw new Error('Choose a specific dimension, such as “set diameter to 40”.')
      }
      case 'parameter': {
        if (dialog?.kind === 'creation') { this.creationAnswer(dialog, [intent]); return }
        if (dialog?.kind === 'dimension') { void this.drawnAnswer(dialog, intent.key, intent.value, intent.adjustment); return }
        const adjust = (current: number, input = intent.value) => intent.adjustment === 'add' ? current + input :
          intent.adjustment === 'multiply' ? current * input : input
        if (dialog?.kind === 'holePattern' && ['diameter', 'radius'].includes(intent.key)) {
          this.changeFeature('holeDiameter', adjust(dialog.pattern.diameter, intent.key === 'radius' && intent.adjustment !== 'multiply' ? intent.value * 2 : intent.value))
          return
        }
        if (dialog?.kind === 'extrude' && ['depth', 'height'].includes(intent.key)) { void this.finishExtrude(dialog.id, adjust(dialog.depth)); return }
        if (dialog?.kind === 'hole') {
          if (['diameter', 'radius', 'width'].includes(intent.key)) {
            this.previewHole({ ...dialog, width: adjust(dialog.width, intent.key === 'radius' && intent.adjustment !== 'multiply' ? intent.value * 2 : intent.value) }); return
          }
          if (intent.key === 'height' || intent.key === 'depth') { this.previewHole({ ...dialog, [intent.key]: adjust(dialog[intent.key]) }); return }
        }
        if (!object) throw new Error('Select an object to set its dimensions.')
        void this.setDimension(object, intent.key, intent.value, intent.adjustment)
        return
      }
      case 'primitive': {
        const initial = defaultPrimitive(intent.shape)
        const primitive = primitiveFromIntent(intent, initial)
        const keys = Object.keys(intent.dimensions).map(key => sizeTarget(initial, key)?.field.key ?? key)
        this.beginCreation({ type: 'create', primitive, color: intent.color, at: this.creationPoint() }, keys)
        return
      }
      case 'line': {
        const direction = this.snapshot.axis && AXES[this.snapshot.axis]
        if (direction && Math.abs(dot(direction, planeNormal(this.frame))) > .9) throw new Error('Choose an axis in the construction plane.')
        const angle = direction ? Math.atan2(dot(direction, this.frame.v), dot(direction, this.frame.u)) / DEG : 0
        this.beginCreation({ type: 'sketch', sketch: { frame: this.frame, geometry: { kind: 'line', at: [0, 0], angle, length: intent.length ?? 50 } } },
          intent.length === undefined ? [] : ['length'])
        return
      }
      case 'rectangle': {
        const [specifiedWidth, specifiedHeight] = intent.dimensions ?? []
        const line = object?.kind === 'sketch' && object.sketch.geometry.kind === 'line' ? object.sketch.geometry : undefined
        const frame = line && object?.kind === 'sketch' ? object.sketch.frame : this.frame
        const width = specifiedWidth ?? line?.length ?? 60, height = specifiedHeight ?? 40
        const supplied = [specifiedWidth !== undefined || line ? 'width' : '', specifiedHeight !== undefined ? 'height' : '']
        this.beginCreation({ type: 'sketch', sketch: { frame, geometry: { kind: 'rectangle', at: line?.at ?? [-width / 2, -height / 2], angle: line?.angle ?? 0, width, height } }, source: line ? object?.id : undefined }, supplied)
        return
      }
      case 'circle':
        this.beginCreation({ type: 'sketch', sketch: { frame: this.frame, geometry: { kind: 'circle', at: [0, 0], radius: intent.radius ?? 20 } } }, intent.radius === undefined ? [] : ['radius'])
        return
      case 'holePattern': this.beginPattern(intent); return
      case 'patternFace': this.choosePatternFace(intent.face); return
      case 'chamfer': this.beginChamfer(intent.distance); return
      case 'featureDimension':
        if (dialog?.kind === 'holePattern' || dialog?.kind === 'chamfer') this.changeFeature(intent.key, intent.value)
        else if (dialog?.kind === 'hole' && intent.key === 'holeDiameter') this.previewHole({ ...dialog, width: intent.value })
        else if (object && this.parameter(object, intent.key)) void this.setDimension(object, intent.key, intent.value)
        else throw new Error('Select an object with that feature to edit it.')
        return
      case 'extrude':
        if (intent.depth !== undefined && object) void this.finishExtrude(object.id, intent.depth)
        else this.setTool('extrude')
        return
      case 'move': case 'rotate': case 'scale': {
        if (!object) throw new Error('Select an object to transform.')
        const transform = { ...object.transform }
        if (intent.kind === 'move') transform.position = intent.absolute ? intent.delta : add(transform.position, intent.delta)
        if (intent.kind === 'rotate') {
          transform.rotation = [...transform.rotation]
          transform.rotation[axisIndex(intent.axis ?? this.snapshot.axis ?? 'Z')] += intent.degrees
        }
        if (intent.kind === 'scale') transform.scale = mul(transform.scale, intent.factor)
        this.transform(this.selectedIds, object.id, transform, intent.kind[0].toUpperCase() + intent.kind.slice(1))
        return
      }
      case 'constraint': this.setAxis(intent.axis); return
      case 'plane': this.setPlane(intent.plane); return
      case 'align': void this.align(intent.mode); return
      case 'view': this.stage?.view(intent.view); return
      case 'zoom': this.stage?.zoom(intent.direction); return
      case 'export': this.actions.export(intent.format); return
      case 'units': void this.commit({ type: 'project', units: intent.units }, false); return
      case 'tool': this.setTool(intent.tool); return
      case 'selectObjects': this.selectNames(intent.names, !!intent.add); return
      case 'allObjects': this.selectIds(this.entities.filter(o => !o.hidden && (!intent.scope || o.kind === intent.scope)).map(o => o.id)); return
      case 'clearSelection': this.clear(); this.model.notice('Selection cleared'); return
      case 'namedAction': this.selectIds([this.namedObject(intent.name).id]); this.runIntent(intent.action); return
      case 'rename':
        if (!object) throw new Error('Select an object to rename.')
        void this.commit({ type: 'appearance', id: object.id, name: intent.name }); return
      case 'visibility': {
        const target = intent.name ? this.namedObject(intent.name) : object
        if (!target) throw new Error('Select or name the object to show or hide.')
        void this.commit({ type: 'appearance', id: target.id, hidden: intent.hidden }); return
      }
      case 'changeColor':
        if (!object) throw new Error('Select an object to change its color.')
        void this.commit({ type: 'appearance', id: object.id, color: intent.color }); return
      case 'panel': this.actions.panel?.(intent.panel, intent.show); return
      case 'help': this.actions.help?.(); return
      case 'mute': this.actions.mute?.(); return
      case 'describe': this.describe(intent.subject); return
      case 'undo': case 'redo': this.cancel(); void this.model.step(intent.kind); return
      case 'delete': this.delete(); return
      case 'duplicate': this.duplicate(); return
      case 'cancel': this.cancel(); return
      case 'confirm': this.confirm(); return
      case 'save': void this.model.save(); return
      case 'saveAs': this.actions.saveAs(); return
      case 'open': this.actions.open(); return
      case 'new': this.actions.fresh(); return
      case 'fuse': if (dialog?.kind === 'join') this.join('fuse'); else this.boolean('union'); return
      case 'attach': this.attach(); return
      case 'detach': if (object) void this.commit({ type: 'attach', child: object.id }); return
      case 'subtract': case 'intersect': this.boolean(intent.kind); return
      case 'cut': this.setTool('cut'); return
      case 'hole': this.setTool('hole'); return
      case 'snap': this.actions.snap(); return
      case 'both': if (dialog?.kind === 'cut') this.confirm(); return
    }
  }
}

function preciseSketchDimension(geometry: Geometry, value: number): Geometry {
  switch (geometry.kind) {
    case 'line': return { ...geometry, length: value }
    case 'rectangle': return { ...geometry, height: value * (Math.sign(geometry.height) || 1) }
    case 'circle': case 'arc': return { ...geometry, radius: value }
    case 'ellipse': return { ...geometry, radiusX: value }
    default: return geometry
  }
}
