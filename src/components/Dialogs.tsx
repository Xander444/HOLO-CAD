import { useEffect, useRef, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { ArrowDownToLine, ChevronRight, CircleHelp, Crosshair, Keyboard, Scan, Settings2, TriangleAlert, X } from 'lucide-react'
import { IconButton, NumberField } from './ui'
import type { InteractionController } from '../interactions/controller'
import type { CutChoice, Dialog, InteractionState } from '../interactions/types'
import type { Settings, SnapKind } from '../interactions/settings'
import type { Unit, Vec3 } from '../models/project'
import { displayValue, formatDimension, planeNormal, UNIT_FACTORS } from '../models/math'
import { faceDirections } from '../models/features'
import type { FeatureFace } from '../voice/parser'
import guideUrl from '../../docs/CONTROLS.md?url'

export function Modal({ title, close, children }: PropsWithChildren<{ title: string; close: () => void }>) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    ref.current?.focus()
    return () => previous?.focus()
  }, [])
  return <div className="modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="modal" onKeyDown={e => {
      if (e.key !== 'Tab') return
      const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? [])
      const first = list[0], last = list.at(-1)
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }}>
      <header><h2>{title}</h2><IconButton label="Close dialog" onClick={close}><X size={18} /></IconButton></header>
      {children}
    </div>
  </div>
}

