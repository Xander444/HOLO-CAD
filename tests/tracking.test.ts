import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GestureEngine } from '../src/gestures/engine'
import type { Event } from '../src/gestures/engine'
import { HandTracker, baseTracking, classify, screenPoint } from '../src/vision/tracking'
import type { Landmark, RawHand, ScreenPoint, TrackingSettings } from '../src/vision/tracking'

function landmarkHand(x: number, handedness: string, pinch = false): RawHand {
  const at = (dx: number, y: number): Landmark => ({ x: x + dx, y, z: 0 })
  const fingers = [-.055, -.018, .019, .054].flatMap((dx, i) => {
    const base = .52 + Math.abs(i - 1) * .013
    return [at(dx, base), at(dx * 1.07, base - .047), at(dx * 1.13, base - .082), at(dx * 1.17, base - .117)]
  })
  const landmarks = [at(0, .66), at(-.038, .615), at(-.082, .569), at(-.123, .54), at(-.163, .52), ...fingers]
  if (pinch) landmarks[4] = at(-.052, landmarks[8].y + .006)
  return { landmarks, handedness, confidence: .98 }
}

function closingHand(x: number, handedness: string, amount: number) {
  const hand = landmarkHand(x, handedness)
  const tip = { x: x - .093, y: .455, z: -.02 }
  const thumb = { ...tip, x: tip.x - .008, y: tip.y + .006 }
  for (const [i, end] of [[4, thumb], [8, tip]] as const) {
    const start = hand.landmarks[i]
    hand.landmarks[i] = {
      x: start.x + (end.x - start.x) * amount,
      y: start.y + (end.y - start.y) * amount,
      z: start.z + (end.z - start.z) * amount,
    }
  }
  if (handedness === 'Right') for (const point of hand.landmarks) point.x = 2 * x - point.x
  return hand
}

