export type Landmark = { x: number; y: number; z: number }
export type RawHand = { landmarks: Landmark[]; handedness: string; confidence: number }
export type Pose = 'open' | 'pinch' | 'fist' | 'point' | 'two' | 'scissors' | 'thumbs-up' | 'thumbs-down' | 'three' | 'horns' | 'shaka' | 'neutral'
export type ScreenPoint = [number, number]
export type TrackedHand = {
  id: number; pose: Pose; cursor: ScreenPoint; palm: ScreenPoint; landmarks: Landmark[];
  pinchRatio: number; scale: number; confidence: number; handedness: string;
}
export type Calibration = { min: ScreenPoint; max: ScreenPoint; handScale: number; closedPinch: number }
export type TrackingSettings = { mirror: boolean; pinch: number; smoothing: number; confidence: number; calibration?: Calibration }
export const baseTracking: TrackingSettings = { mirror: true, pinch: .29, smoothing: .68, confidence: .52 }
const distance2 = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a[0] - b[0], a[1] - b[1])
const delta = (a: Landmark, b: Landmark, aspect: number) => [(a.x - b.x) * aspect, a.y - b.y, (a.z - b.z) * aspect * .42]
const d = (a: Landmark, b: Landmark, aspect: number) => Math.hypot(...delta(a, b, aspect))
const center = (points: Landmark[]) => {
  const sum = points.reduce((out, p) => ({ x: out.x + p.x, y: out.y + p.y, z: out.z + p.z }), { x: 0, y: 0, z: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length }
}
const palm = (p: Landmark[]) => center([p[0], p[5], p[9], p[13], p[17]])
const xy = ({ x, y }: Landmark): ScreenPoint => [x, y]
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
const pinchThreshold = ({ calibration, pinch }: TrackingSettings) => calibration ? clamp((calibration.closedPinch + .16) * pinch / .29, .18, .48) : pinch

class SmoothedCoordinate {
  constructor(private value: number, private raw = value, private velocity = 0) {}
  update(raw: number, dt: number, smoothing: number) {
    const coefficient = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
    this.velocity += (coefficient(1.6)) * ((raw - this.raw) / dt - this.velocity)
    this.raw = raw
    const cutoff = 1 + 8 * (1 - smoothing) + 11 * Math.abs(this.velocity)
    this.value += coefficient(cutoff) * (raw - this.value)
    return this.value
  }
}

function isExtended(p: Landmark[], mcp: number, aspect: number) {
  const base = p[mcp], pip = p[mcp + 1], dip = p[mcp + 2], tip = p[mcp + 3]
  const proximal = delta(pip, base, aspect), distal = delta(tip, dip, aspect)
  const cosine = proximal.reduce((v, x, i) => v + x * distal[i], 0) / Math.max(1e-5, Math.hypot(...proximal) * Math.hypot(...distal))
  return cosine > .45 && d(tip, base, aspect) > .74 * (d(tip, dip, aspect) + d(dip, pip, aspect) + d(pip, base, aspect))
    && d(tip, p[0], aspect) > d(pip, p[0], aspect) * 1.02
}

export function classify(landmarks: Landmark[], aspect: number, settings: TrackingSettings, previous?: Pose) {
  const scale = Math.max(.015, (d(landmarks[0], landmarks[9], aspect) + d(landmarks[5], landmarks[17], aspect)) / 2)
  const pinchRatio = d(landmarks[4], landmarks[8], aspect) / scale
  const fingers = [5, 9, 13, 17].map(index => isExtended(landmarks, index, aspect))
  const [index, middle, ring, pinky] = fingers
  const count = fingers.filter(Boolean).length
  const spread = d(landmarks[8], landmarks[12], aspect) / scale
  const centerPalm = palm(landmarks)
  const thumbReach = d(landmarks[4], centerPalm, aspect) / scale
  const thumb = delta(landmarks[4], landmarks[2], aspect)
  const thumbStraight = Math.hypot(...thumb) > scale * .44 &&
    d(landmarks[4], landmarks[2], aspect) > .8 * (d(landmarks[2], landmarks[3], aspect) + d(landmarks[3], landmarks[4], aspect))
  const thumbVertical = Math.abs(thumb[1]) > Math.abs(thumb[0]) * 1.2 && Math.abs(thumb[1]) > scale * .36
  const curled = [5, 9, 13, 17].filter(i => d(landmarks[i + 3], centerPalm, aspect) < scale * .95).length
  const threshold = pinchThreshold(settings)
  let pose: Pose = 'neutral'
  if (count === 0 && curled >= 3 && thumbStraight && thumbVertical && thumbReach > .99) {
    pose = thumb[1] < 0 ? 'thumbs-up' : 'thumbs-down'
  } else if (count === 0 && curled >= 3 && thumbReach < 1.05) pose = 'fist'
  else if (pinchRatio < threshold * (previous === 'pinch' ? 1.45 : 1)) pose = 'pinch'
  else if (index && middle && ring && !pinky && curled >= 1) pose = 'three'
  else if (count >= 3) pose = 'open'
  else if (index && pinky && !middle && !ring && curled >= 2 && thumbReach < 1.16) pose = 'horns'
  else if (!index && !middle && !ring && pinky && curled >= 3 && thumbStraight && thumbReach > 1.02) pose = 'shaka'
  else if (index && middle && !ring && !pinky) {
    if (spread > (previous === 'scissors' ? .41 : .49)) pose = 'scissors'
    else if (spread < (previous === 'two' ? .44 : .38)) pose = 'two'
  } else if (index && !middle && !ring && !pinky) pose = 'point'
  return { pose, pinchRatio, scale }
}

type CursorAnchor = 'palm' | 'index' | 'pair' | 'hold'
type Cursor = { anchor: CursorAnchor; point: ScreenPoint; offset: ScreenPoint; palm: ScreenPoint }

function aim(pose: Pose, landmarks: Landmark[], palm: ScreenPoint, closing: boolean, dt: number, previous?: Cursor): Cursor {
  const anchor: CursorAnchor = pose === 'pinch' || pose === 'fist' || pose === 'neutral' || closing ? 'hold' :
    pose === 'point' ? 'index' : pose === 'two' || pose === 'scissors' ? 'pair' : 'palm'
  const target = anchor === 'index' ? xy(landmarks[8]) : anchor === 'pair' ? xy(center([landmarks[8], landmarks[12]])) : palm
  let offset: ScreenPoint = [0, 0]
  if (previous) {
    if (anchor !== previous.anchor) {
      // Carry the aim with the palm across pose changes, including the first frame of a pinch.
      offset = [previous.point[0] + palm[0] - previous.palm[0] - target[0], previous.point[1] + palm[1] - previous.palm[1] - target[1]]
    } else {
      // Follow whole-hand motion during a grip. Ease back to the aiming landmark after release.
      const remaining = anchor === 'hold' ? 1 : Math.exp(-Math.min(dt, .05) / .16)
      offset = [previous.offset[0] * remaining, previous.offset[1] * remaining]
    }
  }
  return { anchor, offset, palm, point: [target[0] + offset[0], target[1] + offset[1]] }
}

type Track = {
  id: number; raw: ScreenPoint; velocity: ScreenPoint; time: number; side: string;
  filters: SmoothedCoordinate[][]; pose: Pose; cursor?: Cursor;
}
export function screenPoint(p: ScreenPoint, settings: TrackingSettings): ScreenPoint {
  const { calibration } = settings
  const sx = settings.mirror ? 1 - p[0] : p[0]
  if (!calibration) return [(sx - .08) / .84, (p[1] - .1) / .8]
  const { min, max } = calibration
  return [(sx - min[0]) / (max[0] - min[0]), (p[1] - min[1]) / (max[1] - min[1])]
}

export class HandTracker {
  private next = 0
  private tracks: Track[] = []
  private lastFrame?: number

  reset() { this.tracks = []; this.lastFrame = undefined }

  update(hands: RawHand[], time: number, aspect: number, settings: TrackingSettings): TrackedHand[] {
    const lastFrame = this.lastFrame
    this.lastFrame = time
    this.tracks = this.tracks.filter(track => time - track.time < 480)
    const raw = hands.filter(h => h.landmarks.length === 21 && h.confidence >= settings.confidence &&
      h.landmarks.every(({ x, y, z }) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))).slice(0, 2)
    const centers = raw.map(h => xy(palm(h.landmarks)))
    const match = (index: number, track: Track | undefined) => {
      if (!track) return .32
      const elapsed = Math.min(100, time - track.time)
      const predicted: ScreenPoint = [track.raw[0] + track.velocity[0] * elapsed, track.raw[1] + track.velocity[1] * elapsed]
      const cost = distance2(centers[index], predicted) + (raw[index].handedness === track.side ? 0 : .08)
      return cost > .35 ? 1 : cost
    }
    let choice: (Track | undefined)[] = raw.map(() => undefined)
    const options = [...this.tracks, undefined]
    let best = Infinity
    for (const first of options) for (const second of raw.length === 2 ? options : [undefined]) {
      if (first && first === second) continue
      const cost = (raw.length ? match(0, first) : 0) + (raw.length > 1 ? match(1, second) : 0)
      if (cost < best) { best = cost; choice = [first, second] }
    }
    return raw.map((hand, index) => {
      const previous = choice[index]
      const current = centers[index]
      const dt = clamp((time - (previous?.time ?? time)) / 1000, .012, .18)
      const track: Track = previous ?? {
        id: ++this.next, raw: current, velocity: [0, 0], time, side: hand.handedness,
        filters: hand.landmarks.map(l => [l.x, l.y, l.z].map(n => new SmoothedCoordinate(n))), pose: 'neutral',
      }
      const filtered = hand.landmarks.map(({ x, y, z }, i) => ({
        x: track.filters[i][0].update(x, dt, settings.smoothing),
        y: track.filters[i][1].update(y, dt, settings.smoothing),
        z: track.filters[i][2].update(z, dt, settings.smoothing),
      }))
      // After a gap, the old filtered pose can still look held even if the hand opened out of view.
      const reacquired = previous && previous.time !== lastFrame
      const measured = classify(reacquired ? hand.landmarks : filtered, aspect, settings, track.pose)
      const palmPosition = xy(palm(filtered))
      // The raw fingertips may already be closing while the smoothed pose still says point.
      const closing = measured.pose === 'point' && d(hand.landmarks[4], hand.landmarks[8], aspect) < measured.scale * pinchThreshold(settings) * 1.45
      const cursor = aim(measured.pose, filtered, palmPosition, closing, dt, track.cursor)
      track.velocity = track.velocity.map((v, i) => .64 * v + .36 * (current[i] - track.raw[i]) / (dt * 1000)) as ScreenPoint
      track.raw = current
      track.time = time
      track.pose = measured.pose
      track.side = hand.handedness
      track.cursor = cursor
      if (!previous) this.tracks.push(track)
      return { ...measured, id: track.id, cursor: screenPoint(cursor.point, settings), palm: screenPoint(palmPosition, settings), landmarks: filtered, confidence: hand.confidence, handedness: hand.handedness }
    })
  }
}

