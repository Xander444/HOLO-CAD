import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceDock } from '../src/components/VoiceDock'
import { VoiceSession } from '../src/voice/speech'
import type { SpeechEngine, VoiceStatus } from '../src/voice/speech'
import { defaults, readSettings, storeSettings } from '../src/interactions/settings'

function fixture(initial: 'available' | 'downloadable' | 'unavailable' = 'available') {
  const statuses: VoiceStatus[] = []
  const transcripts: [string, number][] = []
  const engines: TestEngine[] = []
  let now = 0
  let order = 0
  const tasks = new Map<number, { at: number; fire: () => void }>()
  const prompts: { message: string; finish: () => void }[] = []
  let downloads = 0
  let localStatus = initial

  class TestEngine implements SpeechEngine {
    static available() { return Promise.resolve(localStatus) }
    static install() { downloads++; localStatus = 'available'; return Promise.resolve(true) }
    lang = ''
    interimResults = false
    continuous = false
    processLocally = false
    onstart: SpeechEngine['onstart'] = null
    onresult: SpeechEngine['onresult'] = null
    onerror: SpeechEngine['onerror'] = null
    onend: SpeechEngine['onend'] = null
    aborted = false
    constructor() { engines.push(this) }
    start() { this.onstart?.() }
    abort() { this.aborted = true; this.onend?.() }
    result(text: string, confidence = .94) {
      this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text, confidence } }] })
    }
  }

  const runtime = {
    recognition: () => TestEngine,
    secure: () => true,
    schedule(fire: () => void, delay: number) {
      const id = ++order
      tasks.set(id, { at: now + delay, fire })
      return () => { tasks.delete(id) }
    },
    speak(message: string, finish: () => void) { prompts.push({ message, finish }); return true },
    cancelSpeech() {},
  }
  const tick = (ms: number) => {
    const end = now + ms
    while (tasks.size) {
      const [id, target] = [...tasks.entries()].sort(([, a], [, b]) => a.at - b.at)[0]
      if (target.at > end) break
      now = target.at
      tasks.delete(id)
      target.fire()
    }
    now = end
  }
  const voice = new VoiceSession((...args) => transcripts.push(args), status => statuses.push(status), runtime)
  return { voice, runtime, tick, statuses, engines, transcripts, prompts, downloads: () => downloads }
}

test('voice starts in continuous mode and automatically resumes after silence and browser session end', async () => {
  const f = fixture()
  assert.equal(defaults.voiceMuted, false)
  await f.voice.start({ allowBrowser: false })
  assert.deepEqual(f.statuses.at(-1), { kind: 'listening', provider: 'on-device' })
  assert.equal(f.engines[0].continuous, true)
  assert.equal(f.engines[0].processLocally, true)
  f.engines[0].result('select the collar')
  assert.deepEqual(f.transcripts, [['select the collar', .94]])
  f.engines[0].onend?.()
  assert.equal(f.statuses.at(-1)?.kind, 'reconnecting')
  f.tick(400)
  f.engines[1].onerror?.({ error: 'no-speech' })
  f.tick(500)
  assert.equal(f.engines.length, 3)
  assert.equal(f.statuses.at(-1)?.kind, 'listening')
})

test('mute cancels restart timers and stale recognition events', async () => {
  const f = fixture()
  await f.voice.start({ allowBrowser: false })
  const lateResult = f.engines[0].onresult
  f.engines[0].onend?.()
  f.voice.mute()
  f.tick(20000)
  lateResult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'delete it', confidence: 1 } }] })
  assert.equal(f.engines[0].aborted, true)
  assert.equal(f.engines.length, 1)
  assert.equal(f.transcripts.length, 0)
  assert.equal(f.statuses.at(-1)?.kind, 'muted')
  await f.voice.start({ allowBrowser: false })
  assert.equal(f.engines.length, 2)
})

test('muting while the browser checks local recognition prevents a later start', async () => {
  const f = fixture()
  const initializing = f.voice.start({ allowBrowser: false })
  f.voice.mute()
  await initializing
  assert.equal(f.engines.length, 0)
  assert.equal(f.statuses.at(-1)?.kind, 'muted')
})

