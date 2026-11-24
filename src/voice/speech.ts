type LocalSpeech = 'unavailable' | 'downloadable' | 'downloading' | 'available'
type SpeechOption = { langs: string[]; processLocally: boolean }
type SpeechResult = { isFinal: boolean; 0: { transcript: string; confidence: number } }

export type SpeechEngine = {
  lang: string
  interimResults: boolean
  continuous: boolean
  processLocally?: boolean
  onstart: (() => void) | null
  onresult: ((e: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  abort(): void
}
type SpeechConstructor = {
  new(): SpeechEngine
  available?(options: SpeechOption): Promise<LocalSpeech>
  install?(options: SpeechOption): Promise<boolean>
}
type Provider = 'on-device' | 'browser'
export type VoiceStatus =
  | { kind: 'muted' | 'starting' | 'speaking' | 'reconnecting' }
  | { kind: 'listening'; provider: Provider }
  | { kind: 'setup'; local: boolean; message: string }
  | { kind: 'blocked' | 'unsupported'; message: string }

type Runtime = {
  recognition(): SpeechConstructor | undefined
  secure(): boolean
  schedule(action: () => void, delay: number): () => void
  speak(message: string, finished: () => void): boolean
  cancelSpeech(): void
}

const language = 'en-US'
const localOptions = { langs: [language], processLocally: true }
const browserRuntime: Runtime = {
  recognition() {
    const host = window as Window & { SpeechRecognition?: SpeechConstructor; webkitSpeechRecognition?: SpeechConstructor }
    return host.SpeechRecognition ?? host.webkitSpeechRecognition
  },
  secure: () => window.isSecureContext,
  schedule(action, delay) {
    const timer = setTimeout(action, delay)
    return () => clearTimeout(timer)
  },
  speak(message, finished) {
    if (!window.speechSynthesis) return false
    const utterance = new SpeechSynthesisUtterance(message)
    utterance.lang = language
    utterance.rate = 1.05
    utterance.onend = finished
    utterance.onerror = finished
    window.speechSynthesis.speak(utterance)
    return true
  },
  cancelSpeech() { window.speechSynthesis?.cancel() },
}

export class VoiceSession {
  private engine?: SpeechEngine
  private connection?: { recognition: SpeechConstructor; provider: Provider }
  private generation = 0
  private requested = false
  private speaking = false
  private speechSequence = 0
  private failures = 0
  private retry?: () => void
  private startTimeout?: () => void
  private speechTimeout?: () => void

  constructor(
    private transcript: (text: string, confidence: number) => void,
    private status: (value: VoiceStatus) => void,
    private runtime = browserRuntime,
  ) {}

  async start({ allowBrowser, installLocal = false }: { allowBrowser: boolean; installLocal?: boolean }) {
    this.reset()
    this.requested = true
    const id = this.generation
    if (!this.runtime.secure()) {
      this.status({ kind: 'unsupported', message: 'Open HOLO-CAD on localhost or HTTPS for microphone access.' })
      return
    }
    const recognition = this.runtime.recognition()
    if (!recognition) {
      this.status({ kind: 'unsupported', message: 'This browser has no speech recognition. Type your commands here.' })
      return
    }
    this.status({ kind: 'starting' })
    let available: LocalSpeech = 'unavailable'
    // Call install directly from the setup action while browser user activation is available.
    if (installLocal && recognition.install) {
      try {
        if (await recognition.install(localOptions)) available = 'available'
      } catch { /* A denied or interrupted download can be retried from the dock. */ }
    }
    if (id !== this.generation) return
    if (available !== 'available' && recognition.available) {
      try { available = await recognition.available(localOptions) }
      catch { /* This browser or its permissions policy may restrict local speech. */ }
    }
    if (id !== this.generation) return
    if (available === 'available') {
      this.connection = { recognition, provider: 'on-device' }
    } else if (allowBrowser) {
      this.connection = { recognition, provider: 'browser' }
    } else {
      this.status({
        kind: 'setup',
        local: available === 'downloadable' && !!recognition.install,
        message: available === 'downloadable' && recognition.install ? 'Install the English speech pack to listen on this device.' :
          available === 'downloading' ? 'The browser is downloading the English speech pack. Check again when it finishes.' :
            'Set up browser speech to use the microphone on this browser.',
      })
      return
    }
    this.connect()
  }

  private connect() {
    const { connection } = this
    if (!this.requested || !connection || this.speaking) return
    this.disconnect()
    try {
      const engine = new connection.recognition()
      this.engine = engine
      engine.lang = language
      engine.continuous = true
      engine.interimResults = false
      if (connection.provider === 'on-device' && !('processLocally' in engine)) {
        this.block('This browser could not require on-device recognition. Open voice setup for other options.')
        return
      }
      if ('processLocally' in engine) engine.processLocally = connection.provider === 'on-device'
      engine.onstart = () => {
        if (this.engine !== engine || this.speaking) return
        this.startTimeout?.()
        this.status({ kind: 'listening', provider: connection.provider })
      }
      engine.onresult = event => {
        if (this.engine !== engine || this.speaking || !this.requested) return
        this.failures = 0
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          if (this.engine !== engine || this.speaking || !this.requested) break
          if (result.isFinal && result[0]) {
            const confidence = result[0].confidence
            this.transcript(result[0].transcript, Number.isFinite(confidence) ? confidence : 0)
          }
        }
      }
      engine.onend = () => {
        if (this.engine === engine) this.reconnect(300)
      }
      engine.onerror = ({ error }) => {
        if (this.engine !== engine) return
        if (error === 'no-speech' || error === 'aborted') { this.reconnect(400); return }
        if (error === 'network' && ++this.failures <= 4) { this.reconnect(650 * 2 ** (this.failures - 1)); return }
        if (error === 'language-not-supported' && connection.provider === 'on-device') {
          this.disconnect()
          this.status({ kind: 'setup', local: !!connection.recognition.install, message: 'The English speech pack is unavailable. Open voice setup to choose a recognizer.' })
          return
        }
        this.block(error === 'not-allowed' || error === 'service-not-allowed' ?
          'Click Enable mic and allow microphone access if your browser asks.' :
          error === 'audio-capture' ? 'Check your microphone connection, then enable it again.' :
            'Speech recognition paused. Try enabling the microphone again.')
      }
      this.startTimeout = this.runtime.schedule(() => {
        if (this.engine === engine) this.block('Waiting for microphone access. Click Enable mic to try again.')
      }, 20_000)
      engine.start()
    } catch { this.block('Click Enable mic to start listening in this browser.') }
  }

  private reconnect(delay: number) {
    this.disconnect()
    if (!this.requested || this.speaking) return
    this.cancelRetry()
    this.status({ kind: 'reconnecting' })
    this.retry = this.runtime.schedule(() => {
      this.retry = undefined
      this.connect()
    }, delay)
  }

  private block(message: string) {
    this.cancelRetry()
    this.disconnect()
    this.status({ kind: 'blocked', message })
  }

  say(message: string, enabled: boolean) {
    if (!enabled || !this.requested || !this.connection || !(this.engine || this.speaking || this.retry)) return
    const sequence = ++this.speechSequence
    const replacing = this.speaking
    this.speaking = true
    const id = this.generation
    this.cancelRetry()
    this.speechTimeout?.()
    this.disconnect()
    if (replacing) this.runtime.cancelSpeech()
    const finished = () => {
      if (id !== this.generation || sequence !== this.speechSequence || !this.speaking) return
      this.speechTimeout?.()
      this.speechTimeout = undefined
      this.speaking = false
      this.reconnect(220)
    }
    this.status({ kind: 'speaking' })
    this.speechTimeout = this.runtime.schedule(finished, Math.max(5_000, message.length * 105))
    try {
      if (!this.runtime.speak(message, finished)) finished()
    } catch { finished() }
  }

  stopSpeaking() {
    if (!this.speaking) return
    this.speaking = false
    this.speechSequence++
    this.speechTimeout?.()
    this.speechTimeout = undefined
    this.runtime.cancelSpeech()
    this.reconnect(220)
  }

  private cancelRetry() {
    this.retry?.()
    this.retry = undefined
  }

  private disconnect() {
    this.startTimeout?.()
    const engine = this.engine
    this.engine = undefined
    if (engine) {
      engine.onstart = engine.onend = engine.onerror = engine.onresult = null
      try { engine.abort() } catch { /* The browser may already have ended this session. */ }
    }
  }

  private reset() {
    this.generation++
    this.requested = this.speaking = false
    this.failures = 0
    this.cancelRetry()
    this.speechTimeout?.()
    this.disconnect()
    this.connection = undefined
    this.runtime.cancelSpeech()
  }

  mute() {
    this.reset()
    this.status({ kind: 'muted' })
  }
}
