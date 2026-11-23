import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ArrowDownToLine, ArrowUpRight, BadgeHelp, Box, Check, CircleAlert, CloudOff, File, FolderOpen, FolderTree, Hand,
  HardDrive, Mic, Plus, Redo2, Save, ScanFace, Settings2, Video, VideoOff, Wrench, X,
} from 'lucide-react'
import { WorkspaceModel } from './model'
import { Toolbar } from '../components/Toolbar'
import { Inspector } from '../components/Inspector'
import { Viewport } from '../components/Viewport'
import { HelpPanel, Modal, SettingsPanel, WorkspacePrompt } from '../components/Dialogs'
import { CameraPanel } from '../components/CameraPanel'
import { VoiceDock } from '../components/VoiceDock'
import { IconButton, Menu, MenuItem } from '../components/ui'
import { InteractionController } from '../interactions/controller'
import { defaults, readSettings, storeSettings } from '../interactions/settings'
import type { Settings } from '../interactions/settings'
import type { Dialog, Tool } from '../interactions/types'
import { exampleProject } from '../models/demo'
import { blankProject } from '../models/project'
import type { Project, Unit } from '../models/project'
import { localProjects, projectFile, safeFileName, saveFile } from '../storage/library'
import { decodeProject } from '../storage/validation'
import { CameraSession } from '../vision/camera'
import { CalibrationSession, HandTracker } from '../vision/tracking'
import { GestureEngine } from '../gestures/engine'
import { VoiceSession } from '../voice/speech'
import type { VoiceStatus } from '../voice/speech'
import { parseIntent } from '../voice/parser'
import type { WorkspacePanel } from '../voice/parser'

type ModalName = 'settings' | 'help' | 'library' | 'rename' | 'export' | 'voice'
const unitNames: Record<Unit, string> = { mm: 'Millimeters', cm: 'Centimeters', m: 'Meters', in: 'Inches' }
const toolKeys: Record<string, Tool> = { v: 'select', l: 'line', r: 'rectangle', c: 'circle', e: 'extrude', g: 'move', t: 'rotate', s: 'scale', k: 'cut', m: 'measure' }
const modeLabels = {
  Idle: 'Ready', Hover: 'Hover', Selection: 'Object selected', DrawingLine: 'Drawing line', DrawingRectangle: 'Drawing rectangle',
  SketchEditing: 'Sketch editing', Extruding: 'Extruding', Grabbing: 'Grabbing', Moving: 'Moving object', Orbiting: 'Orbiting',
  RotatingObject: 'Rotating object', CuttingPreview: 'Cutting plane active', AwaitingDimension: 'Waiting for dimension',
  AwaitingAlignment: 'Confirm alignment', AwaitingJoinConfirmation: 'Confirm operation', AwaitingDeleteConfirmation: 'Confirm deletion',
  FeaturePreview: 'Feature preview', ErrorRecovery: 'Check operation',
}

function suggestionsFor(dialog?: Dialog) {
  if (dialog?.kind === 'dimension') return ['Set it to 50', 'Confirm', 'Cancel']
  if (dialog?.kind === 'extrude') return ['Twenty millimeters', 'Confirm', 'Cancel']
  if (dialog?.kind === 'hole') return ['Set diameter to 10', 'Confirm', 'Cancel']
  if (dialog?.kind === 'holePattern') return dialog.face?.rectangle ?
    ['Make them 8 mm', ...(dialog.phase === 'ready' ? ['Apply'] : []), 'Cancel'] : ['Use top face', 'Use this face', 'Cancel']
  if (dialog?.kind === 'chamfer') return ['Set chamfer size to 2 mm', ...(dialog.phase === 'ready' ? ['Apply'] : []), 'Cancel']
  if (dialog?.kind === 'cut') return ['YZ plane', 'Keep both pieces', 'Cancel']
  if (dialog?.kind === 'join') return ['Attach', 'Fuse', 'Cancel']
  if (dialog) return ['Confirm', 'Cancel']
  return ['Create a cube', 'Top view', 'What can I say?']
}

