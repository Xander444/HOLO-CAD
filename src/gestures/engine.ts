import type { Pose, ScreenPoint, TrackedHand } from '../vision/tracking'

export type GestureMode = 'line' | 'rectangle' | 'extrude' | 'grab' | 'orbit' | 'scissors' | 'select'
export type HandSign = 'confirm' | 'cancel' | 'fit' | 'undo' | 'redo' | 'select'
export type Event =
  | { type: 'sign'; sign: HandSign; target?: string }
  | { type: 'start'; mode: GestureMode; points: ScreenPoint[]; target?: string }
  | { type: 'update'; mode: GestureMode; points: ScreenPoint[]; time: number }
  | { type: 'end'; mode: GestureMode; points: ScreenPoint[] }
  | { type: 'freeze'; mode: GestureMode }
  | { type: 'cancel'; mode: GestureMode; reason: string }
export type GestureOptions = { dwell: number; cooldown: number; sensitivity: number }
export type Context = {
  allowLine: boolean
  allowOrbit: boolean
  hit: (point: ScreenPoint, pose: Pose) => { mode: GestureMode; target: string } | undefined
  sign?: (point: ScreenPoint, pose: Pose) => { sign: HandSign; target?: string } | undefined
}
type Pending = { signature: string; since: number }
type Active = {
  mode: GestureMode; ids: number[]; points: ScreenPoint[]; start: ScreenPoint[];
  began: number; maxMovement: number; release?: number; partial?: number; lost?: number; startSpread: number;
}

const distance = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a[0] - b[0], a[1] - b[1])
const span = (p: ScreenPoint[]) => p.length === 2 ? distance(p[0], p[1]) : 0
const holding = (mode: GestureMode, pose: Pose) => {
  if (mode === 'grab') return pose === 'fist'
  if (mode === 'scissors') return pose === 'scissors'
  if (mode === 'orbit') return pose === 'two'
  return pose === 'pinch'
}

export class GestureEngine {
  private pending?: Pending
  private active?: Active
  private coolingUntil = 0
  private open = new Map<number, { time: number; palm: ScreenPoint }>()
  private paths = new Map<number, { t: number; p: ScreenPoint }[]>()
  private heldSign?: { key: string; since: number; palm: ScreenPoint }
  private releasedSigns = new Map<number, { pose: Pose; since?: number }>()

  constructor(private emit: (event: Event) => void) {}

  reset(time: number, reason = 'Interaction cancelled') {
    if (this.active) this.emit({ type: 'cancel', mode: this.active.mode, reason })
    this.active = undefined
    this.pending = undefined
    this.heldSign = undefined
    this.open.clear()
    this.paths.clear()
    this.coolingUntil = time + 200
  }

  private start(mode: GestureMode, ids: number[], points: ScreenPoint[], time: number, target?: string) {
    this.active = { mode, ids, points, start: points, began: time, maxMovement: 0, startSpread: span(points) }
    this.pending = undefined
    this.emit({ type: 'start', mode, points, target })
  }

  private dwell(signature: string, time: number, duration: number) {
    if (this.pending?.signature === signature) return time - this.pending.since >= duration
    this.pending = { signature, since: time }
    return false
  }