export function WorkspacePrompt({ controller, state, unit, precision, busy }: {
  controller: InteractionController; state: InteractionState; unit: Unit; precision: number; busy: boolean;
}) {
  const dialog = state.dialog
  const [dimension, setDimension] = useState('')
  const dimensionId = dialog?.kind === 'dimension' ? dialog.id : undefined
  useEffect(() => setDimension(''), [dimensionId])
  if (!dialog) {
    if (!state.polylineCount) return null
    return <div className="workspace-prompt"><div><strong>{state.polylineCount} points</strong><p>Finish drawing the polyline.</p></div>
      <div className="prompt-buttons"><button type="button" disabled={state.polylineCount < 2} onClick={() => controller.polyline(false)}>Open path</button><button type="button" className="primary" disabled={state.polylineCount < 3} onClick={() => controller.polyline(true)}>Close profile</button></div>
    </div>
  }
  const size = (v: number) => displayValue(v, unit)
  const toMm = (v: number) => UNIT_FACTORS[unit] * v
  const digits = Math.min(7, precision + (unit === 'm' ? 3 : unit === 'mm' ? 0 : 2))
  const field = (label: string, value: number, setter: (n: number) => void) =>
    <NumberField key={label} label={label} suffix={unit} value={size(value)} digits={digits} update={n => setter(toMm(n))} />
  const featurePending = (dialog.kind === 'holePattern' || dialog.kind === 'chamfer') && dialog.phase !== 'ready'
  const action = (label: string, cb = controller.confirm) => <button type="button" className={dialog.kind === 'delete' ? 'danger-button' : 'primary'} disabled={busy || featurePending} onClick={cb}>{label}</button>
  let form
  let buttons = <>{action(primaryLabel(dialog))}</>
  if (dialog.kind === 'dimension') {
    const apply = () => { if (dimension.trim()) controller.command(dimension); else controller.confirm() }
    form = <form className="dimension-entry" onSubmit={e => { e.preventDefault(); apply() }}>
      <input aria-label={'Exact ' + dialog.label.toLowerCase()} type="text" inputMode="decimal" value={dimension} onChange={e => setDimension(e.currentTarget.value)}
        placeholder={formatDimension(dialog.value, unit, precision)} />
    </form>
    buttons = <>{action(dimension.trim() ? 'Apply' : 'Keep value', apply)}</>
  } else if (dialog.kind === 'extrude') {
    form = <div className="prompt-fields">{field('Depth', dialog.depth, depth => controller.previewExtrude({ ...dialog, depth }))}</div>
  } else if (dialog.kind === 'cut') {
    const n = planeNormal(dialog.plane)
    form = <div className="cut-fields">
      <div className="prompt-fields">
        <label className="select-field">Plane
          <select aria-label="Cutting plane" value={dialog.choice} onChange={e => controller.setCut({ choice: e.target.value as CutChoice })}>
            <option value="XY">XY</option><option value="XZ">XZ</option><option value="YZ">YZ</option><option value="view">From view</option><option value="custom">Custom</option>
          </select>
        </label>
        {field('Offset', dialog.offset, offset => controller.setCut({ offset }))}
      </div>
      {dialog.choice === 'custom' && <div className="prompt-fields">{['X', 'Y', 'Z'].map((axis, i) => <NumberField key={axis} label={'Normal ' + axis} value={n[i]} digits={4}
        update={value => { const normal = [...n] as Vec3; normal[i] = value; controller.setCut({ normal }) }} />)}</div>}
      {dialog.error && <p className="error-inline" role="status">{dialog.error}</p>}
    </div>
  } else if (dialog.kind === 'hole') {
    form = <div className="prompt-fields hole-fields">
      <label className="select-field">Hole type
        <select aria-label="Hole type" value={dialog.mode} onChange={e => controller.previewHole({ ...dialog, mode: e.target.value as typeof dialog.mode })}>
          <option value="through">Through-hole</option><option value="blind">Blind hole</option><option value="rectangular">Rectangular cutout</option>
        </select>
      </label>
      {field(dialog.mode === 'rectangular' ? 'Width' : 'Diameter', dialog.width, width => controller.previewHole({ ...dialog, width }))}
      {dialog.mode === 'rectangular' && field('Height', dialog.height, height => controller.previewHole({ ...dialog, height }))}
      {dialog.mode === 'blind' && field('Depth', dialog.depth, depth => controller.previewHole({ ...dialog, depth }))}
    </div>
  } else if (dialog.kind === 'holePattern') {
    form = <div className="feature-fields">
      <div className="prompt-fields">
        <label className="select-field">Face
          <select aria-label="Hole pattern face" value="" onChange={e => controller.choosePatternFace(e.target.value as FeatureFace)}>
            <option value="" disabled>{dialog.face?.rectangle ? 'Change selected face' : 'Choose a face'}</option>
            {Object.keys(faceDirections).map(face => <option key={face} value={face}>{face[0].toUpperCase() + face.slice(1)}</option>)}
          </select>
        </label>
        {field('Hole diameter', dialog.pattern.diameter, value => controller.changeFeature('holeDiameter', value))}
        {field('Corner inset', dialog.pattern.inset, value => controller.changeFeature('holeInset', value))}
      </div>
      {dialog.error && <p className="error-inline" role="status">{dialog.error}</p>}
    </div>
  } else if (dialog.kind === 'chamfer') {
    form = <div className="feature-fields">
      <div className="prompt-fields">{field('Chamfer distance', dialog.distance, value => controller.changeFeature('chamferDistance', value))}</div>
      {dialog.error && <p className="error-inline" role="status">{dialog.error}</p>}
    </div>
  } else if (dialog.kind === 'join') {
    buttons = <><button type="button" disabled={busy} onClick={() => controller.join('move')}>Place only</button><button type="button" disabled={busy} onClick={() => controller.align('face')}>Center</button>
      <button type="button" disabled={busy} onClick={() => controller.join('attach')}>Attach</button>{action('Fuse', () => controller.join('fuse'))}</>
  } else if (dialog.kind === 'align' && dialog.choice) {
    buttons = <><button type="button" disabled={busy} onClick={() => controller.align('face')}>Top face</button>{action('Align centers')}</>
  }
  return <div className={'workspace-prompt prompt-' + dialog.kind} role="region" aria-label="Modeling prompt">
    <div className="prompt-heading">
      {dialog.kind === 'delete' ? <TriangleAlert size={19} /> : dialog.kind === 'cut' ? <Scan size={18} /> : <Crosshair size={18} />}
      <strong>{state.message || primaryLabel(dialog)}</strong>
      <IconButton label="Cancel operation" onClick={controller.cancel}><X size={16} /></IconButton>
    </div>
    {form}
    <div className="prompt-buttons">{buttons}</div>
  </div>
}
function primaryLabel(dialog: Dialog) {
  switch (dialog.kind) {
    case 'delete': return 'Delete'
    case 'cut': return 'Split solid'
    case 'extrude': return 'Extrude'
    case 'align': return 'Apply alignment'
    case 'hole': return 'Apply hole'
    case 'holePattern': return 'Apply hole pattern'
    case 'chamfer': return 'Apply chamfer'
    case 'boolean': return dialog.operation === 'union' ? 'Fuse' : dialog.operation === 'subtract' ? 'Subtract' : 'Intersect'
    default: return 'Confirm'
  }
}