function distance(a: ScreenPoint, b: ScreenPoint) {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

test('landmark geometry classifies open and pinching hands with release hysteresis', () => {
  assert.equal(classify(landmarkHand(.55, 'Left').landmarks, 1, baseTracking).pose, 'open')
  const fixture = landmarkHand(.55, 'Left', true)
  assert.equal(classify(fixture.landmarks, 1, baseTracking).pose, 'pinch')
  const middle = fixture.landmarks[8]
  fixture.landmarks[4] = { ...middle, x: middle.x - .039 }
  assert.notEqual(classify(fixture.landmarks, 1, baseTracking).pose, 'pinch')
  assert.equal(classify(fixture.landmarks, 1, baseTracking, 'pinch').pose, 'pinch')
})

test('closing and opening a pinch keeps the stationary cursor on its target for either hand and mirror setting', () => {
  for (const mirror of [false, true]) for (const side of ['Left', 'Right']) {
    const tracker = new HandTracker()
    const settings = { ...baseTracking, mirror }
    let time = 0
    const frame = (x: number, amount: number) => tracker.update([closingHand(x, side, amount)], time += 34, 4 / 3, settings)[0]
    const aim = frame(.5, 0)
    for (const amount of [.2, .5, .8, 1, 1, 1, 1, 1, 1, 1]) frame(.5, amount)
    const pinched = frame(.5, 1)
    assert.equal(pinched.pose, 'pinch')
    assert.ok(distance(pinched.cursor, aim.cursor) < .007, `${side} mirror=${mirror}: ${aim.cursor} → ${pinched.cursor}`)

    for (let i = 1; i <= 10; i++) frame(.5 + .012 * i, 1)
    const moved = frame(.62, 1)
    assert.ok((moved.cursor[0] - pinched.cursor[0]) * (mirror ? -1 : 1) > .11)
    const invalid = closingHand(.62, side, 1)
    invalid.landmarks[4].x = NaN
    assert.deepEqual(tracker.update([invalid], time += 34, 4 / 3, settings), [])
    const recovered = frame(.62, 1)
    assert.equal(recovered.id, aim.id)
    assert.equal(recovered.pose, 'pinch')
    for (const amount of [1, .7, .3, 0, 0, 0, 0, 0, 0, 0]) {
      const hand = frame(.62, amount)
      assert.ok(distance(hand.cursor, recovered.cursor) < .02)
    }
    assert.equal(frame(.62, 0).pose, 'open')
  }
})

function selectByPinch(keptHolding: boolean) {
  const tracker = new HandTracker()
  const events: Event[] = []
  const engine = new GestureEngine(event => events.push(event))
  const settings: TrackingSettings = { ...baseTracking, calibration: { min: [.13, .12], max: [.84, .88], closedPinch: .12, handScale: .16 } }
  let time = 100
  const target = tracker.update([closingHand(.41, 'Right', 0)], time, 1, settings)[0].cursor
  const frame = (amount?: number) => engine.update(
    tracker.update(amount === undefined ? [] : [closingHand(.41, 'Right', amount)], time += 34, 1, settings),
    time, { dwell: 150, cooldown: 270, sensitivity: 1 }, {
      allowLine: false, allowOrbit: false,
      hit: point => distance(point, target) < .02 ? { mode: 'select', target: 'aimed part' } : undefined,
    },
  )
  for (const amount of [.2, .4, .6, .8]) frame(amount)
  for (let i = 0; i < 18; i++) frame(1)
  frame()
  for (let i = 0; i < 4; i++) frame(keptHolding ? 1 : .68)
  for (let i = 0; i < 12; i++) frame(0)
  return { events, target }
}

test('the gesture engine selects the target under the initial cursor through a pinch and brief missed frame', () => {
  const { events, target } = selectByPinch(true)
  const start = events.find(event => event.type === 'start')
  const end = events.find(event => event.type === 'end')
  assert.equal(start?.target, 'aimed part')
  assert.ok(events.some(event => event.type === 'freeze'))
  assert.ok(end && distance(end.points[0], target) < .02)
})

test('releasing the pinch while the hand is hidden cancels selection', () => {
  const { events } = selectByPinch(false)
  assert.ok(events.some(event => event.type === 'freeze'))
  assert.ok(events.some(event => event.type === 'cancel'))
  assert.ok(!events.some(event => event.type === 'end'))
})

test('hand identity survives crossed positions, changing result order, and a brief missing frame', () => {
  const tracker = new HandTracker()
  const initial = tracker.update([landmarkHand(.29, 'Left'), landmarkHand(.72, 'Right')], 100, 1, baseTracking)
  const left = initial[0].id
  const right = initial[1].id
  for (let i = 1; i <= 13; i++) {
    const a = landmarkHand(.29 + i * .031, 'Left')
    const b = landmarkHand(.72 - i * .031, 'Right')
    const sequence = i % 2 ? [b, a] : [a, b]
    if (i === 5) sequence.splice(0, 1)
    const detected = tracker.update(sequence, 100 + i * 40, 1, baseTracking)
    for (const h of detected) assert.equal(h.id, h.handedness === 'Left' ? left : right)
  }
})

function foldedHand(extended: number[], thumb: 'up' | 'down' | 'in' | 'out') {
  const pose = landmarkHand(.55, 'Right').landmarks
  for (const index of [5, 9, 13, 17]) {
    if (extended.includes(index)) continue
    const { x, y } = pose[index]
    pose[index + 1] = { x, y: y - .03, z: 0 }
    pose[index + 2] = { x: x + .01, y: y - .009, z: 0 }
    pose[index + 3] = { x: x + .012, y: y + .033, z: 0 }
  }
  if (thumb === 'up' || thumb === 'down') {
    const direction = thumb === 'up' ? -1 : 1
    for (let i = 0; i < 3; i++) pose[2 + i] = { x: .46, y: .55 + i * .083 * direction, z: 0 }
  } else if (thumb === 'in') pose[4] = { x: .538, y: .62, z: 0 }
  return { landmarks: pose, handedness: 'Right', confidence: .98 }
}

test('new hand poses separate thumb direction, three fingers, horns, shaka, and pointing', () => {
  const pose = (hand: RawHand) => classify(hand.landmarks, 1, baseTracking).pose
  assert.equal(pose(foldedHand([], 'up')), 'thumbs-up')
  assert.equal(pose(foldedHand([], 'down')), 'thumbs-down')
  assert.equal(pose(foldedHand([5, 9, 13], 'out')), 'three')
  assert.equal(pose(foldedHand([5, 17], 'in')), 'horns')
  assert.equal(pose(foldedHand([17], 'out')), 'shaka')
  assert.equal(pose(foldedHand([5], 'out')), 'point')
})

test('pointing reaches the precise fingertip aim and keeps that point when the fingers close', () => {
  const tracker = new HandTracker()
  let time = 0
  const frame = (hand: RawHand) => tracker.update([hand], time += 34, 1, baseTracking)[0]
  const pointing = foldedHand([5], 'out')
  const tip = pointing.landmarks[8]
  const target = screenPoint([tip.x, tip.y], baseTracking)
  let hand = frame(landmarkHand(.55, 'Right'))
  for (let i = 0; i < 27; i++) hand = frame(pointing)
  assert.equal(hand.pose, 'point')
  assert.ok(distance(hand.cursor, target) < .002)

  const closing = foldedHand([5], 'out')
  closing.landmarks[8] = { ...tip, x: tip.x - .023, y: tip.y + .023 }
  closing.landmarks[4] = { ...closing.landmarks[8], x: closing.landmarks[8].x - .007 }
  for (let i = 0; i < 12; i++) {
    hand = frame(closing)
    assert.ok(distance(hand.cursor, target) < .006, `${hand.pose}: ${hand.cursor} vs ${target}`)
  }
  assert.equal(hand.pose, 'pinch')
})
