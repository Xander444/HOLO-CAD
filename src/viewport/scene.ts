import {
  AmbientLight, Box3, BufferGeometry, Color, DirectionalLight, DoubleSide, Float32BufferAttribute, Group,
  HemisphereLight, Line, LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  MOUSE, Object3D, OrthographicCamera, PerspectiveCamera, Plane, PlaneGeometry, Points, PointsMaterial, Raycaster,
  Scene, ShaderMaterial, ShapeUtils, SphereGeometry, Spherical, SRGBColorSpace, Uint32BufferAttribute,
  Vector2, Vector3, WebGLRenderer,
} from 'three'
import type { Material } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { BodyGeometry } from '../cad/kernel'
import type { RenderGeometry } from '../cad/protocol'
import { rectangleCorners } from '../models/features'
import { add, midpoint, mul, onPlane, orientedFrame, planeFrame, planeNormal, sketchPath, sub, toPlane } from '../models/math'
import type { Entity, Frame, PlaneName, Sketch, Transform, Vec3 } from '../models/project'
import { matrixOf, transformOf, transformPoint } from '../models/transforms'
import type { Pick, PickedEdge, Preview, StagePort, Tool } from '../interactions/types'
import type { ViewName } from '../voice/parser'
import type { ScreenPoint } from '../vision/tracking'

const vec = (p: Vec3) => new Vector3(...p)
const initialDirection = new Vector3(1.12, -1.56, 1.14).normalize()
const viewDirections: Partial<Record<ViewName, Vec3>> = {
  front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0],
  top: [0, -.0001, 1], bottom: [0, -.0001, -1],
}
const gridVertex = /* glsl */ `
  varying vec2 vGrid;
  void main() {
    vGrid = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
  }
`
const gridFragment = /* glsl */ `
  varying vec2 vGrid;
  float lines(float stepSize) {
    vec2 p = vGrid / stepSize;
    vec2 fw = max(fwidth(p), vec2(.0001));
    vec2 g = abs(fract(p - .5) - .5) / fw;
    return 1. - min(min(g.x,g.y), 1.);
  }
  void main() {
    float thick = lines(50.0);
    float small = lines(10.0) * .36;
    float fade = 1. - smoothstep(135., 420., length(vGrid));
    vec3 c = mix(vec3(.16,.29,.37),vec3(.22,.47,.54),thick);
    gl_FragColor = vec4(c, max(small,thick*.62) * fade);
  }
`

type Part = { entity: Entity; source?: BodyGeometry; group: Group; mesh?: Mesh<BufferGeometry, MeshStandardMaterial>; edges?: LineSegments<BufferGeometry, LineBasicMaterial> }
type SceneState = { objects: Entity[]; meshes: RenderGeometry; selection: string[]; hover?: string; aimedEdge?: PickedEdge; tool: Tool; plane: PlaneName; axis?: string; grid: boolean; snap?: number; preview?: Preview; busy: boolean; reducedMotion: boolean }
type Hooks = {
  camera: () => void; context: (message?: string) => void; gizmoStart: () => void;
  gizmoEnd: (ids: string[], id: string, transform: Transform, label: string) => void;
}

const lineGeometry = (points: Vec3[]) => new BufferGeometry().setFromPoints(points.map(vec))
function fillGeometry(data: BodyGeometry) {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(data.positions, 3))
  g.setAttribute('normal', new Float32BufferAttribute(data.normals, 3))
  g.setIndex(new Uint32BufferAttribute(data.indices, 1))
  return g
}
const edgeGeometry = (data: BodyGeometry) => new BufferGeometry().setAttribute('position', new Float32BufferAttribute(data.lines, 3))
function dispose(group: Object3D) {
  group.traverse(o => {
    if (o instanceof Mesh || o instanceof Line || o instanceof Points) {
      o.geometry.dispose()
      ;(Array.isArray(o.material) ? o.material : [o.material as Material]).forEach(m => m.dispose())
    }
  })
}
function positionOnFrame(object: Object3D, frame: Frame) {
  object.position.copy(vec(frame.origin))
  object.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(vec(frame.u), vec(frame.v), vec(planeNormal(frame))))
}

