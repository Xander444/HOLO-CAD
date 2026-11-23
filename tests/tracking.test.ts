import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HandTracker, baseTracking, classify } from '../src/vision/tracking'
import type { Landmark, RawHand } from '../src/vision/tracking'

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

test('landmark geometry classifies open and pinching hands with release hysteresis', () => {
  assert.equal(classify(landmarkHand(.55, 'Left').landmarks, 1, baseTracking).pose, 'open')
  const fixture = landmarkHand(.55, 'Left', true)
  assert.equal(classify(fixture.landmarks, 1, baseTracking).pose, 'pinch')
  const middle = fixture.landmarks[8]
  fixture.landmarks[4] = { ...middle, x: middle.x - .039 }
  assert.notEqual(classify(fixture.landmarks, 1, baseTracking).pose, 'pinch')
  assert.equal(classify(fixture.landmarks, 1, baseTracking, 'pinch').pose, 'pinch')
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
  return classify(pose, 1, baseTracking).pose
}

test('new hand poses separate thumb direction, three fingers, horns, shaka, and pointing', () => {
  assert.equal(foldedHand([], 'up'), 'thumbs-up')
  assert.equal(foldedHand([], 'down'), 'thumbs-down')
  assert.equal(foldedHand([5, 9, 13], 'out'), 'three')
  assert.equal(foldedHand([5, 17], 'in'), 'horns')
  assert.equal(foldedHand([17], 'out'), 'shaka')
  assert.equal(foldedHand([5], 'out'), 'point')
})
