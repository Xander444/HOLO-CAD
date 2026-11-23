import { GeometryClient } from '../cad/client'
import type { Quality } from '../cad/kernel'
import type { RenderGeometry } from '../cad/protocol'
import { execute } from '../commands/commands'
import type { Command } from '../commands/commands'
import { begin, record, redo, undo } from '../commands/history'
import type { History, Snapshot } from '../commands/history'
import { exampleProject } from '../models/demo'
import { isBody } from '../models/project'
import type { Project } from '../models/project'
import { autosave, restore, saveLocal } from '../storage/library'

type State = {
  project: Project; selection: string[]; meshes: RenderGeometry;
  ready: boolean; busy: boolean; undo: boolean; redo: boolean; saved: boolean; status: string; error?: string;
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'The operation could not be completed.'

export class WorkspaceModel {
  private client?: GeometryClient
  private snapshot: State
  private timeline: History
  private listeners = new Set<() => void>()
  private saveTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private starting = false
  historyLimit = 64

  constructor() {
    const project = exampleProject()
    const selection = ['bearing-collar']
    this.timeline = begin(project, selection)
    this.snapshot = { project, selection, meshes: Object.create(null), ready: false, busy: false, undo: false, redo: false, saved: true, status: 'Starting CAD kernel' }
  }
  get = () => this.snapshot
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private patch(next: Partial<State>) {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  async start() {
    if (this.starting || this.snapshot.ready) return
    this.disposed = false
    this.starting = true
    let saved: Project | undefined
    try {
      this.client?.close()
      this.client = new GeometryClient()
      try { saved = await restore() } catch { this.patch({ error: 'Browser autosave could not be restored. The example project is available.' }) }
      if (this.disposed) return
      let project = saved ?? this.snapshot.project
      let meshes: RenderGeometry
      try { meshes = await this.render(project) }
      catch (error) {
        if (!saved) throw error
        this.patch({ error: 'The autosaved geometry could not be rebuilt. The example project is available.' })
        project = exampleProject()
        saved = undefined
        meshes = await this.render(project)
      }
      const selection = saved ? [] : ['bearing-collar']
      this.timeline = begin(project, selection)
      this.patch({ project, meshes, ready: true, selection, status: 'Ready' })
    } catch (error) { this.fail(error) }
    finally { this.starting = false }
  }

  close() {
    this.disposed = true
    clearTimeout(this.saveTimer)
    this.client?.close()
  }

  private async render(project: Project) {
    if (!this.client) throw new Error('The CAD worker is starting.')
    if (!project.objects.some(isBody)) {
      await this.client.request({ op: 'init' })
      return Object.create(null) as RenderGeometry
    }
    return (await this.client.request({ op: 'render', bodies: project.objects.filter(isBody) })).results
  }

  fail = (error: unknown) => this.patch({ error: errorMessage(error), status: 'Operation stopped', busy: false })
  notice = (status: string) => this.patch({ status, error: undefined })
  dismissError = () => this.patch({ error: undefined })

  select(ids: string[]) {
    if (ids.length === this.snapshot.selection.length && ids.every((id, i) => id === this.snapshot.selection[i])) return
    this.patch({ selection: ids })
  }
  private install(next: Snapshot, meshes: RenderGeometry, status: string) {
    this.patch({
      ...next, meshes, status, busy: false, saved: false,
      undo: this.timeline.past.length > 0, redo: this.timeline.future.length > 0,
    })
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void autosave(next.project).then(() => {
        if (this.snapshot.project === next.project) this.patch({ saved: true })
      }).catch(() => this.patch({ error: 'Browser storage is unavailable. Use Save As to keep a project file.' }))
    }, 350)
  }

  async commit(command: Command) {
    const state = this.snapshot
    if (!state.ready || state.busy) return false
    try {
      const next = execute(state.project, command, state.selection)
      if (next.project === state.project) { this.notice(next.label); return true }
      this.patch({ busy: true, status: 'Updating geometry', error: undefined })
      const oldBodies = state.project.objects.filter(isBody)
      const nextBodies = next.project.objects.filter(isBody)
      const needsGeometry = oldBodies.length !== nextBodies.length ||
        nextBodies.some((o, i) => o.id !== oldBodies[i].id || o.recipe !== oldBodies[i].recipe || o.transform !== oldBodies[i].transform)
      const meshes = needsGeometry ? await this.render(next.project) : state.meshes
      this.timeline = record(this.timeline, next, this.historyLimit, { project: state.project, selection: state.selection })
      this.install(next, meshes, next.label)
      return true
    } catch (error) { this.fail(error); return false }
  }

  async reopen(project: Project) {
    if (!this.snapshot.ready || this.snapshot.busy) return false
    this.patch({ busy: true, status: 'Opening project', error: undefined })
    try {
      const next = begin(project, project.id === 'rotor-housing' ? ['bearing-collar'] : [])
      const meshes = await this.render(project)
      this.timeline = next
      this.install(next.current, meshes, 'Opened ' + project.name)
      return true
    } catch (error) { this.fail(error); return false }
  }

  async step(direction: 'undo' | 'redo') {
    if (!this.snapshot.ready || this.snapshot.busy) return false
    const present = { ...this.timeline, current: { project: this.snapshot.project, selection: this.snapshot.selection } }
    const next = (direction === 'undo' ? undo : redo)(present)
    if (next === present) { this.notice(direction === 'undo' ? 'Nothing to undo' : 'Nothing to redo'); return false }
    this.patch({ busy: true, status: 'Restoring geometry', error: undefined })
    try {
      const meshes = await this.render(next.current.project)
      this.timeline = next
      this.install(next.current, meshes, direction === 'undo' ? 'Undo' : 'Redo')
      return true
    } catch (error) { this.fail(error); return false }
  }

  async save() {
    if (!this.snapshot.ready || this.snapshot.busy) return
    const project = this.snapshot.project
    try {
      await Promise.all([saveLocal(project), autosave(project)])
      if (this.snapshot.project === project) this.patch({ saved: true, status: 'Saved on this device', error: undefined })
    } catch (error) { this.fail(error) }
  }

  get kernel() {
    if (!this.client || !this.snapshot.ready) throw new Error('The CAD kernel is still starting.')
    return this.client
  }

  async export(format: 'stl' | 'step', quality: Quality, onlySelection: boolean) {
    const { project, selection } = this.snapshot
    const bodies = project.objects.filter(isBody).filter(o => !o.hidden && (!onlySelection || selection.includes(o.id)))
    const result = await this.kernel.request({ op: 'export', bodies, format, quality })
    return result.blob
  }
}