export function App() {
  const [workspace] = useState(() => new WorkspaceModel())
  const [settings, setSettings] = useState(readSettings)
  const settingsRef = useRef(settings)
  const [modal, setModal] = useState<ModalName>()
  const modalRef = useRef<ModalName | undefined>(undefined)
  const [savedProjects, setSavedProjects] = useState<Project[]>([])
  const [rename, setRename] = useState('')
  const [format, setFormat] = useState<'stl' | 'step'>('step')
  const [onlySelection, setOnlySelection] = useState(false)
  const [lastTranscript, setLastTranscript] = useState('')
  const [cameraStatus, setCameraStatus] = useState<'off' | 'starting' | 'active'>('off')
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({ kind: settings.voiceMuted ? 'muted' : 'starting' })
  const [calibration, setCalibration] = useState<{ step: number; count: number }>()
  const [exporting, setExporting] = useState(false)
  const calibrator = useRef<CalibrationSession | undefined>(undefined)
  const video = useRef<HTMLVideoElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const state = useSyncExternalStore(workspace.subscribe, workspace.get)
  const actions = useRef({
    saveAs: () => {}, open: () => {}, fresh: () => {}, export: (_format: 'step' | 'stl') => {}, speak: (_message: string) => {}, snap: () => {},
    help: () => {}, mute: () => {}, panel: (_panel: WorkspacePanel, _show: boolean) => {},
  })
  const [controller] = useState(() => new InteractionController(workspace, {
    saveAs: () => actions.current.saveAs(),
    open: () => actions.current.open(),
    fresh: () => actions.current.fresh(),
    export: format => actions.current.export(format),
    speak: message => actions.current.speak(message),
    settings: () => settingsRef.current,
    snap: () => actions.current.snap(),
    commandFocus: () => input.current?.focus(),
    help: () => actions.current.help(),
    mute: () => actions.current.mute(),
    panel: (panel, show) => actions.current.panel(panel, show),
  }))
  const interaction = useSyncExternalStore(controller.subscribe, controller.get)
  const scene = controller.stage
  const [tracker] = useState(() => new HandTracker())
  const [gestures] = useState(() => new GestureEngine(controller.handleGesture))
  const receiveVoice = useRef<(text: string, confidence: number) => void>(() => {})
  const [voice] = useState(() => new VoiceSession((text, confidence) => receiveVoice.current(text, confidence), setVoiceStatus))
  const updateSettings = (patch: Partial<Settings>) => {
    const value = { ...settingsRef.current, ...patch }
    settingsRef.current = value
    workspace.historyLimit = value.historyLimit
    setSettings(value)
    storeSettings(value)
  }
  const [camera] = useState(() => new CameraSession((raw, time, aspect) => {
    const current = settingsRef.current
    const hands = tracker.update(raw, time, aspect, current)
    controller.tracking(hands)
    if (calibrator.current) {
      const session = calibrator.current
      const result = session.update(hands, current.mirror)
      if (result) {
        calibrator.current = undefined
        setCalibration(undefined)
        updateSettings({ calibration: result })
        workspace.notice('Calibration saved')
      } else setCalibration({ step: session.step, count: session.count })
      return
    }
    if (modalRef.current || !controller.allowTracking(time)) { gestures.reset(time); return }
    gestures.update(hands, time, current, controller.gestureContext)
  }, (status, detail) => {
    setCameraStatus(status)
    if (status === 'off') {
      tracker.reset(); gestures.reset(performance.now()); controller.tracking([])
      if (detail) { setCalibration(undefined); calibrator.current = undefined }
    }
    if (detail) workspace.fail(new Error(detail))
  }))
  useEffect(() => {
    workspace.historyLimit = settingsRef.current.historyLimit
    void workspace.start()
    if (!settingsRef.current.voiceMuted) void voice.start({ allowBrowser: settingsRef.current.allowBrowserSpeech })
    return () => { camera.stop(); voice.mute(); workspace.close() }
  }, [workspace, camera, voice])
  const changeModal = (next?: ModalName) => {
    modalRef.current = next
    setModal(next)
    if (next) { controller.mouse(false); gestures.reset(performance.now()) }
  }
  const closeModal = () => changeModal()
  const muteVoice = () => {
    voice.mute()
    updateSettings({ voiceMuted: true })
  }
  const startVoice = (installLocal = false, allowBrowser = settingsRef.current.allowBrowserSpeech) => {
    updateSettings({ voiceMuted: false, allowBrowserSpeech: allowBrowser })
    void voice.start({ allowBrowser, installLocal })
  }
  const showPanel = (panel: WorkspacePanel, show: boolean) => updateSettings(panel === 'tools' ? { showTools: show } : { showObjects: show })
  const receiveCommand = (text: string, source: 'text' | 'voice', confidence = 1) => {
    if (modalRef.current) {
      const intent = parseIntent(text)
      if (intent?.kind === 'cancel') {
        if (source !== 'voice' || confidence >= .55) closeModal()
        return
      }
      if (intent?.kind !== 'mute' && intent?.kind !== 'help' && !(intent?.kind === 'export' && modalRef.current === 'export')) return
    }
    if (controller.command(text, source, confidence)) setLastTranscript(text.trim())
  }
  receiveVoice.current = (text, confidence) => receiveCommand(text, 'voice', confidence)
  const switchProject = async (project: Project) => {
    controller.cancel()
    if (await workspace.reopen(project)) {
      controller.reset()
      if (project.id === 'rotor-housing') controller.select('bearing-collar')
      closeModal()
    }
  }
  const fresh = () => {
    if (!state.ready || state.busy) return
    closeModal()
    const newProject = () => { void switchProject(blankProject()) }
    if (state.project.objects.length && state.project.id !== 'rotor-housing') controller.guarded('Start a new project?', newProject)
    else newProject()
  }
  const openLibrary = () => {
    changeModal('library')
    void localProjects().then(setSavedProjects).catch(() => setSavedProjects([]))
  }
  const fileSelect = async (chosen?: File) => {
    if (!chosen) return
    try {
      if (/\.(step|stp)$/i.test(chosen.name)) {
        if (chosen.size > 50_000_000) throw new Error('Choose a STEP file smaller than 50 MB.')
        workspace.notice('Importing STEP')
        const result = await workspace.kernel.request({ op: 'import', file: chosen })
        if (await workspace.commit({ type: 'import', solids: result.solids, name: chosen.name.replace(/\.[^.]+$/, '').slice(0, 100) })) {
          controller.cancel()
          closeModal()
          scene?.view('fit')
        }
      } else await switchProject(await decodeProject(chosen))
    } catch (error) { workspace.fail(error) }
  }
  const saveAs = async () => {
    try {
      if (await saveFile(projectFile(state.project), safeFileName(state.project.name) + '.holocad.json')) workspace.notice('Project file saved')
    } catch (error) { workspace.fail(error) }
  }
  const exportAs = async (choice: 'step' | 'stl', selection = false) => {
    if (exporting || state.busy || !state.ready) return
    setExporting(true)
    workspace.notice('Exporting ' + choice.toUpperCase())
    try {
      const blob = await workspace.export(choice, settings.quality, selection)
      if (await saveFile(blob, safeFileName(state.project.name) + '.' + choice)) {
        workspace.notice(choice.toUpperCase() + ' file exported')
        if (modalRef.current === 'export') closeModal()
      } else workspace.notice('Export canceled')
    } catch (error) { workspace.fail(error) }
    finally { setExporting(false) }
  }
  actions.current = {
    saveAs: () => { void saveAs() }, open: openLibrary, fresh,
    export: choice => { void exportAs(choice) },
    speak: message => voice.say(message, settingsRef.current.spokenPrompts),
    snap: () => { updateSettings({ snap: true, snapTypes: { ...settingsRef.current.snapTypes, grid: true } }); workspace.notice('Grid snapping enabled') },
    help: () => changeModal('help'), mute: muteVoice, panel: showPanel,
  }

  const toggleCamera = () => {
    if (cameraStatus !== 'off') {
      calibrator.current = undefined
      setCalibration(undefined)
      camera.stop()
    } else if (video.current) void camera.start(video.current)
  }
  const startCalibration = () => {
    closeModal()
    controller.cancel()
    calibrator.current = new CalibrationSession()
    setCalibration({ step: 0, count: 0 })
    if (cameraStatus === 'off' && video.current) void camera.start(video.current)
  }
  const toggleVoice = () => settingsRef.current.voiceMuted ? startVoice() : muteVoice()
  const keyAction = useRef<(e: KeyboardEvent) => void>(() => {})
  keyAction.current = e => {
    const key = e.key.toLowerCase()
    if (e.defaultPrevented) return
    if (key === 'escape') {
      if (modalRef.current) closeModal()
      else if (calibrator.current) { calibrator.current = undefined; setCalibration(undefined) }
      else { controller.cancel(); gestures.reset(performance.now()); workspace.dismissError() }
      return
    }
    const editing = e.target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)
    if (e.altKey && e.code === 'KeyM') { e.preventDefault(); toggleVoice(); return }
    if ((e.metaKey || e.ctrlKey) && ['s', 'o'].includes(key)) {
      e.preventDefault()
      if (key === 'o') openLibrary()
      else if (e.shiftKey) void saveAs()
      else void workspace.save()
      return
    }
    if (editing || modalRef.current || !state.ready) return
    if (e.metaKey || e.ctrlKey) {
      if (['z', 'y', 'd'].includes(key)) {
        e.preventDefault()
        controller.cancel()
        if (key === 'd') controller.duplicate()
        else void workspace.step(key === 'y' || e.shiftKey ? 'redo' : 'undo')
      }
      return
    }
    if (key === '/') { e.preventDefault(); input.current?.focus() }
    else if (key === 'enter' && (!(e.target instanceof HTMLButtonElement) ||
      ((interaction.dialog || interaction.polylineCount) && !e.target.closest('.workspace-prompt')))) { e.preventDefault(); controller.confirm() }
    else if (['backspace', 'delete'].includes(key) && state.selection.length) { e.preventDefault(); controller.delete() }
    else if (Object.hasOwn(toolKeys, key)) controller.setTool(toolKeys[key])
    else if (['x', 'y', 'z'].includes(key)) {
      const axis = key.toUpperCase() as 'X' | 'Y' | 'Z'
      controller.setAxis(interaction.axis === axis ? undefined : axis)
    } else if (key === 'f') controller.stage?.view('fit')
    else if (key === '1') controller.stage?.view('front')
    else if (key === '2') controller.stage?.view('top')
    else if (key === '3') controller.stage?.view('isometric')
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyAction.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const ready = state.ready && !state.busy
  const visibleBodies = state.project.objects.filter(o => o.kind === 'body' && !o.hidden).length
  const status = !state.ready ? state.error ? 'Kernel unavailable' : 'Initializing' :
    state.busy ? 'Updating geometry' : modeLabels[interaction.mode]
  const statusText = interaction.message || (state.status === 'Ready' ? '' : state.status)
  const labelCamera = cameraStatus === 'off' ? 'Enable camera' : 'Disable camera'

  return <div className={'app-shell voice-shell ' + (settings.reducedMotion ? 'reduce-motion' : '')}>
    <header className="topbar">
      <div className="brand"><span className="brand-mark"><Box size={21} strokeWidth={1.65} /></span><span>HOLO<span className="brand-separator">-</span>CAD</span></div>
      <div className="project-identity">
        <Menu label="Project menu" content={<><File size={15} /><span>{state.project.name}</span></>} className="project-menu">{close => <>
          <MenuItem onClick={() => { close(); fresh() }}><Plus size={16} />New project</MenuItem>
          <MenuItem detail="Ctrl O" onClick={() => { close(); openLibrary() }}><FolderOpen size={16} />Open project</MenuItem>
          <MenuItem onClick={() => { close(); void workspace.save() }}><Save size={16} />Save on this device</MenuItem>
          <MenuItem onClick={() => { close(); void saveAs() }}><ArrowDownToLine size={16} />Save As</MenuItem>
          <MenuItem onClick={() => { close(); setRename(state.project.name); changeModal('rename') }}><File size={16} />Rename project</MenuItem>
          <MenuItem onClick={() => { close(); void switchProject(exampleProject()) }}><Box size={16} />Open rotor housing example</MenuItem>
        </>}</Menu>
        <span className="save-indicator" title={state.saved ? 'Saved locally' : 'Autosaving project'}>{state.saved ? <Check size={13} /> : <CloudOff size={13} />}{state.saved ? 'Local project' : 'Autosaving'}</span>
      </div>
      <div className="top-actions">
        <button type="button" className="panel-toggle" aria-pressed={settings.showTools} aria-label="Tools panel" onClick={() => showPanel('tools', !settings.showTools)}><Wrench size={15} /><span>Tools</span></button>
        <button type="button" className="panel-toggle" aria-pressed={settings.showObjects} aria-label="Objects panel" onClick={() => showPanel('objects', !settings.showObjects)}><FolderTree size={15} /><span>Objects</span></button>
        <Menu label="Display units" className="units-menu" content={<span>{state.project.units}</span>}>{close =>
          (Object.keys(unitNames) as Unit[]).map(units => <MenuItem detail={units} key={units} onClick={() => { close(); controller.update({ type: 'project', units }) }}>{unitNames[units]}</MenuItem>)
        }</Menu>
        <IconButton label="Help and command guide" onClick={() => changeModal('help')}><BadgeHelp size={19} /></IconButton>
        <button type="button" className="primary export-button" disabled={!ready || !visibleBodies} onClick={() => changeModal('export')}><ArrowUpRight size={16} /> Export</button>
      </div>
    </header>

    <div className={'workbench voice-workbench' + (settings.showTools ? ' show-tools' : '') + (settings.showObjects ? ' show-objects' : '')}>
      <Toolbar tool={interaction.tool} set={t => controller.setTool(t)} create={controller.create} enabled={ready} />
      <Viewport model={state} controller={controller} interaction={interaction} settings={settings} showAdvanced={settings.showTools}>
        <CameraPanel video={video} status={cameraStatus} preview={settings.cameraPreview} mirror={settings.mirror} hands={interaction.hands}
          gesture={interaction.gesture} calibration={calibration} hide={() => { updateSettings({ cameraPreview: false }); calibrator.current = undefined; setCalibration(undefined) }} />
        <WorkspacePrompt controller={controller} state={interaction} unit={state.project.units} precision={settings.precision} busy={state.busy} />
        {state.error && <div role="alert" className="error-toast"><CircleAlert size={18} /><div><strong>{state.ready ? 'Check operation' : 'Startup issue'}</strong><p>{state.error}</p></div>
          <IconButton label="Dismiss message" onClick={workspace.dismissError}><X size={15} /></IconButton>
          {!state.ready && <button type="button" onClick={() => void workspace.start()}>Retry</button>}</div>}
      </Viewport>
      <Inspector project={state.project} selection={state.selection} meshes={state.meshes} precision={settings.precision} select={(id, multi) => controller.select(id, multi)} edit={cmd => controller.update(cmd)} />
    </div>

    <VoiceDock status={voiceStatus} muted={settings.voiceMuted} transcript={lastTranscript} suggestions={suggestionsFor(interaction.dialog)}
      input={input} submit={text => receiveCommand(text, 'text')} toggleMute={toggleVoice} setup={() => changeModal('voice')}
      enable={() => startVoice()} actions={<>
        <button type="button" className="undo-button" title="Undo (Ctrl or Command Z)" disabled={!state.undo || !ready} onClick={() => { controller.cancel(); void workspace.step('undo') }}><Hand size={18} strokeWidth={1.7} /><span>Undo</span></button>
        <IconButton label="Redo" disabled={!state.redo || !ready} onClick={() => { controller.cancel(); void workspace.step('redo') }}><Redo2 size={18} /></IconButton>
        <i className="dock-divider" aria-hidden="true" />
        <IconButton label={labelCamera} aria-pressed={cameraStatus !== 'off'} className={cameraStatus !== 'off' ? 'lit' : ''} onClick={toggleCamera}>
          {cameraStatus === 'off' ? <VideoOff size={18} /> : <Video size={18} />}</IconButton>
        {cameraStatus === 'active' && !settings.cameraPreview && <IconButton label="Show camera preview" onClick={() => updateSettings({ cameraPreview: true })}><Video size={17} /></IconButton>}
        <IconButton label="Settings" onClick={() => changeModal('settings')}><Settings2 size={18} /></IconButton>
      </>} />

    <footer className="statusbar">
      <div className="status-left"><span className={'status-badge ' + (state.error ? 'status-error' : '')}><i />{status}</span><span className="status-message" role="status" title={statusText}>{statusText}</span></div>
      <div className="status-right">
        <span className={cameraStatus !== 'off' ? 'status-active' : ''}><Video size={12} />{cameraStatus === 'active' ? interaction.hands.length + ' hands' : cameraStatus === 'starting' ? 'Camera starting' : 'Camera off'}</span>
        <span className="solid-count"><Box size={12} />{visibleBodies} {visibleBodies === 1 ? 'solid' : 'solids'}</span>
      </div>
    </footer>

    <input type="file" ref={file} className="file-input" accept=".holocad,.holocad.json,.json,.step,.stp" aria-label="Open local CAD file" onChange={event => {
      const chosen = event.target.files?.[0]
      event.target.value = ''
      void fileSelect(chosen)
    }} />

    {modal === 'settings' && <Modal title="Workspace settings" close={closeModal}>
      <SettingsPanel settings={settings} patch={patch => {
        updateSettings(patch)
        if (patch.allowBrowserSpeech !== undefined && !settingsRef.current.voiceMuted) void voice.start({ allowBrowser: patch.allowBrowserSpeech })
      }}
        calibrate={startCalibration} resetCalibration={() => updateSettings({ calibration: defaults.calibration })} />
    </Modal>}
    {modal === 'voice' && <Modal title="Voice setup" close={closeModal}>
      <div className="modal-scroll voice-setup-options">
        {voiceStatus.kind === 'setup' && voiceStatus.local && <>
          <button type="button" className="primary" onClick={() => { closeModal(); startVoice(true, false) }}><Mic size={16} /> Install on-device speech</button>
          <p>Your browser installs an English speech pack and recognizes commands on this device.</p>
        </>}
        <button type="button" className="setup-secondary" onClick={() => { closeModal(); startVoice(false, true) }}>Use browser speech</button>
        <p>Your browser may send audio to its speech provider. You can turn this off in Settings.</p>
      </div>
    </Modal>}
    {modal === 'help' && <Modal title="HOLO-CAD guide" close={closeModal}><HelpPanel /></Modal>}
    {modal === 'rename' && <Modal title="Rename project" close={closeModal}>
      <form className="rename-form" onSubmit={event => { event.preventDefault(); controller.update({ type: 'project', name: rename }); closeModal() }}>
        <label>Project name<input value={rename} onChange={event => setRename(event.currentTarget.value)} autoFocus maxLength={100} /></label>
        <button type="submit" className="primary" disabled={!rename.trim() || !ready}>Rename</button>
      </form>
    </Modal>}
    {modal === 'library' && <Modal title="Open project" close={closeModal}>
      <div className="modal-scroll library-body">
        <button className="open-file" type="button" disabled={!ready} onClick={() => file.current?.click()}><FolderOpen size={22} /><span><strong>Choose a file</strong><small>HOLO-CAD project or STEP solid</small></span><ArrowUpRight size={16} /></button>
        <h3><HardDrive size={15} /> Saved on this device</h3>
        {savedProjects.length ? savedProjects.map(project => <button key={project.id} className="library-row" type="button" disabled={!ready} onClick={() => void switchProject(project)}><File size={16} />{project.name}<small>{project.objects.length} objects</small></button>) :
          <p className="panel-empty">Projects saved on this device appear here.</p>}
      </div>
    </Modal>}
    {modal === 'export' && <Modal title="Export model" close={closeModal}>
      <div className="modal-scroll export-body">
        <div className="export-options">
          <button type="button" aria-pressed={format === 'step'} onClick={() => setFormat('step')}><Box size={20} /><span>STEP<small>CAD solids and surfaces</small></span></button>
          <button type="button" aria-pressed={format === 'stl'} onClick={() => setFormat('stl')}><ScanFace size={20} /><span>Binary STL<small>Triangle mesh for fabrication</small></span></button>
        </div>
        {format === 'stl' && <label className="switch-row">Mesh quality<select aria-label="Mesh quality" value={settings.quality} onChange={e => updateSettings({ quality: e.currentTarget.value as Settings['quality'] })}>
          <option value="draft">Draft</option><option value="standard">Standard</option><option value="fine">Fine</option></select></label>}
        <label className="switch-row">Selected bodies only<input type="checkbox" checked={onlySelection} onChange={e => setOnlySelection(e.currentTarget.checked)} disabled={!state.selection.length} /></label>
        <button className="primary" type="button" disabled={exporting || !ready || (onlySelection && !state.project.objects.some(o => o.kind === 'body' && !o.hidden && state.selection.includes(o.id)))}
          onClick={() => void exportAs(format, onlySelection)}><ArrowDownToLine size={16} />{exporting ? 'Exporting…' : 'Export ' + format.toUpperCase()}</button>
      </div>
    </Modal>}
  </div>
}
