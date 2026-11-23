import { useEffect, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button type="button" title={label} aria-label={label} className={'icon-button ' + className} {...props}>{children}</button>
}

export function Menu({ label, content, children, disabled = false, className = '' }: {
  label: string; content: ReactNode; children: (close: () => void) => ReactNode; disabled?: boolean; className?: string;
}) {
  const [show, set] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!show) return
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) set(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') set(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [show])
  return <div ref={ref} className={'menu ' + className}>
    <button type="button" aria-label={label} aria-expanded={show} disabled={disabled} className="menu-trigger" onClick={() => set(!show)}>
      {content}<ChevronDown size={13} />
    </button>
    {show && <div className="popover menu-items">{children(() => set(false))}</div>}
  </div>
}

export function MenuItem({ children, onClick, detail, disabled }: { children: ReactNode; onClick: () => void; detail?: string; disabled?: boolean }) {
  return <button type="button" disabled={disabled} className="menu-item" onClick={onClick}>{children}{detail && <kbd>{detail}</kbd>}</button>
}

export function NumberField({ label, value, suffix, digits = 2, update, className = '', autoFocus = false }: {
  label: string; value: number; suffix?: string; digits?: number; update: (n: number) => void; className?: string; autoFocus?: boolean;
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const cleaned = Number.isFinite(value) ? Number(value.toFixed(digits)).toString() : ''
  return <label className={'number-field ' + className}>
    <span>{label}</span>
    <div className="number-input">
      <input aria-label={label} type="text" inputMode="decimal" value={editing ? text : cleaned} autoFocus={autoFocus}
        onFocus={e => { setText(cleaned); setEditing(true); e.currentTarget.select() }}
        onChange={e => setText(e.currentTarget.value)}
        onBlur={() => {
          if (!editing) return
          setEditing(false)
          const next = text.trim() ? Number(text.trim().replace(',', '.')) : NaN
          if (Number.isFinite(next) && next !== Number(cleaned)) update(next)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.stopPropagation(); e.currentTarget.blur() }
          if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setText(cleaned); }
        }} />
      {suffix && <span>{suffix}</span>}
    </div>
  </label>
}
