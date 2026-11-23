import type { Project } from '../models/project'

export type Snapshot = { project: Project; selection: string[] }
export type History = { past: Snapshot[]; current: Snapshot; future: Snapshot[] }
export function begin(project: Project, selection: string[] = []): History {
  return { past: [], current: { project, selection }, future: [] }
}
export function record(history: History, next: Snapshot, limit: number, before = history.current): History {
  if (history.current.project === next.project) return history
  return { past: [...history.past.slice(-(limit - 1)), before], current: next, future: [] }
}
export function undo(history: History): History {
  const previous = history.past.at(-1)
  if (!previous) return history
  return { past: history.past.slice(0, -1), current: previous, future: [history.current, ...history.future] }
}
export function redo(history: History): History {
  const [next, ...future] = history.future
  if (!next) return history
  return { past: [...history.past, history.current], current: next, future }
}
