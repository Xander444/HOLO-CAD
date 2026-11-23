import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Box, Camera, Crosshair, Focus, Grid3X3, Minus, Move3D, Plus, Scan, Square, TriangleAlert } from 'lucide-react'
import { CadScene } from '../viewport/scene'
import { Overlays, orientationProjection } from '../viewport/overlays'
import { IconButton, Menu, MenuItem } from './ui'
import type { WorkspaceModel } from '../app/model'
import type { InteractionController } from '../interactions/controller'
import type { InteractionState } from '../interactions/types'
import type { Settings } from '../interactions/settings'
import { pixelDistance } from '../interactions/snap'
import type { ScreenPoint } from '../vision/tracking'
import type { Axis, Entity, PlaneName, Vec3 } from '../models/project'
import { add, closedSketch, mul, sketchPath } from '../models/math'
import { matrixOf, transformPoint, transformedNormal } from '../models/transforms'
import type { ViewName } from '../voice/parser'

const views: [ViewName, string][] = [['isometric', 'Isometric'], ['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom'], ['fit', 'Fit all'], ['reset', 'Reset view']]
const axes: { label: Axis; direction: Vec3; view: ViewName }[] = [{ label: 'X', direction: [1, 0, 0], view: 'right' }, { label: 'Y', direction: [0, 1, 0], view: 'back' }, { label: 'Z', direction: [0, 0, 1], view: 'top' }]
type Drag = { id: number; start: ScreenPoint; button: number; handled: boolean; moved: boolean }