export function SettingsPanel({ settings, patch, calibrate, resetCalibration }: {
  settings: Settings; patch: (p: Partial<Settings>) => void; calibrate: () => void; resetCalibration: () => void
}) {
  const toggle = (label: string, key: 'cameraPreview' | 'mirror' | 'snapping' | 'allowBrowserSpeech' | 'spokenPrompts' | 'confirmVoice' | 'reducedMotion') => {
    const setting = key === 'snapping' ? 'snap' : key
    return <label className="switch-row"><span>{label}</span><input type="checkbox" checked={settings[setting]} onChange={e => patch({ [setting]: e.currentTarget.checked, ...(setting === 'mirror' ? { calibration: undefined } : {}) })} /></label>
  }
  const range = (label: string, key: 'dwell' | 'cooldown' | 'sensitivity' | 'pinch' | 'smoothing' | 'confidence' | 'snapStrength', min: number, max: number, step: number, units = '') =>
    <label className="range-row"><span>{label}</span><input type="range" min={min} max={max} step={step} value={settings[key]} onChange={e => patch({ [key]: Number(e.currentTarget.value) })} /><code>{settings[key]}{units}</code></label>
  return <div className="modal-scroll settings-body">
    <section><h3><Scan size={16} /> Camera and gestures</h3>
      {toggle('Show camera preview', 'cameraPreview')}{toggle('Mirror camera', 'mirror')}
      {range('Gesture sensitivity', 'sensitivity', .65, 1.5, .05)}
      {range('Activation delay', 'dwell', 80, 420, 10, ' ms')}
      {range('Gesture cooldown', 'cooldown', 100, 800, 10, ' ms')}
      {range('Pinch threshold', 'pinch', .18, .47, .01)}
      {range('Tracking smoothing', 'smoothing', 0, 1, .01)}
      {range('Hand confidence', 'confidence', .5, .83, .01)}
      <div className="settings-buttons"><button type="button" onClick={calibrate}>Start calibration</button>{settings.calibration && <button type="button" onClick={resetCalibration}>Reset calibration</button>}</div>
      <p>Camera frames stay on this device. Calibration maps screen movement to the virtual workspace.</p>
    </section>
    <section><h3><Crosshair size={16} /> Precision</h3>
      {toggle('Enable snapping', 'snapping')}{range('Snap strength', 'snapStrength', .35, 2.4, .05)}
      <p>Hold Alt or Option while drawing or dragging a body to place freely.</p>
      <div className="modal-fields">
        <NumberField label="Grid increment" value={settings.grid} suffix="mm" digits={3} update={grid => patch({ grid: Math.max(.01, Math.min(1000, grid)) })} />
        <NumberField label="Display decimals" value={settings.precision} digits={0} update={precision => patch({ precision: Math.round(Math.max(0, Math.min(5, precision))) })} />
        <NumberField label="Undo entries" value={settings.historyLimit} digits={0} update={historyLimit => patch({ historyLimit: Math.round(Math.max(8, Math.min(128, historyLimit))) })} />
      </div>
      <div className="snap-types">{(Object.keys(settings.snapTypes) as SnapKind[]).map(kind =>
        <label key={kind}><input type="checkbox" checked={settings.snapTypes[kind]} onChange={e => patch({ snapTypes: { ...settings.snapTypes, [kind]: e.currentTarget.checked } })} /> {kind}</label>)}</div>
    </section>
    <section><h3><Settings2 size={16} /> Speech and accessibility</h3>
      {toggle('Allow browser speech service', 'allowBrowserSpeech')}
      <p>On-device recognition is preferred. When enabled, your browser may send audio to its speech provider.</p>
      {toggle('Speak modeling prompts', 'spokenPrompts')}{toggle('Confirm spoken fuse commands', 'confirmVoice')}{toggle('Reduce motion', 'reducedMotion')}
    </section>
  </div>
}

