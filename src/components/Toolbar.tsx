import {
  Box, Circle, CircleDot, Combine, Cylinder, Grid2X2, Group, Layers2, MousePointer2, Move3D, Radius, RotateCw, Ruler,
  Scaling, Scissors, Shapes, Square, Spline, ChevronDown, ChevronUp, Minus, SquareMinus, SquareSplitHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { Primitive } from '../models/project'
import type { Tool } from '../interactions/types'
import { Menu, MenuItem } from './ui'

const shortcuts: Record<string, string> = { select: 'V', line: 'L', rectangle: 'R', circle: 'C', extrude: 'E', move: 'G', rotate: 'T', scale: 'S', cut: 'K', measure: 'M' }
type ToolItem = [Tool, string, LucideIcon]
const sketch: ToolItem[] = [['line', 'Line', Minus], ['rectangle', 'Rectangle', Square], ['circle', 'Circle', Circle]]
const extras: ToolItem[] = [['point', 'Point', CircleDot], ['polyline', 'Polyline', Spline], ['ellipse', 'Ellipse', Circle], ['arc', 'Arc', Radius]]
const solid: ToolItem[] = [['extrude', 'Extrude', Layers2], ['cut', 'Split', Scissors], ['hole', 'Hole', CircleDot],
  ['holePattern', 'Hole pattern', Grid2X2], ['chamfer', 'Chamfer', SquareSplitHorizontal]]
const transform: ToolItem[] = [['move', 'Move', Move3D], ['rotate', 'Rotate', RotateCw], ['scale', 'Scale', Scaling]]
const combine: ToolItem[] = [['union', 'Fuse', Combine], ['subtract', 'Subtract', SquareMinus], ['intersect', 'Intersect', SquareSplitHorizontal], ['attach', 'Attach', Group]]
const shapes: [Primitive['kind'], string][] = [['box', 'Box'], ['cube', 'Cube'], ['cylinder', 'Cylinder'], ['sphere', 'Sphere'], ['cone', 'Cone'], ['tube', 'Tube'], ['prism', 'Rectangular prism']]

export function Toolbar({ tool, set, create, enabled }: { tool: Tool; set: (tool: Tool) => void; create: (p: Primitive['kind']) => void; enabled: boolean }) {
  const [more, setMore] = useState(false)
  const row = ([id, name, Icon]: ToolItem) => <button key={id} aria-pressed={tool === id} type="button" className={'tool-row ' + (tool === id ? 'current' : '')} disabled={!enabled}
    onClick={() => set(id)} title={name + (shortcuts[id] ? ' (' + shortcuts[id] + ')' : '')}>
    <Icon size={17} strokeWidth={1.65} /><span>{name}</span>{shortcuts[id] && <kbd>{shortcuts[id]}</kbd>}
  </button>
  return <aside className="tools" aria-label="Modeling tools">
    <div className="panel-label"><span>TOOLS</span><MousePointer2 size={14} /></div>
    <div className="tool-scroll">
      <div className="tool-group first">{row(['select', 'Select', MousePointer2])}</div>
      <div className="tool-group">
        <div className="tool-heading">SKETCH</div>
        {sketch.map(row)}
        <button type="button" className="more-sketch" aria-expanded={more} onClick={() => setMore(!more)}>{more ? <ChevronUp size={13} /> : <ChevronDown size={13} />}<span>{more ? 'Fewer sketch tools' : 'More sketch tools'}</span></button>
        {more && extras.map(row)}
      </div>
      <div className="tool-group">
        <div className="tool-heading">SOLID</div>
        <Menu label="Create primitive" disabled={!enabled} content={<><Box size={17} strokeWidth={1.65} /><span>Primitive</span></>} className="primitive-menu">
          {close => shapes.map(([kind, label]) => <MenuItem key={kind} onClick={() => { close(); create(kind) }}>
            {kind === 'cylinder' || kind === 'tube' ? <Cylinder size={16} /> : <Shapes size={16} />}{label}
          </MenuItem>)}
        </Menu>
        {solid.map(row)}
      </div>
      <div className="tool-group"><div className="tool-heading">TRANSFORM</div>{transform.map(row)}</div>
      <div className="tool-group"><div className="tool-heading">COMBINE</div>{combine.map(row)}</div>
      <div className="tool-group last">{row(['measure', 'Measure', Ruler])}</div>
    </div>
  </aside>
}