export class CadScene implements StagePort {
  private renderer: WebGLRenderer
  private scene = new Scene()
  private perspective = new PerspectiveCamera(39, 1, .1, 20000)
  private orthographic = new OrthographicCamera(-100, 100, 100, -100, .1, 20000)
  private camera: PerspectiveCamera | OrthographicCamera = this.perspective
  private grid: Mesh<PlaneGeometry, ShaderMaterial>
  private origin = new Group()
  private ornaments = new Group()
  private edgeGuide = new Group()
  private parts = new Map<string, Part>()
  private controls: OrbitControls
  private transform: TransformControls
  private proxy = new Object3D()
  private ray = new Raycaster()
  private size = new Vector2(1, 1)
  private observer: ResizeObserver
  private raf = 0
  private state?: SceneState
  private needsRender = true
  private lost = false
  private initialFit = false
  private preview?: Preview
  private gizmoObject?: string
  private worldOrigin = new Vector3()
  private orthoHalf = 90
  private repaint = () => { this.needsRender = true; this.hooks.camera() }

  constructor(private host: HTMLDivElement, private hooks: Hooks) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = SRGBColorSpace
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D CAD viewport')
    this.renderer.domElement.setAttribute('role', 'img')
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost)
    this.renderer.domElement.addEventListener('webglcontextrestored', this.contextRestored)
    host.appendChild(this.renderer.domElement)
    this.perspective.up.set(0, 0, 1)
    this.orthographic.up.set(0, 0, 1)
    this.camera.position.copy(initialDirection.clone().multiplyScalar(255).add(new Vector3(0, 0, 10)))
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, 10)
    this.controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }
    this.controls.enableDamping = true
    this.controls.dampingFactor = .15
    this.controls.minDistance = 1
    this.controls.maxDistance = 15500
    this.controls.minZoom = .007
    this.controls.maxZoom = 95
    this.controls.addEventListener('change', this.repaint)
    this.transform = new TransformControls(this.camera, this.renderer.domElement)
    this.transform.setSize(.72)
    this.transform.addEventListener('mouseDown', this.onGizmoStart)
    this.transform.addEventListener('objectChange', this.onGizmoChange)
    this.transform.addEventListener('mouseUp', this.onGizmoEnd)
    this.scene.add(this.transform.getHelper(), this.proxy, this.ornaments, this.edgeGuide, this.origin)
    this.scene.add(new AmbientLight(0xbde4ff, .78), new HemisphereLight(0x9dd6fb, 0x23364a, 1.2))
    const key = new DirectionalLight(0xcbefff, 2.35)
    key.position.set(-70, -110, 180)
    const fill = new DirectionalLight(0x71acc5, .82)
    fill.position.set(60, 85, 75)
    this.scene.add(key, fill)
    this.grid = new Mesh(new PlaneGeometry(2200, 2200), new ShaderMaterial({
      vertexShader: gridVertex, fragmentShader: gridFragment, side: DoubleSide, transparent: true, depthWrite: false,
    }))
    this.grid.renderOrder = -1
    this.scene.add(this.grid)
    const axes: [Vec3, number][] = [[[95, 0, 0], 0x9e4356], [[0, 95, 0], 0x3a977f], [[0, 0, 67], 0x416ca4]]
    for (const [p, color] of axes) {
      const axis = new Line(lineGeometry([mul(p, -.8), p]), new LineBasicMaterial({ color, transparent: true, opacity: .52 }))
      this.origin.add(axis)
    }
    const marker = new Mesh(new SphereGeometry(.85, 10, 6), new MeshBasicMaterial({ color: 0x73c8da }))
    this.origin.add(marker)
    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(host)
    this.resize()
    this.controls.update()
    this.animate()
  }

  private contextLost = (event: Event) => { event.preventDefault(); this.lost = true; this.hooks.context('The graphics context was interrupted. Reload if it doesn’t recover.') }
  private contextRestored = () => { this.lost = false; this.needsRender = true; this.hooks.context() }
  private resize = () => {
    const { clientWidth, clientHeight } = this.host
    if (!clientWidth || !clientHeight) return
    this.size.set(clientWidth, clientHeight)
    this.renderer.setPixelRatio(Math.min(1.8, window.devicePixelRatio || 1))
    this.renderer.setSize(clientWidth, clientHeight, false)
    this.perspective.aspect = this.size.x / this.size.y
    this.perspective.updateProjectionMatrix()
    this.updateOrtho()
    this.repaint()
  }
  private updateOrtho() {
    const aspect = this.size.x / this.size.y
    this.orthographic.left = -this.orthoHalf * aspect
    this.orthographic.right = this.orthoHalf * aspect
    this.orthographic.top = this.orthoHalf
    this.orthographic.bottom = -this.orthoHalf
    this.orthographic.updateProjectionMatrix()
  }
  private animate = () => {
    this.raf = requestAnimationFrame(this.animate)
    this.controls.update()
    if (!this.needsRender || this.lost) return
    this.needsRender = false
    this.renderer.render(this.scene, this.camera)
  }

  private makePart(entity: Entity, source?: BodyGeometry): Part {
    const group = new Group()
    group.userData.id = entity.id
    let mesh: Part['mesh']
    let edges: Part['edges']
    if (source) {
      mesh = new Mesh(fillGeometry(source), new MeshStandardMaterial({ color: entity.color, roughness: .67, metalness: .22, side: DoubleSide }))
      edges = new LineSegments(edgeGeometry(source), new LineBasicMaterial({ color: 0x83d7e8, transparent: true, opacity: .74 }))
      edges.renderOrder = 3
      group.add(mesh, edges)
    } else if (entity.kind === 'sketch') {
      const path = sketchPath(entity.sketch).map(p => transformPoint(p, matrixOf(entity.transform)))
      const object = path.length === 1 ?
        new Points(lineGeometry(path), new PointsMaterial({ color: entity.color, size: 7, sizeAttenuation: false })) :
        new Line(lineGeometry(path), new LineBasicMaterial({ color: entity.color, depthTest: false }))
      group.add(object)
    }
    this.scene.add(group)
    return { entity, source, group, mesh, edges }
  }

  update(state: SceneState) {
    const prev = this.state
    this.state = state
    this.controls.enableDamping = !state.reducedMotion
    const remaining = new Set(state.objects.map(o => o.id))
    for (const [id, part] of this.parts) if (!remaining.has(id)) {
      part.group.removeFromParent(); dispose(part.group); this.parts.delete(id)
    }
    for (const entity of state.objects) {
      const source = state.meshes[entity.id]
      let part = this.parts.get(entity.id)
      const rebuild = !part || source !== part.source ||
        (entity.kind === 'sketch' && (part.entity.kind !== 'sketch' || entity.sketch !== part.entity.sketch || entity.transform !== part.entity.transform || entity.color !== part.entity.color))
      if (rebuild) {
        if (part) { part.group.removeFromParent(); dispose(part.group) }
        part = this.makePart(entity, source)
        this.parts.set(entity.id, part)
      }
      if (part) {
        part.entity = entity
        this.style(part)
      }
    }
    this.grid.visible = this.origin.visible = state.grid
    if (state.plane !== prev?.plane) positionOnFrame(this.grid, planeFrame(state.plane))
    if (!this.initialFit && (Object.keys(state.meshes).length || state.objects.some(o => o.kind === 'sketch'))) {
      this.initialFit = true
      this.fit(true)
    }
    if (state.selection !== prev?.selection && state.selection.length && prev?.selection?.length) {
      const target = this.pivot(state.selection.at(-1)!)
      if (target && !this.transform.dragging) {
        const shift = target.clone().sub(this.controls.target).multiplyScalar(.6)
        this.controls.target.add(shift)
        this.camera.position.add(shift)
        this.controls.update()
      }
    }
    if (!this.transform.dragging) this.syncGizmo()
    if (this.preview !== state.preview) this.drawPreview(state.preview)
    if (state.aimedEdge !== prev?.aimedEdge || Boolean(state.preview) !== Boolean(prev?.preview)) {
      dispose(this.edgeGuide)
      this.edgeGuide.clear()
      if (!state.preview && state.aimedEdge) this.edgeGuide.add(this.highlightEdge(state.aimedEdge))
    }
    this.applyPreviewMove(this.transform.dragging ? undefined : state.preview)
    this.needsRender = true
  }

  private pivot(id: string) {
    const part = this.parts.get(id)
    if (!part?.group.visible) return
    if (part.source) return vec(midpoint(...part.source.bounds))
    const box = new Box3().setFromObject(part.group)
    if (!box.isEmpty()) return box.getCenter(new Vector3())
  }
  private style(part: Part) {
    const state = this.state!
    const active = state.selection.includes(part.entity.id), hovered = state.hover === part.entity.id
    const previewBody = state.preview?.kind === 'cut' && state.preview.meshes ? state.preview.body :
      state.preview?.kind === 'chamfer' && state.preview.mesh ? state.preview.edge.id : undefined
    part.group.visible = !part.entity.hidden && previewBody !== part.entity.id
    if (part.mesh && part.edges) {
      part.mesh.material.color.set(part.entity.color).multiplyScalar(active ? .82 : .48)
      part.mesh.material.emissive.set(active ? 0x193943 : 0x102331)
      part.mesh.material.emissiveIntensity = active ? .6 : .38
      part.edges.material.color.set(active ? 0x8bf3ff : hovered ? 0xaef4ff : 0x4ca4bb)
      part.edges.material.opacity = active ? .95 : hovered ? .95 : .62
    }
  }

  private syncGizmo() {
    const state = this.state!
    const id = state.selection.at(-1)
    const entity = id && this.parts.get(id)?.entity
    const mode = state.tool === 'move' ? 'translate' : state.tool === 'rotate' ? 'rotate' : state.tool === 'scale' ? 'scale' : undefined
    if (!entity || entity.hidden || !mode || state.busy || state.preview?.kind === 'move') {
      this.transform.detach(); this.gizmoObject = undefined; return
    }
    const matrix = matrixOf(entity.transform)
    matrix.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale)
    this.proxy.updateMatrixWorld(true)
    this.transform.setMode(mode)
    this.transform.setSpace(mode === 'scale' ? 'local' : 'world')
    this.transform.setTranslationSnap(state.snap ?? null)
    this.transform.setRotationSnap(state.snap ? Math.PI / 36 : null)
    this.transform.setScaleSnap(state.snap ? .05 : null)
    const { axis } = state
    this.transform.showX = !axis || axis === 'X'
    this.transform.showY = !axis || axis === 'Y'
    this.transform.showZ = !axis || axis === 'Z'
    this.transform.enabled = true
    this.transform.attach(this.proxy)
    this.gizmoObject = entity.id
  }
  get gizmoAxis() { return this.transform.axis }
  get gizmoDragging() { return this.transform.dragging }
  private onGizmoStart = () => { this.controls.enabled = false; this.hooks.gizmoStart() }
  private onGizmoChange = () => {
    const target = this.gizmoObject && this.parts.get(this.gizmoObject)
    if (!target || !this.state) return
    this.proxy.updateMatrix()
    this.applyDelta(this.affected(this.state.selection), this.proxy.matrix.clone().multiply(matrixOf(target.entity.transform).invert()))
    this.repaint()
  }
  private onGizmoEnd = () => {
    this.controls.enabled = true
    const id = this.gizmoObject, state = this.state
    if (!id || !state) return
    try { this.hooks.gizmoEnd(state.selection, id, transformOf(this.proxy.matrix), state.tool === 'move' ? 'Move' : state.tool === 'rotate' ? 'Rotate' : 'Scale') }
    catch (error) { this.hooks.context(error instanceof Error ? error.message : 'The transformation is invalid.') }
    this.applyPreviewMove(undefined)
    this.repaint()
  }
  private affected(ids: string[]) {
    const result = new Set(ids)
    let changed = true
    while (changed) {
      changed = false
      for (const { entity } of this.parts.values()) if (entity.parent && result.has(entity.parent) && !result.has(entity.id)) {
        result.add(entity.id); changed = true
      }
    }
    return result
  }
  private applyDelta(ids: Set<string>, matrix: Matrix4) {
    for (const [id, { group }] of this.parts) {
      group.matrixAutoUpdate = false
      group.matrix.copy(ids.has(id) ? matrix : new Matrix4())
      group.matrixWorldNeedsUpdate = true
    }
  }
  private applyPreviewMove(preview?: Preview) {
    if (this.transform.dragging) return
    if (preview?.kind === 'move') {
      this.applyDelta(new Set(preview.ids), matrixOf(preview.to).multiply(matrixOf(preview.from).invert()))
      for (const id of preview.ids) {
        const part = this.parts.get(id)
        if (part?.mesh && part.edges) {
          part.mesh.material.transparent = true
          part.mesh.material.opacity = preview.danger ? .31 : .62
          part.edges.material.color.set(preview.danger ? 0xff6a6c : preview.snap ? 0x6df4af : 0x78dcec)
        }
      }
    } else {
      this.applyDelta(new Set(), new Matrix4())
      for (const { mesh } of this.parts.values()) if (mesh) { mesh.material.transparent = false; mesh.material.opacity = 1 }
    }
  }

  private drawPreview(preview?: Preview) {
    this.preview = preview
    dispose(this.ornaments)
    this.ornaments.clear()
    if (!preview) return
    const line = (points: Vec3[], color = 0x79ecff, opacity = 1) => {
      const object = new Line(lineGeometry(points), new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }))
      object.renderOrder = 6
      this.ornaments.add(object)
    }
    const marker = (at: Vec3, color = 0x79ecff) => {
      const object = new Points(lineGeometry([at]), new PointsMaterial({ color, size: 8, sizeAttenuation: false, depthTest: false }))
      object.renderOrder = 7
      this.ornaments.add(object)
    }
    const surface = (vertices: Vec3[], indices: number[], color: number, opacity: number) => {
      const g = lineGeometry(vertices)
      g.setIndex(indices)
      g.computeVertexNormals()
      const m = new Mesh(g, new MeshBasicMaterial({ color, side: DoubleSide, transparent: true, opacity, depthWrite: false }))
      m.renderOrder = 2
      this.ornaments.add(m)
    }
    const path = (sketch: Sketch, transform?: Transform, tail = 0) => sketchPath(sketch).map(p => {
      const point = tail ? add(p, mul(planeNormal(sketch.frame), tail)) : p
      return transform ? transformPoint(point, matrixOf(transform)) : point
    })
    switch (preview.kind) {
      case 'sketch': {
        const points = path(preview.sketch, preview.transform)
        line(points)
        if (points.length) { marker(points[0]); if (points.length > 1) marker(points.at(-1)!) }
        break
      }
      case 'extrude': {
        const bottom = path(preview.sketch, preview.transform)
        const top = path(preview.sketch, preview.transform, preview.depth)
        const count = bottom.length - 1
        if (count < 3) break
        line(bottom, 0x5cc9e2, .5); line(top, 0x9afff7)
        const vertices = [...bottom.slice(0, -1), ...top.slice(0, -1)]
        const indices: number[] = []
        for (let i = 0; i < count; i++) {
          const j = (i + 1) % count
          indices.push(i, j, i + count, j, j + count, i + count)
          if (count < 12 || i % 14 === 0) line([bottom[i], top[i]], 0x59c9df, .52)
        }
        const local = sketchPath(preview.sketch).slice(0, -1).map(p => new Vector2(...toPlane(preview.sketch.frame, p)))
        for (const tri of ShapeUtils.triangulateShape(local, [])) indices.push(...tri.map(i => i + count))
        surface(vertices, indices, 0x60d8ed, .23)
        break
      }
      case 'cut': {
        const radius = vec(sub(preview.bounds[1], preview.bounds[0])).length() * .58
        const { frame } = preview
        const corners = [[-radius, -radius], [radius, -radius], [radius, radius], [-radius, radius]].map(p => onPlane(frame, p as [number, number]))
        surface(corners, [0, 1, 2, 0, 2, 3], 0xffbc69, .19)
        line([...corners, corners[0]], 0xf4b76c, .8)
        preview.meshes?.forEach((mesh, i) => {
          const color = i % 2 ? 0x8ee7ac : 0x6bdcf6
          const solid = new Mesh(fillGeometry(mesh), new MeshStandardMaterial({ color, metalness: .1, roughness: .8, transparent: true, opacity: .66 }))
          const edge = new LineSegments(edgeGeometry(mesh), new LineBasicMaterial({ color, transparent: true, opacity: .7 }))
          this.ornaments.add(solid, edge)
        })
        break
      }
      case 'measure':
        line(preview.points, 0xf8c47e); preview.points.forEach(p => marker(p, 0xf8c47e)); break
      case 'move': if (preview.snap) marker(preview.snap, 0x74f3a7); break
      case 'hole': {
        const frame = orientedFrame(add(preview.at, mul(preview.normal, .1)), preview.normal)
        const geometry = preview.rectangular ?
          { kind: 'rectangle' as const, width: preview.width, height: preview.height, at: [-preview.width / 2, -preview.height / 2] as [number, number], angle: 0 } :
          { kind: 'circle' as const, radius: preview.width / 2, at: [0, 0] as [number, number] }
        line(sketchPath({ frame, geometry }), 0xf8c47e)
        marker(frame.origin, 0xf8c47e)
        break
      }
      case 'holePattern': {
        const normal = planeNormal(preview.face.frame)
        const lift = mul(normal, .09)
        const corners = rectangleCorners(preview.face).map(p => add(p, lift))
        surface(corners, [0, 1, 2, 0, 2, 3], 0x8debc6, .19)
        line([...corners, corners[0]], 0x87f1ce, .9)
        for (const at of preview.points) {
          const frame = { ...preview.face.frame, origin: add(at, lift) }
          const ring = sketchPath({ frame, geometry: { kind: 'circle', at: [0, 0], radius: preview.diameter / 2 } })
          line(ring, 0xffd597)
          marker(frame.origin, 0xffd597)
        }
        break
      }
      case 'chamfer': {
        this.ornaments.add(this.highlightEdge(preview.edge))
        if (preview.mesh) {
          const color = 0x60bcbb
          this.ornaments.add(
            new Mesh(fillGeometry(preview.mesh), new MeshStandardMaterial({ color, roughness: .68, metalness: .18, side: DoubleSide })),
            new LineSegments(edgeGeometry(preview.mesh), new LineBasicMaterial({ color: 0x8ff7dc })),
          )
        }
        break
      }
    }
  }

  private highlightEdge(edge: PickedEdge) {
    const highlight = new LineSegments(lineGeometry(edge.segments), new LineBasicMaterial({ color: 0xffc77a, depthTest: false }))
    highlight.renderOrder = 8
    return highlight
  }

  private setRay(screen: ScreenPoint) {
    this.camera.updateMatrixWorld()
    this.ray.setFromCamera(new Vector2(screen[0] * 2 - 1, 1 - screen[1] * 2), this.camera)
  }
  pick = (p: ScreenPoint): Pick | undefined => {
    this.setRay(p)
    this.ray.params.Line = { threshold: this.worldPerPixel() * 5 }
    this.ray.params.Points = { threshold: this.worldPerPixel() * 8 }
    const pickable = [...this.parts.values()].filter(part => part.group.visible).flatMap(part => part.mesh ? [part.mesh] : part.group.children)
    for (const part of this.parts.values()) part.group.updateMatrixWorld()
    const hit = this.ray.intersectObjects(pickable, false)[0]
    if (!hit) return
    const id = hit.object.parent?.userData.id as string
    const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld).toArray()
    return { id, point: hit.point.toArray(), normal }
  }
  edgeAt = (p: ScreenPoint): PickedEdge | undefined => {
    this.setRay(p)
    const pixel = this.worldPerPixel()
    this.ray.params.Line = { threshold: pixel * 14 }
    const visible = [...this.parts.values()].filter(part => part.group.visible && part.edges && part.mesh && part.source)
    const byId = new Map(visible.map(part => [part.entity.id, part]))
    for (const part of visible) part.group.updateMatrixWorld()
    const hits = this.ray.intersectObjects(visible.map(part => part.edges!), false)
    const candidates = new Map<string, { edge: PickedEdge; at: Vector3; projected: ScreenPoint; score: number }>()
    for (const hit of hits) {
      const id = hit.object.parent?.userData.id as string
      const data = byId.get(id)?.source
      const index = hit.index
      if (!data || index === undefined) continue
      const range = data.edgeRanges.find(part => index >= part.start && index < part.start + part.count)
      if (!range) continue
      const projected = this.screen(hit.point.toArray())
      const score = Math.hypot((projected[0] - p[0]) * this.size.x, (projected[1] - p[1]) * this.size.y)
      const key = id + ':' + range.start
      if (score > 12 || (candidates.get(key)?.score ?? Infinity) <= score) continue
      const segments: Vec3[] = []
      for (let i = range.start; i < range.start + range.count; i++) {
        const start = i * 3
        segments.push([data.lines[start], data.lines[start + 1], data.lines[start + 2]])
      }
      candidates.set(key, { edge: { id, reference: range.reference, segments }, at: hit.point, projected, score })
    }
    const meshes = visible.map(part => part.mesh!)
    const ranked = [...candidates.values()].sort((a, b) => a.score - b.score)
    let best: typeof ranked[number] | undefined
    for (const candidate of ranked) {
      if (best && candidate.score - best.score > 2) return best.edge
      this.setRay(candidate.projected)
      const obstruction = this.ray.intersectObjects(meshes, false)[0]
      if (obstruction && obstruction.distance + pixel * 1.25 < candidate.at.distanceTo(this.ray.ray.origin)) continue
      if (best) return
      best = candidate
    }
    return best?.edge
  }
  world = (screen: ScreenPoint, frame: Frame): Vec3 | undefined => {
    this.setRay(screen)
    const normal = vec(planeNormal(frame))
    if (Math.abs(normal.dot(this.ray.ray.direction)) < .023) return
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, vec(frame.origin))
    return this.ray.ray.intersectPlane(plane, new Vector3())?.toArray()
  }
  screen = (p: Vec3): ScreenPoint => {
    this.camera.updateMatrixWorld()
    const point = vec(p).project(this.camera)
    return [(point.x + 1) / 2, (1 - point.y) / 2]
  }
  direction = (): Vec3 => this.camera.getWorldDirection(new Vector3()).toArray()
  private worldPerPixel() {
    return this.camera instanceof OrthographicCamera ? (this.camera.top - this.camera.bottom) / this.camera.zoom / this.size.y :
      2 * this.camera.position.distanceTo(this.controls.target) * Math.tan(this.perspective.fov * Math.PI / 360) / this.size.y
  }
  axisDelta = (start: ScreenPoint, end: ScreenPoint, origin: Vec3, direction: Vec3) => {
    const projectedA = this.screen(origin)
    const length = this.worldPerPixel() * 100
    const projectedB = this.screen(add(origin, mul(direction, length)))
    const x = (projectedB[0] - projectedA[0]) * this.size.x, y = (projectedB[1] - projectedA[1]) * this.size.y
    const dx = (end[0] - start[0]) * this.size.x, dy = (end[1] - start[1]) * this.size.y
    return x * x + y * y > 225 ? (dx * x + dy * y) / (x * x + y * y) * length : -dy * this.worldPerPixel()
  }
  orbit = (angle: number, polar: number) => {
    const current = this.camera.position.clone().sub(this.controls.target)
    const coords = new Spherical().setFromVector3(new Vector3(current.x, current.z, -current.y))
    coords.theta -= angle
    coords.phi += polar
    coords.makeSafe()
    const next = new Vector3().setFromSpherical(coords)
    this.camera.position.copy(this.controls.target).add(new Vector3(next.x, -next.z, next.y))
    this.controls.update()
  }
  private fit(initial = false) {
    const bounds = new Box3()
    for (const part of this.parts.values()) {
      if (!part.group.visible) continue
      if (part.source) bounds.expandByPoint(vec(part.source.bounds[0])).expandByPoint(vec(part.source.bounds[1]))
      else bounds.expandByObject(part.group)
    }
    const center = bounds.isEmpty() ? this.worldOrigin.clone() : bounds.getCenter(new Vector3())
    const dimension = bounds.isEmpty() ? 115 : Math.max(10, bounds.getSize(new Vector3()).length())
    if (initial) center.z *= .66
    const aspect = Math.min(1.25, this.perspective.aspect)
    const distance = dimension * (initial ? 1.56 : 1.62) / Math.max(.44, aspect)
    this.orthoHalf = distance * Math.tan(this.perspective.fov * Math.PI / 360)
    this.orthographic.zoom = 1
    this.updateOrtho()
    const direction = initial ? initialDirection : this.camera.position.clone().sub(this.controls.target).normalize()
    this.controls.target.copy(center)
    this.camera.position.copy(center).addScaledVector(direction, distance)
    this.controls.update()
    this.repaint()
  }
  view = (name: ViewName) => {
    if (name === 'fit') { this.fit(); return }
    const direction = viewDirections[name] ? vec(viewDirections[name]!).normalize() : initialDirection
    if (name === 'reset') { this.camera.position.copy(this.controls.target).add(direction.clone().multiplyScalar(245)); this.fit(true); return }
    const distance = this.camera.position.distanceTo(this.controls.target)
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance)
    this.controls.update()
    this.repaint()
  }
  zoom = (direction: 1 | -1) => {
    const factor = direction === 1 ? 1.18 : 1 / 1.18
    if (this.camera instanceof OrthographicCamera) {
      this.camera.zoom = Math.min(95, Math.max(.007, this.camera.zoom * factor))
      this.camera.updateProjectionMatrix()
    } else {
      const delta = this.camera.position.clone().sub(this.controls.target)
      this.camera.position.copy(this.controls.target).add(delta.setLength(Math.min(15500, Math.max(1, delta.length() / factor))))
    }
    this.controls.update()
    this.repaint()
  }
  projection(ortho: boolean) {
    const next = ortho ? this.orthographic : this.perspective
    if (next === this.camera) return
    const pos = this.camera.position.clone()
    if (ortho) {
      this.orthoHalf = pos.distanceTo(this.controls.target) * Math.tan(this.perspective.fov * Math.PI / 360)
      this.orthographic.zoom = 1
      this.updateOrtho()
    } else {
      const distance = this.orthoHalf / this.orthographic.zoom / Math.tan(this.perspective.fov * Math.PI / 360)
      pos.sub(this.controls.target).setLength(distance).add(this.controls.target)
    }
    this.camera = this.controls.object = this.transform.camera = next
    next.position.copy(pos)
    this.controls.update()
    this.repaint()
  }
  get currentView(): ViewName | 'custom' {
    const direction = this.camera.position.clone().sub(this.controls.target).normalize()
    if (direction.dot(initialDirection) > .99998) return 'isometric'
    for (const [name, axis] of Object.entries(viewDirections)) {
      if (direction.dot(vec(axis).normalize()) > .99998) return name as ViewName
    }
    return 'custom'
  }
  get dimensions() { return this.size.toArray() }
  enableOrbit(enable: boolean) { this.controls.enabled = enable }
  close() {
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    this.transform.dispose()
    this.controls.dispose()
    dispose(this.scene)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost)
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.contextRestored)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
