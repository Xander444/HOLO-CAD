import { memo, useState } from 'react'
import { Box, ChevronDown, ChevronRight, Circle, Eye, EyeOff, FolderTree, History, Layers3, Move3D, Paintbrush, Ruler, SlidersHorizontal } from 'lucide-react'
import type { Command } from '../commands/commands'
import type { RenderGeometry } from '../cad/protocol'
import type { Entity, Project, Vec3 } from '../models/project'
import { entityType } from '../models/project'
import { parameters } from '../models/parameters'
import { displayValue, sub, UNIT_FACTORS } from '../models/math'
import { IconButton, NumberField } from './ui'

export const Inspector = memo(function Inspector({ project, selection, meshes, precision, select, edit }: {
  project: Project; selection: string[]; meshes: RenderGeometry; precision: number;
  select: (id: string, multi: boolean) => void; edit: (command: Command) => void;
}) {
  const [tree, setTree] = useState(true)
  const [tab, setTab] = useState<'properties' | 'history'>('properties')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const object = project.objects.find(o => o.id === selection.at(-1))
  const bound = object && meshes[object.id]
  const groups = object ? parameters(object) : []
  const units = project.units
  const digits = Math.min(7, precision + (units === 'm' ? 3 : units === 'cm' ? 1 : units === 'in' ? 2 : 0))
  const size = (x: number) => displayValue(x, units)
  const row = (o: Entity, depth: number) => {
    const children = project.objects.filter(q => q.parent === o.id)
    const open = children.length > 0 && !collapsed.includes(o.id)
    const Icon = o.kind === 'body' ? Box : o.sketch.geometry.kind === 'circle' ? Circle : Layers3
    return <div key={o.id}>
      <div className={'tree-row ' + (selection.includes(o.id) ? 'selected' : '') + (o.hidden ? ' hidden-row' : '')}
        style={{ paddingLeft: 9 + Math.min(depth, 6) * 14 }}>
        {children.length ? <IconButton label={(open ? 'Collapse ' : 'Expand ') + o.name} onClick={() => setCollapsed(open ? [...collapsed, o.id] : collapsed.filter(id => id !== o.id))}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </IconButton> : <span className="tree-indent" />}
        <button type="button" className="tree-select" aria-pressed={selection.includes(o.id)} onClick={e => select(o.id, e.shiftKey || e.ctrlKey || e.metaKey)}>
          <Icon size={15} strokeWidth={1.75} /><span>{o.name}</span>
        </button>
        <IconButton label={(o.hidden ? 'Show ' : 'Hide ') + o.name} onClick={() => edit({ type: 'appearance', id: o.id, hidden: !o.hidden })}>
          {o.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </IconButton>
      </div>
      {open && children.map(c => row(c, depth + 1))}
    </div>
  }
  return <aside className="inspector" aria-label="Project inspector">
    <div className="objects-section">
      <button type="button" className="panel-label tree-label" aria-expanded={tree} onClick={() => setTree(!tree)}>
        <span><FolderTree size={15} strokeWidth={1.7} /> OBJECTS</span>
        <span>{project.objects.length.toString().padStart(2, '0')}{tree ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </button>
      {tree && <div className="tree-list">
        {project.objects.length ? project.objects.filter(o => !o.parent).map(o => row(o, 0)) : <p className="panel-empty">Your sketches and solids appear here.</p>}
      </div>}
    </div>
    <div className="inspector-tabs" role="tablist" aria-label="Inspector">
      <button type="button" role="tab" aria-selected={tab === 'properties'} onClick={() => setTab('properties')}><SlidersHorizontal size={14} />Properties</button>
      <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}><History size={14} />History</button>
    </div>
    <div className="inspector-content" role="tabpanel">
      {tab === 'history' ? <div className="history-list">
        <div className="tool-heading">{object ? 'OBJECT HISTORY' : 'PROJECT HISTORY'}</div>
        {(object?.history ?? project.history).length ? [...(object?.history ?? project.history)].reverse().map((line, i) => <div key={i}><i /><span>{line}</span></div>) : <p className="panel-empty">Committed operations appear here.</p>}
        {object && <><div className="tool-heading">PROJECT HISTORY</div>{[...project.history].reverse().map((line, i) => <div key={i}><i /><span>{line}</span></div>)}</>}
      </div> : !object ? <div className="inspector-empty"><Box size={27} /><p>Select an object to edit its dimensions and position.</p></div> : <>
        <div className="selected-object" key={object.id}>
          <div className="selected-icon">{object.kind === 'body' ? <Box size={22} strokeWidth={1.55} /> : <Layers3 size={21} />}</div>
          <div><input aria-label="Object name" spellCheck={false} key={object.name} defaultValue={object.name}
            onBlur={e => { if (e.target.value.trim() && e.target.value !== object.name) edit({ type: 'appearance', id: object.id, name: e.target.value }); else e.target.value = object.name }}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} />
            <small>{entityType(object).replace(/^./, c => c.toUpperCase())} · {object.kind === 'body' ? 'Solid body' : 'Sketch'}</small></div>
        </div>
        {(groups.length > 0 || bound) && <section className="property-section">
          <h3><Ruler size={15} /> Dimensions <span>{units}</span></h3>
          {groups.slice(0, 1).map((g, j) => <div className="parameters" key={j}>
            {g.values.map(p => <NumberField key={p.key} label={p.label} value={p.unit === 'angle' ? p.value : size(p.value)} suffix={p.unit === 'angle' ? '°' : units} digits={digits}
              update={input => edit({ type: 'parameter', id: object.id, key: p.key, path: p.path, value: p.unit === 'angle' ? input : input * UNIT_FACTORS[units] })} />)}
          </div>)}
          {groups.length > 1 && <details className="property-more">
            <summary>Source features</summary>
            {groups.slice(1).map((g, j) => <div className="parameters" key={j}>
              <div className="tool-heading">{g.label}</div>
              {g.values.map(p => <NumberField key={p.key} label={p.label} value={p.unit === 'angle' ? p.value : size(p.value)} suffix={p.unit === 'angle' ? '°' : units} digits={digits}
                update={input => edit({ type: 'parameter', id: object.id, key: p.key, path: p.path, value: p.unit === 'angle' ? input : input * UNIT_FACTORS[units] })} />)}
            </div>)}
          </details>}
          {bound && <details className="property-more bounds">
            <summary>Solid measurements</summary>
            <p>{sub(bound.bounds[1], bound.bounds[0]).map(n => size(n).toFixed(precision)).join(' × ')} {units}</p>
            <p>{(bound.volume / Math.pow(UNIT_FACTORS[units], 3)).toFixed(precision)} {units}³</p>
          </details>}
        </section>}
        <section className="property-section">
          <h3><Move3D size={15} /> Position</h3>
          <div className="axis-fields">{(['X', 'Y', 'Z'] as const).map((axis, i) => <NumberField key={axis} className={'axis-' + axis} label={axis} value={size(object.transform.position[i])} digits={digits}
            update={input => { const position = [...object.transform.position] as Vec3; position[i] = input * UNIT_FACTORS[units]; edit({ type: 'transform', target: object.id, ids: selection, label: 'Move', value: { ...object.transform, position } }) }} />)}</div>
          <details className="property-more">
            <summary>Rotation and scale</summary>
            {(['rotation', 'scale'] as const).map(key => <div className="transform-field" key={key}>
              <div className="tool-heading">{key}</div>
              <div className="axis-fields">{(['X', 'Y', 'Z'] as const).map((axis, i) => <NumberField key={axis} className={'axis-' + axis} label={axis} value={object.transform[key][i]} digits={4}
                update={input => {
                  const vector = [...object.transform[key]] as Vec3; vector[i] = input
                  edit({ type: 'transform', target: object.id, ids: selection, label: key === 'rotation' ? 'Rotate' : 'Scale', value: { ...object.transform, [key]: vector } })
                }} />)}</div>
            </div>)}
          </details>
        </section>
        <section className="property-section appearance">
          <h3><Paintbrush size={15} /> Appearance</h3>
          <label className="appearance-label"><span>Body color</span><span><input aria-label="Body color" type="color" key={object.id + object.color} defaultValue={object.color} onBlur={e => {
            if (e.target.value !== object.color) edit({ type: 'appearance', id: object.id, color: e.target.value })
          }} onChange={e => edit({ type: 'appearance', id: object.id, color: e.target.value })} /><code>{object.color.toUpperCase()}</code></span></label>
        </section>
        {object.parent && <section className="property-section attachment">
          <h3><FolderTree size={14} /> Attachment</h3>
          <div><span>{project.objects.find(x => x.id === object.parent)?.name}</span><button type="button" onClick={() => edit({ type: 'attach', child: object.id })}>Detach</button></div>
        </section>}
      </>}
    </div>
  </aside>
})