export function Viewport({ model, controller, interaction, settings, showAdvanced, children }: {
  model: ReturnType<WorkspaceModel['get']>; controller: InteractionController; interaction: InteractionState; settings: Settings; showAdvanced: boolean; children?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<CadScene | null>(null)
  const drag = useRef<Drag | undefined>(undefined)
  const dragFrame = useRef<number | undefined>(undefined)
  const pendingDrag = useRef<{ point: ScreenPoint; bypass: boolean } | undefined>(undefined)
  const rightDrag = useRef(false)
  const [cameraError, setCameraError] = useState<string>()
  const [version, redraw] = useState(0)
  const [grid, setGrid] = useState(true)
  const [ortho, setOrtho] = useState(false)
  const [context, setContext] = useState<ScreenPoint>()
  const [mounted, setMounted] = useState(false)
  const current = model.project.objects.find(o => o.id === model.selection.at(-1))

  useEffect(() => {
    if (!host.current) return
    let scene: CadScene | undefined
    try {
      scene = new CadScene(host.current, {
        camera: () => redraw(v => v + 1), context: setCameraError,
        gizmoStart: () => { controller.mouse(true); drag.current = undefined },
        gizmoEnd: (ids, id, transform, label) => { controller.mouse(false); controller.transform(ids, id, transform, label) },
      })
      instance.current = scene
      controller.stage = scene
      setMounted(true)
    } catch (e) {
      setCameraError(e instanceof Error ? e.message : 'WebGL could not be started.')
    }
    return () => {
      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current)
      dragFrame.current = undefined
      pendingDrag.current = undefined
      scene?.close(); instance.current = null; controller.stage = undefined
    }
  }, [controller])

  const { objects } = model.project
  const { preview, axis, plane, tool, hover, aimedEdge, dialog, mode } = interaction
  const gripping = mode === 'Grabbing'
  useEffect(() => {
    instance.current?.update({
      objects, meshes: model.meshes, selection: model.selection, hover, aimedEdge, tool, plane, axis, grid,
      snap: settings.snap && settings.snapTypes.grid ? settings.grid : undefined, preview, busy: model.busy, gripping,
      reducedMotion: settings.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches,
    })
  }, [objects, model.meshes, model.selection, model.busy, hover, aimedEdge, tool, plane, axis, grid, settings.snap, settings.snapTypes.grid, settings.grid, settings.reducedMotion, preview, gripping, mounted])

  const previousProject = useRef('')
  useEffect(() => {
    if (previousProject.current && previousProject.current !== model.project.id) instance.current?.view('reset')
    previousProject.current = model.project.id
  }, [model.project.id])

  const point = (event: { clientX: number; clientY: number }): ScreenPoint => {
    const rect = host.current!.getBoundingClientRect()
    return [(event.clientX - rect.x) / rect.width, (event.clientY - rect.y) / rect.height]
  }
  const startDrag = (event: ReactPointerEvent, handle = false) => {
    const scene = instance.current
    if (!scene || (!handle && !(event.target instanceof HTMLCanvasElement))) return
    scene.stopMotion()
    setContext(undefined)
    if (interaction.gesture) controller.cancel()
    const p = point(event)
    controller.mouse(true)
    const stageHandled = event.button === 0 && (handle || !scene.gizmoAxis) && controller.pointerStart(p, handle, event.altKey)
    drag.current = { id: event.pointerId, start: p, button: event.button, handled: stageHandled, moved: false }
    rightDrag.current = false
    if (stageHandled) {
      scene.enableOrbit(false)
      event.preventDefault()
      event.stopPropagation()
      const capture = event.target instanceof HTMLCanvasElement ? event.target : event.currentTarget
      capture.setPointerCapture(event.pointerId)
    }
  }
  const clearDragFrame = () => {
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current)
    dragFrame.current = undefined
    pendingDrag.current = undefined
  }
  const moveDrag = (event: ReactPointerEvent) => {
    const scene = instance.current
    if (!scene || !host.current) return
    const p = point(event)
    const run = drag.current
    if (run?.id === event.pointerId) {
      if (pixelDistance(p, run.start, scene.dimensions) > 4) run.moved = true
      if (run.button === 2 && run.moved) rightDrag.current = true
      if (run.handled && run.moved) {
        pendingDrag.current = { point: p, bypass: event.altKey }
        if (dragFrame.current === undefined) dragFrame.current = requestAnimationFrame(time => {
          dragFrame.current = undefined
          const last = pendingDrag.current
          pendingDrag.current = undefined
          if (last) controller.pointerMove(last.point, time, last.bypass)
        })
      }
    } else if (event.target instanceof HTMLCanvasElement) controller.hover(p)
  }
  const endDrag = (event: ReactPointerEvent) => {
    const run = drag.current
    const scene = instance.current
    if (!scene) return
    if (!run || run.id !== event.pointerId) return
    const p = point(event)
    const moved = run.moved || pixelDistance(p, run.start, scene.dimensions) > 4
    drag.current = undefined
    clearDragFrame()
    controller.mouse(false)
    if (run.handled) {
      if (moved) controller.pointerMove(p, performance.now(), event.altKey)
      controller.pointerEnd()
      scene.enableOrbit(true)
      return
    }
    if (!moved && run.button === 0 && !scene.gizmoDragging) controller.click(p, event.shiftKey || event.metaKey || event.ctrlKey, event.altKey)
  }
  const cancelDrag = () => {
    drag.current = undefined
    clearDragFrame()
    controller.mouse(false)
    controller.cancel()
    instance.current?.enableOrbit(true)
  }
  const scene = instance.current
  const label = views.find(([id]) => id === scene?.currentView)?.[1] ?? (scene ? 'Custom' : 'Isometric')
  const sketchHandle = (item?: Entity) => {
    if (!scene || item?.kind !== 'sketch' || item.hidden || !closedSketch(item.sketch.geometry)) return
    if (preview && preview.kind !== 'extrude' || dialog && !['dimension', 'extrude'].includes(dialog.kind)) return
    const path = sketchPath(item.sketch).map(p => transformPoint(p, matrixOf(item.transform)))
    const center = [0, 1, 2].map(i => (Math.max(...path.map(p => p[i])) + Math.min(...path.map(p => p[i]))) / 2) as Vec3
    const normal = transformedNormal(item.sketch.frame, item.transform)
    const p = scene.screen(add(center, mul(normal, dialog?.kind === 'extrude' ? dialog.depth : 14)))
    return <button type="button" className="extrude-handle" aria-label="Pull extrusion handle" title="Pull extrusion handle" style={{ left: p[0] * 100 + '%', top: p[1] * 100 + '%' }}
      onPointerDown={event => { if (dialog?.kind !== 'extrude') controller.setTool('extrude'); startDrag(event, true) }}
      onClick={() => { if (dialog?.kind !== 'extrude') controller.setTool('extrude') }}><Move3D size={16} /></button>
  }

  return <main className="viewport" aria-label="CAD viewport" data-camera-revision={version > 0 ? 'active' : undefined}
    onPointerDownCapture={e => { if (e.target instanceof HTMLCanvasElement) startDrag(e) }}
    onPointerMoveCapture={moveDrag} onPointerUpCapture={endDrag} onPointerCancel={cancelDrag}
    onPointerLeave={() => { if (!drag.current) controller.hover(undefined) }}
    onContextMenu={event => {
      if (!(event.target instanceof HTMLCanvasElement)) return
      event.preventDefault()
      if (rightDrag.current) return
      const p = point(event)
      if (scene?.pick(p) && !model.selection.includes(scene.pick(p)!.id)) controller.click(p, false)
      setContext(p)
    }}>
    <div className="canvas-host" ref={host} />
    <div className="viewport-hud">
      <div className="view-controls">
        <Menu label="View orientation" content={<><Box size={15} /><span>{label}</span></>}>{close =>
          views.map(([name, title]) => <MenuItem key={name} onClick={() => { scene?.view(name); close() }}>{title}</MenuItem>)}
        </Menu>
        <IconButton label={ortho ? 'Use perspective projection' : 'Use orthographic projection'} aria-pressed={ortho} onClick={() => { scene?.projection(!ortho); setOrtho(!ortho) }}>
          {ortho ? <Square size={16} /> : <Camera size={16} />}
        </IconButton>
        <IconButton label={grid ? 'Hide construction grid' : 'Show construction grid'} aria-pressed={grid} onClick={() => setGrid(!grid)} className={grid ? 'lit' : ''}><Grid3X3 size={16} /></IconButton>
      </div>
      {(showAdvanced || axis || plane !== 'XY') && <div className="view-controls plane-control">
        <Menu label="Construction plane" content={<><LayersGlyph /><span>{plane} plane</span></>}>{close =>
          (['XY', 'XZ', 'YZ'] as PlaneName[]).map(p => <MenuItem key={p} onClick={() => { controller.setPlane(p); close() }}>{p} plane</MenuItem>)}
        </Menu>
        <Menu label="Axis constraint" content={<><Crosshair size={15} /><span>{axis ?? 'Free axis'}</span></>}>{close =>
          [undefined, 'X', 'Y', 'Z'].map(a => <MenuItem key={a ?? 'free'} onClick={() => { controller.setAxis(a as Axis | undefined); close() }}>{a ? a + ' axis' : 'Free axis'}</MenuItem>)}
        </Menu>
      </div>}
    </div>
    {scene && <Overlays scene={scene} object={model.selection.length === 1 ? current : undefined} mesh={current ? model.meshes[current.id] : undefined}
      preview={preview} dialog={dialog} unit={model.project.units} precision={settings.precision} hands={interaction.hands} gesture={interaction.gesture} />}
    {!dialog && aimedEdge && <span className="edge-command-hint">{tool === 'chamfer' ? 'Click the highlighted edge' : 'Say “chamfer this by 2 mm”'}</span>}
    {sketchHandle(current)}
    {!model.ready && !cameraError && <div className="viewport-center"><span className="loading-mark" /><span>{model.error ? 'CAD initialization stopped' : 'Loading geometry kernel'}</span></div>}
    {cameraError && <div role="alert" className="viewport-center"><TriangleAlert size={24} /><span>3D graphics unavailable</span><small>{cameraError}</small></div>}
    {model.ready && !model.project.objects.length && !preview && !cameraError && <div className="viewport-center empty-view"><Box size={27} /><span>Start a model</span><small>Choose a primitive or draw a sketch.</small></div>}
    <div className="view-bottom">
      <div className="axis-and-tips">
        <div className="axis-widget" aria-label="Axis view shortcuts">
          {scene && <svg viewBox="0 0 64 64" aria-hidden="true">{axes.map(a => {
            const [x, y] = orientationProjection(scene, a.direction)
            return <line key={a.label} x1="32" y1="32" x2={32 + x} y2={32 + y} className={'axis-' + a.label} />
          })}<circle cx="32" cy="32" r="2" /></svg>}
          {scene && axes.map(a => {
            const [x, y] = orientationProjection(scene, a.direction)
            return <button type="button" key={a.label} className={'axis-' + a.label} style={{ left: 32 + x * 1.17, top: 32 + y * 1.17 }}
              title={a.view + ' view'} aria-label={a.view + ' axis view'} onClick={() => scene.view(a.view)}>{a.label}</button>
          })}
        </div>
        <div className="viewport-hints"><span>{ortho ? 'Orthographic' : 'Perspective'}</span><small>Drag to orbit · Right drag to pan</small></div>
      </div>
      <div className="view-controls zoom-controls">
        <IconButton label="Zoom out" onClick={() => scene?.zoom(-1)}><Minus size={16} /></IconButton>
        <IconButton label="Zoom in" onClick={() => scene?.zoom(1)}><Plus size={16} /></IconButton>
        <IconButton label="Fit all objects" onClick={() => scene?.view('fit')}><Focus size={16} /></IconButton>
      </div>
    </div>
    {context && <div className="popover context-menu" style={{ left: Math.min(.75, context[0]) * 100 + '%', top: Math.min(.68, context[1]) * 100 + '%' }}>
      {(['move', 'rotate', 'measure', 'hole'] as const).map(t => <MenuItem key={t} onClick={() => { setContext(undefined); controller.setTool(t) }}>{t[0].toUpperCase() + t.slice(1)}</MenuItem>)}
      <MenuItem onClick={() => { setContext(undefined); controller.duplicate() }}>Duplicate</MenuItem>
      <MenuItem onClick={() => { setContext(undefined); controller.delete() }}>Delete</MenuItem>
    </div>}
    {children}
  </main>
}
function LayersGlyph() { return <Scan size={15} /> }