export function HelpPanel() {
  return <div className="modal-scroll help-body">
    <a className="guide-download" href={guideUrl} download="HOLO-CAD-controls.md"><ArrowDownToLine size={17} /> Download all voice and hand controls</a>
    <h3><CircleHelp size={18} /> Start with voice</h3>
    <p>Say one command at a time. Say “select the bearing collar” or “list objects” to start with an existing part. After selecting a part, “it” refers to that part.</p>
    <ul className="help-commands">
      {['Create a red box 50 by 30 by 20', 'Draw a line 100 millimeters', 'Make it taller by five', 'Set that to 40', 'Add four 6 mm holes to the top face, 10 mm in from the corners', 'Make them 8 mm', 'Chamfer this by 2 mm', 'Apply', 'How tall is it?', 'Show tools', 'Undo that', 'Mute microphone'].map(command => <li key={command}><ChevronRight size={12} /><code>{command}</code></li>)}
    </ul>
    <h3><Scan size={18} /> Hand signs</h3>
    <p>Turn on <strong>Hands</strong> in the dock. Move your hand to aim the crosshair. Choose <strong>Calibrate</strong> in the camera preview if the workspace is hard to reach.</p>
    <dl>
      <dt>Point and hold</dt><dd>Extend only the index finger and hold over a part in Select.</dd>
      <dt>Thumbs up or thumbs down</dt><dd>Hold to apply a dimension, extrusion, or alignment, or to cancel a preview or prompt.</dd>
      <dt>Three fingers</dt><dd>Hold the index, middle, and ring fingers upright to fit the model.</dd>
      <dt>Index and pinky</dt><dd>Hold in Select to undo once.</dd>
      <dt>Thumb and pinky</dt><dd>Hold in Select to redo once.</dd>
      <dt>Both hands pinch and spread</dt><dd>Draw a line on the construction plane. Release both pinches together. Enter the length.</dd>
      <dt>Pinch and pull a selected line</dt><dd>Pull perpendicular to the line to make a rectangle. Release, then enter the height.</dd>
      <dt>Pinch the extrusion handle</dt><dd>Pull along the sketch normal and confirm a signed depth with a number or Enter.</dd>
      <dt>Close two fingers and trace an arc</dt><dd>Extend the index and middle fingers together to orbit with a curved motion.</dd>
      <dt>Open hand, then fist</dt><dd>Hover over a solid, close into a fist, and move. Open to place. Hold a drag beyond the workspace to request deletion.</dd>
      <dt>Open and close scissors</dt><dd>Select a solid, spread the index and middle fingers, trace through it, then close the extended fingers to split.</dd>
      <dt>Single pinch</dt><dd>Aim at a part, hold until Pinch to select appears, then release.</dd>
    </dl>
    <h3><Keyboard size={18} /> Mouse and keyboard</h3>
    <p>Open Tools or Objects from the header. Click to select. Drag empty space to orbit, right-drag to pan, and scroll to zoom. Hold Alt or Option while drawing or dragging a body to bypass snapping.</p>
    <div className="help-shortcuts">
      {[['Alt+M', 'Mute or unmute'], ['/', 'Command input'], ['V', 'Select'], ['L', 'Line'], ['R', 'Rectangle'], ['E', 'Extrude'], ['G', 'Move'], ['K', 'Split'], ['M', 'Measure'], ['X Y Z', 'Axis constraint'], ['Enter', 'Confirm'], ['Esc', 'Cancel'], ['⌘/Ctrl Z', 'Undo']].map(([key, name]) => <span key={key}><kbd>{key}</kbd>{name}</span>)}
    </div>
  </div>
}
