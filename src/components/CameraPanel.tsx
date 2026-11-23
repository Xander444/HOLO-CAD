import { Expand, ScanFace, Video } from 'lucide-react'
import type { RefObject } from 'react'
import type { TrackedHand } from '../vision/tracking'
import { IconButton } from './ui'

const links = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]]
export const calibrationSteps = ['Raise both hands and hold them open.', 'Pinch your thumb and index finger on both hands.', 'Spread both hands, then trace the edges of your comfortable reach.', 'Calibration saved.']
export function CameraPanel({ video, status, preview, mirror, hands, gesture, calibration, hide }: {
  video: RefObject<HTMLVideoElement | null>; status: 'off' | 'starting' | 'active'; preview: boolean; mirror: boolean;
  hands: TrackedHand[]; gesture?: string; calibration?: { step: number; count: number }; hide: () => void;
}) {
  const shown = status !== 'off' && (preview || calibration)
  return <div className={'camera-panel ' + (shown ? '' : 'camera-inactive')}>
    {shown && <header><span><Video size={14} /> Hand tracking</span><IconButton label="Hide camera preview" onClick={hide}><Expand size={13} /></IconButton></header>}
    <div className="camera-stream">
      <video ref={video} playsInline muted autoPlay style={{ transform: mirror ? 'scaleX(-1)' : undefined }} />
      {shown && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>
        {hands.map((hand, i) => <g key={hand.id} className={i ? 'hand-secondary' : 'hand-primary'}>
          {links.map(([a, b]) => <line key={a + ':' + b} x1={hand.landmarks[a].x * 100} y1={hand.landmarks[a].y * 100}
            x2={hand.landmarks[b].x * 100} y2={hand.landmarks[b].y * 100} vectorEffect="non-scaling-stroke" />)}
          {hand.landmarks.map(({ x, y }, j) => <circle key={j} cx={x * 100} cy={y * 100} r={j % 4 === 0 ? 1.4 : .8} />)}
        </g>)}
      </svg>}
      {shown && status === 'starting' && <p>Starting local tracker…</p>}
    </div>
    {shown && <footer><i className={status === 'active' ? 'live' : ''} />{gesture ?? hands.length + (hands.length === 1 ? ' hand' : ' hands') + ' detected'}</footer>}
    {calibration && <div className="calibration-note">
      <ScanFace size={18} />
      <div><strong>Calibration · {Math.min(3, calibration.step + 1)} of 3</strong><p>{calibrationSteps[calibration.step]}</p>
        <progress max={calibration.step === 2 ? 85 : 12} value={calibration.count} /></div>
    </div>}
  </div>
}
