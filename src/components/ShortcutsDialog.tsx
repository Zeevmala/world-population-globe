import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { HudButton } from './HudButton'
import { IconClose } from './icons'

const ROWS: { action: string; keys: string[]; note?: string }[] = [
  { action: 'Pan the globe', keys: ['←', '↑', '↓', '→'], note: 'hold Shift to move faster' },
  { action: 'Zoom in / out', keys: ['+', '−'] },
  { action: 'Search a place', keys: ['/'] },
  { action: 'Auto-rotate on / off', keys: ['R'] },
  { action: 'Reset to the hero view', keys: ['H'] },
  { action: 'Copy a link to this view', keys: ['C'] },
  { action: 'Show these shortcuts', keys: ['?'] },
  { action: 'Close / dismiss', keys: ['Esc'] },
]

interface ShortcutsDialogProps {
  open: boolean
  onClose: () => void
}

/**
 * Keyboard reference. Modal, focus-trapped, and it hands focus back to whatever opened
 * it — a dialog you can tab out of is worse than no dialog for a keyboard user.
 * Escape is handled globally by `KeyboardShortcuts`.
 */
export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<Element | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement
    closeRef.current?.focus()
    return () => {
      const opener = openerRef.current
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus()
    }
  }, [open])

  if (!open) return null

  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return
    const nodes = panelRef.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, [tabindex]:not([tabindex="-1"])',
    )
    if (!nodes?.length) return
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center px-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onKeyDown={trapTab}
        className="hud-panel hud-rise relative max-h-[80vh] w-full max-w-sm overflow-auto bg-black/70 p-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="shortcuts-title" className="text-sm font-semibold text-white">
              Keyboard shortcuts
            </h2>
            <p className="mt-0.5 text-[11px] text-white/60">
              Mouse: drag to spin · scroll to zoom · hover a column for its numbers
            </p>
          </div>
          <HudButton label="Close" onClick={onClose} buttonRef={closeRef} hideTip className="-mr-1 -mt-1">
            <IconClose />
          </HudButton>
        </div>

        <dl className="mt-3 divide-y divide-white/10">
          {ROWS.map((r) => (
            <div key={r.action} className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-[13px] text-white/85">
                {r.action}
                {r.note ? <span className="block text-[11px] text-white/60">{r.note}</span> : null}
              </dt>
              <dd className="flex shrink-0 gap-1">
                {r.keys.map((k) => (
                  <kbd key={k} className="hud-kbd">
                    {k}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