test('setting up on-device speech avoids cloud recognition, and browser speech requires opt-in', async () => {
  const f = fixture('downloadable')
  await f.voice.start({ allowBrowser: false })
  assert.equal(f.statuses.at(-1)?.kind, 'setup')
  assert.equal(f.engines.length, 0)
  assert.equal(f.downloads(), 0)
  await f.voice.start({ allowBrowser: false, installLocal: true })
  assert.equal(f.downloads(), 1)
  assert.equal(f.engines[0].processLocally, true)

  const remote = fixture('unavailable')
  await remote.voice.start({ allowBrowser: false })
  assert.equal(remote.engines.length, 0)
  await remote.voice.start({ allowBrowser: true })
  assert.equal(remote.engines[0].processLocally, false)
  assert.deepEqual(remote.statuses.at(-1), { kind: 'listening', provider: 'browser' })
})

test('the assistant stops the recognizer for prompts, resumes afterward, and honors a subsequent mute', async () => {
  const f = fixture()
  await f.voice.start({ allowBrowser: false })
  const stale = f.engines[0].onresult
  f.voice.say('Confirm the split?', true)
  assert.equal(f.engines[0].aborted, true)
  assert.equal(f.statuses.at(-1)?.kind, 'speaking')
  stale?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'confirm', confidence: 1 } }] })
  assert.equal(f.transcripts.length, 0)
  f.prompts[0].finish()
  f.tick(400)
  assert.equal(f.engines.length, 2)
  f.voice.say('What height?', true)
  f.voice.mute()
  f.prompts[1].finish()
  f.tick(20_000)
  assert.equal(f.engines.length, 2)
  assert.equal(f.statuses.at(-1)?.kind, 'muted')
})

test('a new size question replaces stale speech and can start during microphone recovery', async () => {
  const f = fixture()
  await f.voice.start({ allowBrowser: false })
  f.voice.say('How wide should the box be?', true)
  f.voice.say('How long should the box be?', true)
  f.prompts[0].finish()
  f.tick(400)
  assert.equal(f.engines.length, 1)
  assert.equal(f.statuses.at(-1)?.kind, 'speaking')
  f.prompts[1].finish()
  assert.equal(f.statuses.at(-1)?.kind, 'reconnecting')
  f.voice.say('How tall should the box be?', true)
  assert.equal(f.prompts.length, 3)
  f.voice.stopSpeaking()
  f.prompts[2].finish()
  f.tick(400)
  assert.equal(f.engines.length, 2)
  assert.equal(f.statuses.at(-1)?.kind, 'listening')
})

test('permission denial stays paused until an explicit retry', async () => {
  const f = fixture()
  await f.voice.start({ allowBrowser: false })
  f.engines[0].onerror?.({ error: 'not-allowed' })
  f.tick(60_000)
  assert.equal(f.engines.length, 1)
  assert.equal(f.statuses.at(-1)?.kind, 'blocked')
  await f.voice.start({ allowBrowser: false })
  assert.equal(f.engines.length, 2)
})

test('the saved mute and panel preferences survive reloading settings', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } })
  try {
    assert.equal(readSettings().voiceMuted, false)
    assert.equal(readSettings().showTools, false)
    assert.equal(readSettings().showObjects, false)
    storeSettings({ ...defaults, voiceMuted: true, showObjects: true })
    assert.equal(readSettings().voiceMuted, true)
    assert.equal(readSettings().showObjects, true)
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('the voice dock leaves mute, permission setup, and typed controls discoverable', () => {
  const control = (status: VoiceStatus) => renderToStaticMarkup(createElement(VoiceDock, {
    status, muted: status.kind === 'muted', input: createRef<HTMLInputElement>(), transcript: '', suggestions: ['Create a cube'],
    submit() {}, toggleMute() {}, setup() {}, enable() {}, actions: null,
  }))
  const setup = control({ kind: 'setup', local: true, message: 'Install the English speech pack.' })
  assert.match(setup, /aria-label="Mute microphone"/)
  assert.match(setup, /Voice setup/)
  assert.match(setup, /CAD command/)
  assert.match(control({ kind: 'muted' }), /aria-label="Unmute microphone"/)
  assert.match(control({ kind: 'listening', provider: 'on-device' }), /Speech stays on this device/)
})
