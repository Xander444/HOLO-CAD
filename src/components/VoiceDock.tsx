import { useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { ArrowUp, AudioLines, Mic, MicOff, Terminal } from 'lucide-react'
import type { VoiceStatus } from '../voice/speech'

const labels: Record<VoiceStatus['kind'], string> = {
  muted: 'Microphone muted',
  starting: 'Starting microphone',
  listening: 'Listening',
  speaking: 'Assistant speaking',
  reconnecting: 'Resuming microphone',
  setup: 'Set up voice',
  blocked: 'Microphone paused',
  unsupported: 'Voice unavailable',
}

function voiceDetail(status: VoiceStatus) {
  switch (status.kind) {
    case 'listening': return status.provider === 'on-device' ? 'Speech stays on this device.' : 'Using your browser’s speech service.'
    case 'muted': return 'Unmute whenever you’re ready.'
    case 'starting': return 'Waiting for the browser to start speech recognition.'
    case 'speaking': return 'Listening resumes after the prompt.'
    case 'reconnecting': return 'Listening will resume automatically.'
    case 'setup': case 'unsupported': case 'blocked': return status.message
  }
}

export function VoiceDock({ status, muted, transcript, suggestions, input, submit, toggleMute, setup, enable, actions }: {
  status: VoiceStatus; muted: boolean; transcript: string; suggestions: string[];
  input: RefObject<HTMLInputElement | null>; submit: (command: string) => void;
  toggleMute: () => void; setup: () => void; enable: () => void; actions: ReactNode;
}) {
  const [draft, setDraft] = useState('')
  return <section className={'voice-dock voice-' + status.kind} aria-label="Voice assistant">
    <div className="voice-main">
      <button type="button" className="voice-toggle" aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
        aria-pressed={muted} title={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={toggleMute}>
        {muted ? <MicOff size={22} strokeWidth={1.75} /> : <Mic size={22} strokeWidth={1.75} />}
      </button>
      <div className="voice-copy">
        <div className="voice-heading" role="status"><AudioLines size={15} /><strong>{labels[status.kind]}</strong></div>
        <div className="voice-detail" title={voiceDetail(status)}>{voiceDetail(status)}</div>
      </div>
      {status.kind === 'setup' && <button type="button" className="primary voice-enable" onClick={setup}>Voice setup</button>}
      {status.kind === 'blocked' && <button type="button" className="primary voice-enable" onClick={enable}>Enable mic</button>}
      <form className="command-form" onSubmit={event => {
        event.preventDefault()
        if (!draft.trim()) return
        submit(draft)
        setDraft('')
      }} aria-label="Typed CAD commands">
        <Terminal size={17} /><input ref={input} aria-label="CAD command" type="text" placeholder="Or type a command…" spellCheck={false}
          autoComplete="off" value={draft} onChange={event => setDraft(event.currentTarget.value)} />
        {draft ? <button type="submit" aria-label="Run command"><ArrowUp size={16} /></button> : <kbd>/</kbd>}
      </form>
      <div className="voice-actions">{actions}</div>
    </div>
    <div className="voice-suggestions">
      {transcript && <span className="last-command" title={'Last command: ' + transcript}>“{transcript}”</span>}
      <span>Try saying</span>
      {suggestions.map(command => <button type="button" key={command} aria-label={'Run “' + command + '”'} onClick={() => submit(command)}>{command}</button>)}
    </div>
  </section>
}