export class CalibrationSession {
  step = 0
  count = 0
  private scale: number[] = []
  private pinches: number[] = []
  private edges: ScreenPoint[] = []

  update(hands: TrackedHand[], mirror: boolean): Calibration | undefined {
    if (hands.length !== 2) { this.count = 0; return }
    if (this.step === 0 && hands.every(h => h.pose === 'open')) {
      this.scale.push(...hands.map(h => h.scale))
      if (++this.count >= 12) { this.step++; this.count = 0 }
    } else if (this.step === 1 && hands.every(h => h.pose === 'pinch')) {
      this.pinches.push(...hands.map(h => h.pinchRatio))
      if (++this.count >= 12) { this.step++; this.count = 0 }
    } else if (this.step === 2 && distance2(hands[0].palm, hands[1].palm) > .23) {
      this.edges.push(...hands.map(h => {
        const { x, y } = palm(h.landmarks)
        return [mirror ? 1 - x : x, y] as ScreenPoint
      }))
      if (++this.count < 85) return
      const range = (i: number, spread: number): [number, number] => {
        const values = this.edges.map(p => p[i]).sort((a, b) => a - b)
        const lo = values[Math.floor(values.length * .02)] - .06
        const hi = values[Math.floor(values.length * .98)] + .06
        const center = (hi + lo) / 2
        return [clamp(Math.min(lo, center - spread / 2), .025, .65), clamp(Math.max(hi, center + spread / 2), .35, .975)]
      }
      const [l, r] = range(0, .45), [t, b] = range(1, .45)
      this.step++
      return {
        min: [l, t], max: [r, b],
        handScale: this.scale.reduce((a, b) => a + b, 0) / this.scale.length,
        closedPinch: this.pinches.reduce((a, b) => a + b, 0) / this.pinches.length,
      }
    } else if (this.step < 2) this.count = 0
  }
}