  private travel(hand: TrackedHand, time: number, movement: number) {
    const path = (this.paths.get(hand.id) ?? []).filter(p => p.t > time - 680)
    path.push({ t: time, p: hand.cursor })
    this.paths.set(hand.id, path)
    if (path.length < 6) return false
    const a = path[0].p, b = path[Math.floor(path.length / 2)].p, c = hand.cursor
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]]
    const length = Math.hypot(...u) * Math.hypot(...v)
    return distance(a, b) > movement * .54 && distance(b, c) > movement * .44 &&
      length > 0 && Math.abs(u[0] * v[1] - u[1] * v[0]) / length > .26
  }

  private recognizeSign(hands: TrackedHand[], time: number, options: GestureOptions, context: Context) {
    const candidates = this.active ? hands.filter(h => this.active!.ids.includes(h.id) && h.pose === 'thumbs-down') : hands
    for (const hand of candidates) {
      const result = context.sign?.(hand.cursor, hand.pose)
      if (!result || this.releasedSigns.has(hand.id)) continue
      const key = [hand.id, result.sign, result.target].join(':')
      const held = this.heldSign
      if (!held || held.key !== key || distance(held.palm, hand.palm) > .075) {
        this.heldSign = { key, since: time, palm: hand.palm }
        return true
      }
      if (time - held.since < Math.max(560, options.dwell * 2.6)) return true
      this.heldSign = undefined
      this.pending = undefined
      this.active = undefined
      this.releasedSigns.set(hand.id, { pose: hand.pose })
      this.coolingUntil = time + options.cooldown
      this.emit({ type: 'sign', ...result })
      return true
    }
    this.heldSign = undefined
    return false
  }

  update(hands: TrackedHand[], time: number, options: GestureOptions, context: Context) {
    for (const [id, sample] of this.open) if (time - sample.time > 920) this.open.delete(id)
    for (const [id, path] of this.paths) if (time - path.at(-1)!.t > 680) this.paths.delete(id)
    for (const [id, latch] of this.releasedSigns) {
      const hand = hands.find(h => h.id === id)
      if (hand?.pose === latch.pose) latch.since = undefined
      else {
        latch.since ??= time
        if (time - latch.since > (hand ? 160 : 500)) this.releasedSigns.delete(id)
      }
    }
    for (const hand of hands) if (hand.pose === 'open') this.open.set(hand.id, { time, palm: hand.palm })
    const move = .027 / options.sensitivity
    if (this.active) {
      const a = this.active
      const tracked = a.ids.map(id => hands.find(h => h.id === id))
      if (tracked.some(h => !h)) {
        if (a.lost === undefined) { a.lost = time; this.emit({ type: 'freeze', mode: a.mode }) }
        if (time - a.lost > 300) this.reset(time, 'Tracking lost. Preview discarded.')
        return
      }
      const present = tracked as TrackedHand[]
      const poses = present.map(h => h.pose)
      const held = poses.map(p => holding(a.mode, p))
      if (a.lost !== undefined) {
        if (time - a.lost > 300 || !held.every(Boolean)) { this.reset(time, 'Tracking was interrupted. Try the gesture again.'); return }
        a.lost = undefined
      }
      if (this.recognizeSign(present, time, options, context)) { a.release = undefined; return }
      const screen = present.map(h => h.cursor)
      if (held.every(Boolean)) {
        a.release = undefined
        a.partial = undefined
        a.points = screen
        const displacement = a.mode === 'line' ? span(screen) - a.startSpread : distance(screen[0], a.start[0])
        a.maxMovement = Math.max(a.maxMovement, displacement)
        this.emit({ type: 'update', mode: a.mode, points: screen, time })
        return
      }
      if (a.mode === 'line' && held.some(Boolean)) {
        a.release = undefined
        a.partial ??= time
        if (time - a.partial > 360) this.reset(time, 'Release both pinches together to finish the line.')
        return
      }
      if (a.mode === 'scissors' && poses[0] !== 'two') {
        a.release = undefined
        a.partial ??= time
        if (time - a.partial > 165) this.reset(time, 'Close the two extended fingers to confirm the cut.')
        return
      }
      if (a.mode === 'grab' && poses[0] !== 'open') {
        a.release = undefined
        a.partial ??= time
        if (time - a.partial > 230) this.reset(time, 'Open the grabbing hand to place the object.')
        return
      }
      a.release ??= time
      if (time - a.release < 76) return
      const moved = a.mode === 'select' ? a.maxMovement < .065 : a.mode === 'orbit' || a.maxMovement >= move
      this.active = undefined
      this.coolingUntil = time + options.cooldown
      if (moved && time - a.began > 105) this.emit({ type: 'end', mode: a.mode, points: a.points })
      else this.emit({ type: 'cancel', mode: a.mode, reason: 'Gesture ended before it moved far enough.' })
      return
    }
    if (time < this.coolingUntil) return
    const pinches = hands.filter(h => h.pose === 'pinch').sort((a, b) => a.id - b.id)
    if (context.allowLine && pinches.length === 2) {
      this.heldSign = undefined
      const ids = pinches.map(h => h.id)
      if (this.dwell('line:' + ids.join(','), time, options.dwell)) this.start('line', ids, pinches.map(h => h.cursor), time)
      return
    }
    if (this.recognizeSign(hands, time, options, context)) return
    for (const hand of hands) {
      if (hand.pose !== 'two') this.paths.delete(hand.id)
      const { pose, id } = hand
      if (pose === 'two' && context.allowOrbit && this.travel(hand, time, move)) {
        this.start('orbit', [id], [hand.cursor], time)
        return
      }
      if (!['pinch', 'fist', 'scissors'].includes(pose)) continue
      const point = hand.cursor
      const opened = this.open.get(id)
      if (pose === 'fist' && (!opened || time - opened.time > 800 || distance(opened.palm, hand.palm) > .17)) continue
      const hit = context.hit(point, pose)
      if (!hit) continue
      const delay = pose === 'pinch' ? options.dwell + 135 : options.dwell
      if (this.dwell(hit.mode + ':' + id + ':' + hit.target, time, delay)) this.start(hit.mode, [id], [point], time, hit.target)
      return
    }
    this.pending = undefined
  }
}
