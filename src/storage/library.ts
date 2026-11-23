import type { Project } from '../models/project'
import { readProject } from './validation'

type RecordRow = { key: string; project: Project; time: number }
let connection: Promise<IDBDatabase> | undefined
function db() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('holo-cad', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('projects', { keyPath: 'key' })
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => { connection = undefined; reject(open.error) }
    open.onblocked = () => { connection = undefined; reject(new Error('Close other HOLO-CAD tabs, then retry saving.')) }
  })
  return connection
}

async function put(key: string, project: Project) {
  const storage = await db()
  return new Promise<void>((resolve, reject) => {
    const tx = storage.transaction('projects', 'readwrite')
    tx.objectStore('projects').put({ key, project, time: Date.now() } satisfies RecordRow)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('Browser storage rejected the project.'))
  })
}

export const autosave = (project: Project) => put('autosave', project)
export const saveLocal = (project: Project) => put('project:' + project.id, project)

export async function restore() {
  const storage = await db()
  const row = await new Promise<RecordRow | undefined>((resolve, reject) => {
    const request = storage.transaction('projects').objectStore('projects').get('autosave')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return row ? readProject(row.project) : undefined
}

export async function localProjects() {
  const storage = await db()
  const rows = await new Promise<RecordRow[]>((resolve, reject) => {
    const request = storage.transaction('projects').objectStore('projects').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return rows.filter(row => row.key.startsWith('project:')).sort((a, b) => b.time - a.time).map(row => readProject(row.project))
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>
}
export async function saveFile(blob: Blob, name: string) {
  const picker = (window as SavePickerWindow).showSaveFilePicker
  if (picker) {
    try {
      const handle = await picker.call(window, { suggestedName: name })
      const stream = await handle.createWritable()
      await stream.write(blob)
      await stream.close()
      return true
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return false
      if (!(error instanceof DOMException && ['SecurityError', 'NotAllowedError'].includes(error.name))) throw error
    }
  }
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return true
}
export const projectFile = (project: Project) => new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' })
export const safeFileName = (name: string) => name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim() || 'project'
