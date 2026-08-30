import type { ReactNode, RefObject } from 'react'

interface HudButtonProps {
  /** Accessible name — also the tooltip text (desktop). */
  label: string
  /** Keyboard shortcut shown in the tooltip, e.g. "R". */
  shortcut?: string
  /** Toggle state; when defined the button reports `aria-pressed`. */
  pressed?: boolean
  onClick: () => void
  /** Icon (decorative — the name lives on the button). */
  children: ReactNode
  className?: string
  /** Suppress the hover tooltip where the button's meaning is already obvious
   *  (a dialog's ✕), so the label doesn't float over the panel it closes. */
  hideTip?: boolean
  /** For callers that must move focus here (e.g. a dialog's initial focus). */
  buttonRef?: RefObject<HTMLButtonElement | null>
}

/**
 * One icon button of the HUD rail: 44 px touch target on phones, 36 px from `sm` up,
 * with a hover/focus tooltip that also teaches the keyboard shortcut. The visible
 * tooltip is `aria-hidden` — assistive tech reads `aria-label` instead, so the name
 * is announced once, not twice.
 */
export function HudButton({
  label,
  shortcut,
  pressed,
  onClick,
  children,
  className,
  hideTip,
  buttonRef,
}: HudButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      className={`hud-btn group relative ${className ?? ''}`}
    >
      {children}
      {hideTip ? null : (
        <span className="hud-tip" aria-hidden="true">
          {label}
          {shortcut ? <kbd className="hud-kbd">{shortcut}</kbd> : null}
        </span>
      )}
    </button>
  )
}
