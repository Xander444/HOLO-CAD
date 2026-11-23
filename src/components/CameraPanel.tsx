import { Minus, ScanFace, Video } from 'lucide-react'
import { useState } from 'react'
import type { RefObject } from 'react'
import type { TrackedHand } from '../vision/tracking'
import { IconButton } from './ui'

const links = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]]
export const calibrationSteps = ['Raise both hands and hold them open.', 'Pinch your thumb and index finger on both hands.', 'Spread both hands, then trace the edges of your comfortable reach.', 'Calibration saved.']
export function CameraPanel({ video, status, preview, mirror, hands, gesture, calibration, calibrate, skipCalibration, hide }: {
  video: RefObject<HTMLVideoElement | null>; status: 'off' | 'starting' | 'active'; preview: boolean; mirror: boolean;
  hands: TrackedHand[]; gesture?: string; calibration?: { step: number; count: number };
  calibrate: () => void; skipCalibration: () => void; hide: () => void;
}) {
  const [aspect, setAspect] = useState(4 / 3)
  const readAspect = ({ currentTarget }: { currentTarget: HTMLVideoElement }) => {
    if (currentTarget.videoWidth && currentTarget.videoHeight) setAspect(currentTarget.videoWidth / currentTarget.videoHeight)
  }
  const shown = status !== 'off' && (preview || calibration)
  return <div className={'camera-panel ' + (shown ? '' : 'camera-inactive')}>
    {shown && <header><span><Video size={14} /> Hand tracking</span>{!calibration && <IconButton label="Hide camera preview" onClick={hide}><Minus size={13} /></IconButton>}</header>}
    <div className="camera-stream" style={{ aspectRatio: aspect, maxWidth: 150 * aspect }}>
      <video ref={video} playsInline muted autoPlay onLoadedMetadata={readAspect} onResize={readAspect} style={{ transform: mirror ? 'scaleX(-1)' : undefined }} />
      {shown && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>
        {hands.map((hand, i) => <g key={hand.id} className={i ? 'hand-secondary' : 'hand-primary'}>
          {links.map(([a, b]) => <line key={a + ':' + b} x1={hand.landmarks[a].x * 100} y1={hand.landmarks[a].y * 100}
            x2={hand.landmarks[b].x * 100} y2={hand.landmarks[b].y * 100} vectorEffect="non-scaling-stroke" />)}
          {hand.landmarks.map(({ x, y }, j) => <circle key={j} cx={x * 100} cy={y * 100} r={j % 4 === 0 ? 1.4 : .8} />)}
        </g>)}
      </svg>}
    </div>
    {shown && !calibration && <footer>
      <span><i className={status === 'active' ? 'live' : ''} />{status === 'starting' ? 'Starting tracking…' : gesture ?? (hands.length ? 'Move your hand to aim' : 'Show a hand to begin')}</span>
      {status === 'active' && <button type="button" className="camera-action" onClick={calibrate}>Calibrate</button>}
    </footer>}
    {shown && calibration && <div className="calibration-note">
      <ScanFace size={18} />
      <div><strong>Calibration · {Math.min(3, calibration.step + 1)} of 3</strong><p>{calibrationSteps[calibration.step]}</p>
        <progress aria-label="Calibration step progress" max={calibration.step === 2 ? 85 : 12} value={calibration.count} /></div>
      <button type="button" className="camera-action" onClick={skipCalibration}>Skip</button>
    </div>}
  </div>
}
