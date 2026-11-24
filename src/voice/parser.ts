import type { Axis, PlaneName, Primitive, Unit, Vec3 } from '../models/project'
import { UNIT_FACTORS } from '../models/math'
import type { FaceDirection } from '../models/features'

const small: Record<string, number> = {
  zero: 0, oh: 0, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

function numberPart(input: string): number | undefined {
  const signed = /^(minus|negative|positive)\s+(.+)$/.exec(input)
  if (signed) {
    if (/^(minus|negative|positive)\b/.test(signed[2])) return
    const magnitude = numberPart(signed[2])
    return magnitude === undefined ? undefined : magnitude * (signed[1] === 'positive' ? 1 : -1)
  }
  if (/^[+-]?\s*(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) return Number(input.replaceAll(' ', ''))
  const mixed = /^([+-])?\s*(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)$/.exec(input)
  if (mixed) {
    if (+mixed[4] === 0) return
    return (mixed[1] === '-' ? -1 : 1) * (Number(mixed[2] ?? 0) + +mixed[3] / +mixed[4])
  }
  const text = input.replace(/-/g, ' ')
  const fraction = /(?:(.*?)\s+and\s+)?(a|one|two|three)\s+(half|halves|quarters?)$/.exec(text)
  if (fraction && fraction.index === 0) {
    const whole = fraction[1] ? numberPart(fraction[1]) : 0
    if (whole === undefined) return
    return whole + small[fraction[2]] / (fraction[3].startsWith('hal') ? 2 : 4)
  }
  if (text === 'half' || text === 'a half') return .5
  const [integer, decimals, ...rest] = text.split(/\s*\bpoint\b\s*/)
  if (rest.length || (!integer && !decimals)) return
  let whole = 0, group = 0, count = 0
  for (const word of integer.split(/\s+/).filter(Boolean)) {
    if (word === 'and' && count) continue
    if (word === 'hundred') { group = (group || 1) * 100; count++; continue }
    if (word === 'thousand' || word === 'million') { whole += (group || 1) * (word === 'thousand' ? 1e3 : 1e6); group = 0; count++; continue }
    if (!Object.hasOwn(small, word)) return
    group += small[word]; count++
  }
  if (!count && !decimals) return
  const digits = decimals?.trim().split(/\s+/).map(word => /^[0-9]+$/.test(word) ? word : small[word] >= 0 && small[word] < 10 ? String(small[word]) : '')
  if (digits?.some(digit => !digit)) return
  return whole + group + (digits ? Number('0.' + digits.join('')) : 0)
}

const aliases: Record<string, Unit> = {
  mm: 'mm', millimeter: 'mm', millimetre: 'mm', millimeters: 'mm', millimetres: 'mm',
  cm: 'cm', centimeter: 'cm', centimetre: 'cm', centimeters: 'cm', centimetres: 'cm',
  m: 'm', meter: 'm', metre: 'm', meters: 'm', metres: 'm',
  in: 'in', inch: 'in', inches: 'in', '"': 'in', '″': 'in',
}
export function quantity(input: string, mode: 'length' | 'angle' | 'scalar' = 'length'): number | undefined {
  let text = input.toLowerCase().trim().replace(/[.!?,]+$/, '').trim()
  let factor = 1
  const unitMatch = /([a-z]+|["″°])$/.exec(text)
  if (mode === 'length' && unitMatch && aliases[unitMatch[1]]) {
    factor = UNIT_FACTORS[aliases[unitMatch[1]]]
    text = text.slice(0, unitMatch.index).trim()
  }
  if (mode === 'angle') text = text.replace(/\s*(?:degrees?|deg|°)$/, '').trim()
  const number = numberPart(text)
  return number === undefined || !Number.isFinite(number * factor) ? undefined : number * factor
}

export function dimensionList(input: string) {
  const parts = input.toLowerCase().trim().replace(/[.!?]+$/, '').split(/\s+(?:by|x)\s+|\s*×\s*|(?<=\d)\s*x\s*(?=[+-]?\d)/)
  if (parts.length < 2 || parts.length > 3) return
  const shared = /([a-z]+|["″])$/.exec(parts.at(-1)!)?.[1]
  const unit = shared && aliases[shared] ? shared : undefined
  const values = parts.map(part => quantity(unit && quantity(part, 'scalar') !== undefined ? part + ' ' + unit : part))
  if (values.every(value => value !== undefined)) return values as number[]
}

export type ViewName = 'isometric' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'fit' | 'reset'
export type AlignMode = 'center' | 'face' | 'top' | 'left' | 'flush' | Axis
type Adjustment = 'set' | 'add' | 'multiply'
export type WorkspacePanel = 'tools' | 'objects'
export type FeatureFace = FaceDirection | 'pointed'
type TargetCommand =
  | { kind: 'move'; delta: Vec3; absolute?: boolean }
  | { kind: 'rotate'; degrees: number; axis?: Axis }
  | { kind: 'scale'; factor: number }
  | { kind: 'extrude'; depth?: number }
  | { kind: 'delete' | 'duplicate' | 'cut' | 'hole' }
export type Intent =
  | TargetCommand
  | { kind: 'dimension'; value: number; raw: string }
  | { kind: 'parameter'; key: string; value: number; adjustment?: Adjustment }
  | { kind: 'primitive'; shape: Primitive['kind']; dimensions: Record<string, number>; color?: string }
  | { kind: 'line'; length?: number }
  | { kind: 'rectangle'; dimensions?: [number, number?] }
  | { kind: 'circle'; radius?: number }
  | { kind: 'holePattern'; face?: FeatureFace; diameter?: number; inset?: number }
  | { kind: 'patternFace'; face: FeatureFace }
  | { kind: 'featureDimension'; key: 'holeDiameter' | 'holeInset' | 'chamferDistance'; value: number }
  | { kind: 'chamfer'; distance?: number }
  | { kind: 'constraint'; axis?: Axis }
  | { kind: 'plane'; plane: PlaneName }
  | { kind: 'align'; mode: AlignMode }
  | { kind: 'view'; view: ViewName }
  | { kind: 'zoom'; direction: 1 | -1 }
  | { kind: 'export'; format: 'stl' | 'step' }
  | { kind: 'units'; units: Unit }
  | { kind: 'selectObjects'; names: string[]; add?: boolean }
  | { kind: 'allObjects'; scope?: 'body' | 'sketch' }
  | { kind: 'namedAction'; name: string; action: TargetCommand }
  | { kind: 'rename'; name: string }
  | { kind: 'visibility'; hidden: boolean; name?: string }
  | { kind: 'changeColor'; color: string }
  | { kind: 'panel'; panel: WorkspacePanel; show: boolean }
  | { kind: 'describe'; subject: 'selection' | 'objects' | string }
  | { kind: 'tool'; tool: 'select' | 'point' | 'line' | 'rectangle' | 'circle' | 'polyline' | 'ellipse' | 'arc' | 'move' | 'rotate' | 'scale' | 'measure' }
  | { kind: 'undo' | 'redo' | 'cancel' | 'confirm' | 'save' | 'saveAs' | 'open' | 'new' | 'fuse' | 'attach' | 'detach' | 'subtract' | 'intersect' | 'snap' | 'both' | 'clearSelection' | 'help' | 'mute' }

const simple: Record<string, Intent['kind']> = {
  undo: 'undo', 'undo that': 'undo', 'go back one step': 'undo', redo: 'redo', 'redo that': 'redo',
  delete: 'delete', 'delete selected': 'delete', 'delete it': 'delete', 'delete that': 'delete',
  duplicate: 'duplicate', 'duplicate it': 'duplicate', 'copy that': 'duplicate', 'make a copy': 'duplicate',
  yes: 'confirm', confirm: 'confirm', apply: 'confirm', 'go ahead': 'confirm', 'confirm that': 'confirm',
  'keep drawn size': 'confirm', 'keep current size': 'confirm', 'use current sizes': 'confirm', 'use suggested sizes': 'confirm',
  no: 'cancel', cancel: 'cancel', stop: 'cancel', 'cancel that': 'cancel', 'never mind': 'cancel', close: 'cancel', 'close dialog': 'cancel',
  save: 'save', 'save project': 'save', 'save as': 'saveAs', 'open project': 'open', 'new project': 'new',
  fuse: 'fuse', union: 'fuse', 'join them': 'fuse', 'fuse them': 'fuse', attach: 'attach', 'attach them': 'attach',
  detach: 'detach', subtract: 'subtract', intersect: 'intersect',
  cut: 'cut', split: 'cut', 'split it': 'cut', 'cut it': 'cut', 'make a hole': 'hole', 'drill a hole': 'hole', hole: 'hole',
  'snap to grid': 'snap', 'keep both pieces': 'both', 'keep both': 'both',
  deselect: 'clearSelection', 'deselect all': 'clearSelection', 'clear selection': 'clearSelection',
  help: 'help', 'show help': 'help', 'what can i say': 'help', 'show controls': 'help',
  mute: 'mute', 'mute mic': 'mute', 'mute microphone': 'mute', 'mute the microphone': 'mute', 'stop listening': 'mute',
}
const objects = /\b(box|cube|cylinder|sphere|cone|tube|rectangular prism|prism)\b/
const primitiveOrder: Record<Primitive['kind'], string[]> = {
  box: ['width', 'length', 'height'], prism: ['width', 'length', 'height'], cube: ['size'], sphere: ['diameter'],
  cylinder: ['diameter', 'height'], cone: ['diameter', 'height'], tube: ['diameter', 'innerDiameter', 'height'],
}
const dimensions = /\b(inner diameter|outer diameter|bore diameter|inner radius|diameter|radius|width|side length|length|height|depth|side|size|angle|sweep)\b/g
const dimKey = (label: string) => ({
  'inner diameter': 'innerDiameter', 'bore diameter': 'innerDiameter', 'outer diameter': 'diameter', 'inner radius': 'innerRadius',
  side: 'size', 'side length': 'size', 'horizontal radius': 'radiusX', 'x radius': 'radiusX', 'vertical radius': 'radiusY', 'y radius': 'radiusY',
}[label] ?? label)
const axis = (value: string) => value.toUpperCase() as Axis
const colors: Record<string, string> = {
  red: '#d87377', orange: '#e1a563', yellow: '#dfc575', green: '#72c6a2', teal: '#4abfb8',
  cyan: '#40b6cb', blue: '#679de7', purple: '#a58be0', pink: '#d98eb9', white: '#d9e7ec',
  gray: '#879aab', grey: '#879aab', black: '#303e4b',
}
const adjective: Record<string, string> = { tall: 'height', taller: 'height', shorter: 'height', wide: 'width', wider: 'width', narrower: 'width', long: 'length', longer: 'length', deep: 'depth', deeper: 'depth' }
const pronoun = /^(?:it|that|this|(?:the )?(?:selected )?(?:object|part|body|shape))$/
const stripTitle = (s: string) => s.replace(/^(?:the|my)\s+/, '')
const splitNames = (s: string) => s.split(/\s*,\s*|\s+and\s+/).map(stripTitle).filter(Boolean)
const shapeWords = (s: string) => s.replace(/\brectangular solid\b/g, 'rectangular prism').replace(/\bcuboid\b/g, 'box').replace(/\bball\b/g, 'sphere').replace(/\bpipe\b/g, 'tube')
const faceName = (name: string): FeatureFace => ['this', 'that', 'pointed'].includes(name) ? 'pointed' : name as FaceDirection

function featureIntent(text: string): Intent | undefined {
  const face = /^(?:(?:use|choose|select) (?:the )?)?(top|bottom|front|back|left|right|this|that|pointed) face$/.exec(text)
  if (face) return { kind: 'patternFace', face: faceName(face[1]) }

  const bevel = /^(?:chamfer|bevel)(?: (?:this edge|that edge|this|that|it|the edge))?(?: (?:by |to )?(.+))?$/.exec(text)
  if (bevel) {
    const distance = bevel[1] ? quantity(bevel[1]) : undefined
    if (!bevel[1] || distance !== undefined) return { kind: 'chamfer', distance }
  }
  const distancePhrase = /^(?:add|make) (?:a )?(.+?) (?:chamfer|bevel)(?: (?:on|to) (?:this|that|the) edge)?$/.exec(text)
  if (distancePhrase) {
    const distance = quantity(distancePhrase[1])
    if (distance !== undefined) return { kind: 'chamfer', distance }
  }

  const feature = /^(?:set|change|make) (?:the )?(hole diameter|hole inset|pattern inset|chamfer distance|chamfer size|bevel size|them|the holes)(?: (?:to|at))? (.+)$/.exec(text)
  if (feature) {
    const value = quantity(feature[2])
    const key = /inset/.test(feature[1]) ? 'holeInset' : /chamfer|bevel/.test(feature[1]) ? 'chamferDistance' : 'holeDiameter'
    if (value !== undefined) return { kind: 'featureDimension', key, value }
  }

  const four = /^(?:add|create|make|drill|put) (?:four|4)(?: (.+?))? holes\b(.*)$/.exec(text.replace(/\bthrough[ -]holes\b/, 'holes'))
  const pattern = /^(?:(?:add|create|make|drill) (?:a )?)?(?:four[ -]corner )?hole pattern\b(.*)$/.exec(text)
  if (!four && !pattern) return
  let diameter = four?.[1] ? quantity(four[1]) : undefined
  if (four?.[1] && diameter === undefined) return
  let inset: number | undefined
  const tail = four?.[2] ?? pattern![1]
  const faceClause = /\b(?:to|on|in|into) (?:the )?(top|bottom|front|back|left|right|this|that|pointed) face\b/
  const match = faceClause.exec(tail)
  const rest = tail.replace(faceClause, '').trim().replace(/^[, ]+|[, ]+$/g, '')
  const named = /^(?:with )?diameter (.+?)(?:\s*,\s*|\s+and\s+|\s+)inset(?: of)? (.+)$/.exec(rest)
  if (named) {
    diameter = quantity(named[1])
    inset = quantity(named[2])
    if (diameter === undefined || inset === undefined) return
  } else if (rest) {
    const amount = rest.replace(/^(?:with |at |inset(?: of)? )/, '').replace(/\s+(?:in )?from (?:the |each )?(?:corners?|edges?)$/, '')
    inset = quantity(amount)
    if (inset === undefined) return
  }
  return { kind: 'holePattern', face: match && faceName(match[1]) || undefined, diameter, inset }
}

export function objectNameKey(input: string): string {
  const text = stripTitle(input.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim())
    .replace(/\bnumber\s+(?=[a-z0-9])/, '')
  return text.replace(/\b[a-z]+\b/g, word => Object.hasOwn(small, word) && word !== 'a' ? String(small[word]) : word)
}

export function parseIntent(input: string): Intent | undefined {
  const original = input.trim().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
    .replace(/^(?:(?:hey[, ]+)?(?:holo[ -]?cad|hollow cad)[,: ]+|please\s+)|\s+please$/gi, '')
  const text = original.toLowerCase()
  if (!text) return
  if (Object.hasOwn(simple, text)) return { kind: simple[text] } as Intent
  const advanced = featureIntent(text)
  if (advanced) return advanced
  if (/^select all(?: (?:objects|parts))?$/.test(text)) return { kind: 'allObjects' }
  if (/^select all (?:bodies|solids)$/.test(text)) return { kind: 'allObjects', scope: 'body' }
  if (text === 'select all sketches') return { kind: 'allObjects', scope: 'sketch' }
  const selection = /^select\s+(.+?)(\s+as well|\s+too)?$/.exec(text)
  if (selection) return { kind: 'selectObjects', names: splitNames(selection[1]), add: !!selection[2] }
  const addSelection = /^add\s+(.+)\s+to (?:the )?selection$/.exec(text)
  if (addSelection) return { kind: 'selectObjects', names: splitNames(addSelection[1]), add: true }
  const showPanel = /^(show|hide|open|close) (?:the )?(toolbox|tools|tool panel|objects|object list|properties|inspector)$/.exec(text)
  if (showPanel) return { kind: 'panel', panel: showPanel[2].startsWith('tool') ? 'tools' : 'objects', show: ['show', 'open'].includes(showPanel[1]) }
  if (/^(what is selected|what's selected|what did i select|what have i selected|describe (?:it|that|selection)|which (?:part|object) is selected)$/.test(text)) return { kind: 'describe', subject: 'selection' }
  if (/^(list (?:the )?(?:objects|parts|bodies)|what objects are here|what parts do i have)$/.test(text)) return { kind: 'describe', subject: 'objects' }
  const askSize = /^how (tall|wide|long|deep) (?:is it|is that|is this|is the selected (?:part|object))$/.exec(text)
  if (askSize) return { kind: 'describe', subject: adjective[askSize[1]] }
  const askParameter = /^what(?:'s| is) (?:its |the )?(inner diameter|diameter|radius|width|length|height|depth|size|volume)$/.exec(text)
  if (askParameter) return { kind: 'describe', subject: dimKey(askParameter[1]) }
  const rename = /^rename(?:\s+(?:it|that|this|the (?:part|object)))?\s+(?:to\s+)?(.+)$/i.exec(original)
  if (rename) return { kind: 'rename', name: rename[1] }
  const visibility = /^(show|hide)\s+(.+)$/.exec(text)
  if (visibility && !/\bview$|^everything$/.test(visibility[2])) return { kind: 'visibility', hidden: visibility[1] === 'hide', name: pronoun.test(visibility[2]) ? undefined : stripTitle(visibility[2]) }
  const newColor = /^(?:make|paint|color|colour) (?:it|that|this|the selected (?:part|object)) (\w+)$/.exec(text)
  if (newColor && Object.hasOwn(colors, newColor[1])) return { kind: 'changeColor', color: colors[newColor[1]] }
  const adjusted = /^(increase|decrease|reduce|raise|lower)\s+(?:(?:the|its)\s+)?(inner diameter|inner radius|diameter|radius|width|length|height|depth|side|size|angle|sweep)\s+by\s+(.+)$/.exec(text)
  if (adjusted) {
    const key = dimKey(adjusted[2]), amount = quantity(adjusted[3], ['angle', 'sweep'].includes(key) ? 'angle' : 'length')
    if (amount !== undefined) return { kind: 'parameter', key, value: amount * (['decrease', 'reduce', 'lower'].includes(adjusted[1]) ? -1 : 1), adjustment: 'add' }
  }
  const comparative = /^make (?:it|that|this) (taller|shorter|wider|narrower|longer|deeper) (?:by )?(.+)$/.exec(text)
  if (comparative) {
    const value = quantity(comparative[2])
    if (value !== undefined) return { kind: 'parameter', key: adjective[comparative[1]], value: ['shorter', 'narrower'].includes(comparative[1]) ? -value : value, adjustment: 'add' }
  }
  const sizeDifference = /^make (?:it|that|this) (.+?) (taller|shorter|wider|narrower|longer|deeper)$/.exec(text)
  if (sizeDifference) {
    const value = quantity(sizeDifference[1])
    const change = sizeDifference[2]
    if (value !== undefined) return { kind: 'parameter', key: adjective[change], value: ['shorter', 'narrower'].includes(change) ? -value : value, adjustment: 'add' }
  }
  const multiple = /^make (?:it|that|this) (twice|half) as (tall|wide|long|deep)$/.exec(text)
  if (multiple) return { kind: 'parameter', key: adjective[multiple[2]], value: multiple[1] === 'twice' ? 2 : .5, adjustment: 'multiply' }
  const descriptive = /^make (?:it|that|this|the selected (?:part|object))\s+(.+?)\s+(tall|wide|long|deep)$/.exec(text)
  if (descriptive) {
    const value = quantity(descriptive[1])
    if (value !== undefined) return { kind: 'parameter', key: adjective[descriptive[2]], value }
  }
  const relativeValue = /^(?:set|make|change) (?:it|that|this)(?: to)?\s+(.+)$/.exec(text)
  if (relativeValue) {
    const value = quantity(relativeValue[1])
    if (value !== undefined) return { kind: 'dimension', value, raw: relativeValue[1] }
  }
  const numeric = quantity(text)
  if (numeric !== undefined) return { kind: 'dimension', value: numeric, raw: text }
  const build = shapeWords(text)
  const matches = [...build.matchAll(dimensions)]
  const creation = /^(?:(?:create|make|add|insert|build|draw)\s+(?:an?\s+)?)(?:(?:\w+)\s+)?(?:box|cube|cylinder|sphere|cone|tube|rectangular prism|prism)\b/.test(build) ||
    /^(?:box|cube|cylinder|sphere|cone|tube|rectangular prism|prism)\b/.test(build)
  const shape = objects.exec(build)
  if (creation && shape) {
    const values: Record<string, number> = {}
    const colorName = build.slice(0, shape.index).trim().split(' ').at(-1) ?? ''
    const color = Object.hasOwn(colors, colorName) ? colors[colorName] : undefined
    for (const [i, match] of matches.entries()) {
      const raw = build.slice(match.index! + match[0].length, matches[i + 1]?.index)
        .replace(/^\s*(?:to|of|is|=)\s*/, '').replace(/\s*(?:,|\band|\bby)\s*$/g, '')
      const value = quantity(raw)
      if (value === undefined) return
      values[dimKey(match[0])] = value
    }
    const kind = (shape[1] === 'rectangular prism' ? 'prism' : shape[1]) as Primitive['kind']
    const rest = build.slice(shape.index + shape[0].length).trim().replace(/^(?:with|of|measuring|sized|that's)\s+/, '')
    if (!matches.length && rest) {
      const measures = dimensionList(rest)
      const single = quantity(rest)
      const specified = measures ?? (single !== undefined ? [single] : undefined)
      if (specified) {
        if (specified.length > primitiveOrder[kind].length) return
        specified.forEach((value, i) => { values[primitiveOrder[kind][i]] = value })
      } else {
        for (const phrase of rest.split(/\s+and\s+/)) {
          const measure = /^(.+?)\s+(tall|wide|long|deep)$/.exec(phrase)
          const value = measure && quantity(measure[1])
          if (!measure || value == null) return
          const key = adjective[measure[2]]
          values[key === 'width' && ['cylinder', 'cone', 'sphere', 'tube'].includes(kind) ? 'diameter' : key] = value
        }
      }
    }
    return { kind: 'primitive', shape: kind, dimensions: values, ...(color && { color }) }
  }
  const line = /^(?:draw|create|make) (?:a )?line(?: with(?: a)? length of)?\s+(.+)$/.exec(text)
  if (line) {
    const length = quantity(line[1])
    if (length !== undefined) return { kind: 'line', length }
  }
  if (/^(?:draw a|create(?: a)?|make(?: a)?) line$/.test(text)) return { kind: 'line' }
  if (/^(?:draw |tool )?(rectangle|circle)$/.test(text)) return { kind: 'tool', tool: text.endsWith('rectangle') ? 'rectangle' : 'circle' }
  const profile = /^(?:(?:draw|create|make|add)\s+(?:an?\s+)?)?(rectangle|circle)(?:\s+(?:with\s+)?(.*))?$/.exec(text)
  if (profile?.[1] === 'rectangle') {
    if (!profile[2]) return { kind: 'rectangle' }
    const sides = dimensionList(profile[2])
    const width = quantity(profile[2])
    if (sides?.length === 2) return { kind: 'rectangle', dimensions: [sides[0], sides[1]] }
    if (width !== undefined) return { kind: 'rectangle', dimensions: [width] }
  }
  if (profile?.[1] === 'circle') {
    if (!profile[2]) return { kind: 'circle' }
    const radius = quantity(profile[2].replace(/^(radius|diameter)\s+(?:of\s+)?/, ''))
    if (radius !== undefined) return { kind: 'circle', radius: /diameter/.test(profile[2]) ? radius / 2 : radius }
  }
  const parameter = /^(?:(?:set|make|change)\s+(?:the\s+)?)?(inner diameter|outer diameter|bore diameter|inner radius|diameter|horizontal radius|vertical radius|x radius|y radius|radius|width|side length|length|height|depth|side|size|angle|sweep)\s+(?:(?:to|of|is)\s+)?(.+)$/.exec(text)
  if (parameter) {
    const value = quantity(parameter[2], ['angle', 'sweep'].includes(parameter[1]) ? 'angle' : 'length')
    if (value !== undefined) return { kind: 'parameter', key: dimKey(parameter[1]), value }
  }
  const actionText = text.replace(/^(move|rotate|turn|scale|extrude)\s+(?:it|that|this|(?:the )?(?:selected )?(?:object|part|body|shape))(?=\s|$)/, '$1')
    .replace(/^turn\b/, 'rotate').replace(/^lift\s+(?:it|that|this)\s+/, 'move up ').replace(/^lower\s+(?:it|that|this)\s+/, 'move down ')
  const extrude = /^extrude(?:\s+(?:by\s+)?(.+))?$/.exec(actionText)
  if (extrude) {
    const depth = extrude[1] ? quantity(extrude[1]) : undefined
    if (!extrude[1] || depth !== undefined) return { kind: 'extrude', depth }
  }
  const vector = /^move\s+(?:to|by)\s+(.+)$/.exec(actionText)
  if (vector) {
    const named = /^x\b\s*(.+?)\s*\by\b\s*(.+?)\s*(?:and\s+)?\bz\b\s*(.+)$/.exec(vector[1])
    const coords = named ? named.slice(1) : vector[1].split(/\s*[,;]\s*/)
    const values = coords.map(s => quantity(s.replace(/^\s*[xyz]\b\s*/, '').replace(/[,\s]+$/, '').replace(/^=\s*/, '')))
    if (values.length === 3 && values.every(v => v !== undefined)) return { kind: 'move', delta: values as Vec3, absolute: actionText.startsWith('move to ') }
  }
  const move = /^move\s+(left|right|up|down|forward|back|backward|x|y|z)\s+(.+)$/.exec(actionText)
  if (move) {
    const distance = quantity(move[2])
    if (distance !== undefined) {
      const directions: Record<string, Vec3> = {
        left: [-1, 0, 0], right: [1, 0, 0], up: [0, 0, 1], down: [0, 0, -1],
        forward: [0, -1, 0], back: [0, 1, 0], backward: [0, 1, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
      }
      return { kind: 'move', delta: directions[move[1]].map(f => f * distance) as Vec3 }
    }
  }
  const rotate = /^rotate\s+(.+?)(?:\s+(?:around|about|on)\s+([xyz])(?: axis)?)?$/.exec(actionText)
  if (rotate) {
    const degrees = quantity(rotate[1], 'angle')
    if (degrees !== undefined) return { kind: 'rotate', degrees, axis: rotate[2] ? axis(rotate[2]) : undefined }
  }
  if (/^(?:double|halve) (?:it|this|that|the size)$/.test(text)) return { kind: 'scale', factor: text.startsWith('double') ? 2 : .5 }
  const scale = /^scale\s+(?:by\s+)?(.+)$/.exec(actionText)
  if (scale) {
    const factor = quantity(scale[1], 'scalar')
    if (factor !== undefined) return { kind: 'scale', factor }
  }
  const targetMove = /^move\s+(.+?)\s+(left|right|up|down|forward|back|backward|to)\s+(.+)$/.exec(text)
  if (targetMove) {
    const action = parseIntent('move ' + targetMove[2] + ' ' + targetMove[3])
    if (action?.kind === 'move') return { kind: 'namedAction', name: stripTitle(targetMove[1]), action }
  }
  const targetExtrude = /^extrude\s+(.+?)\s+by\s+(.+)$/.exec(text)
  if (targetExtrude) {
    const depth = quantity(targetExtrude[2])
    if (depth !== undefined) return { kind: 'namedAction', name: stripTitle(targetExtrude[1]), action: { kind: 'extrude', depth } }
  }
  const targetAction = /^(delete|duplicate|split|cut)\s+(.+)$/.exec(text)
  if (targetAction) return { kind: 'namedAction', name: stripTitle(targetAction[2]), action: { kind: ['cut', 'split'].includes(targetAction[1]) ? 'cut' : targetAction[1] as 'delete' | 'duplicate' } }
  const along = /^(?:move along|constrain to|axis)\s+([xyz])$/.exec(text)
  if (along) return { kind: 'constraint', axis: axis(along[1]) }
  if (/^(clear constraint|free axis)$/.test(text)) return { kind: 'constraint' }
  const plane = /^(?:plane\s+(xy|xz|yz)|(xy|xz|yz)\s+plane)$/.exec(text)
  if (plane) return { kind: 'plane', plane: (plane[1] || plane[2]).toUpperCase() as PlaneName }
  if (/^(center(?:ed| it)?|centre(?:d| it)?|align (?:the )?centers)$/.test(text)) return { kind: 'align', mode: 'center' }
  if (/^(center|centre) on (?:the )?face$/.test(text)) return { kind: 'align', mode: 'face' }
  if (/^center on [xyz]$/.test(text)) return { kind: 'align', mode: axis(text.at(-1)!) }
  if (text === 'align left edges') return { kind: 'align', mode: 'left' }
  if (text === 'align top') return { kind: 'align', mode: 'top' }
  if (text === 'place flush') return { kind: 'align', mode: 'flush' }
  const view = /^(?:(?:show|switch to|go to) (?:the )?)?(front|back|left|right|top|bottom|isometric|reset) view$/.exec(text)
  if (view) return { kind: 'view', view: view[1] as ViewName }
  if (/^(?:fit(?: all| view| all objects)?|frame (?:everything|all)|show everything)$/.test(text)) return { kind: 'view', view: 'fit' }
  if (text === 'zoom in' || text === 'zoom out') return { kind: 'zoom', direction: text === 'zoom in' ? 1 : -1 }
  const format = /^(?:export(?: (?:as|to))?|save as) (?:an? )?(stl|s t l|step|s t e p)(?: file)?$/.exec(text)
  if (format) return { kind: 'export', format: format[1].replaceAll(' ', '') as 'stl' | 'step' }
  const units = /^(?:units|display units)\s+(\w+)$/.exec(text)
  if (units && Object.hasOwn(aliases, units[1])) return { kind: 'units', units: aliases[units[1]] }
  const tool = /^(?:draw |tool )?(select|point|line|polyline|ellipse|arc|move|rotate|scale|measure)$/.exec(text)
  if (tool) return { kind: 'tool', tool: tool[1] as Extract<Intent, { kind: 'tool' }>['tool'] }
}

export function primitiveFromIntent(intent: Extract<Intent, { kind: 'primitive' }>, initial: Primitive): Primitive {
  const primitive = { ...initial } as Primitive
  for (const [property, value] of Object.entries(intent.dimensions)) {
    const diameter = property === 'diameter' || property === 'innerDiameter' || (property === 'width' && 'radius' in primitive)
    const key = property === 'innerDiameter' ? 'innerRadius' : diameter ? 'radius' :
      primitive.kind === 'cube' && ['width', 'length', 'height'].includes(property) ? 'size' : property
    if (!(key in primitive)) throw new Error(property + ' is unavailable on a ' + primitive.kind + '.')
    ;(primitive as unknown as Record<string, unknown>)[key] = diameter ? value / 2 : value
  }
  return primitive
}
