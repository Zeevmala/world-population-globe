/**
 * Inline stroke icons for the HUD. Deliberately hand-rolled (no icon dependency, no
 * emoji): emoji render differently per platform, can't inherit `currentColor`, and
 * carry accidental screen-reader text. Every icon is decorative — the accessible name
 * lives on the button.
 */
import type { ReactNode } from 'react'

interface IconProps {
  className?: string
}

const SVG = (className: string | undefined, children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className ?? 'h-[18px] w-[18px]'}
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)

export function IconPlay({ className }: IconProps) {
  return SVG(className, <path d="M8 5.5 18.5 12 8 18.5z" fill="currentColor" stroke="none" />)
}

export function IconPause({ className }: IconProps) {
  return SVG(
    className,
    <>
      <rect x="7" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1" fill="currentColor" stroke="none" />
    </>,
  )
}

export function IconLink({ className }: IconProps) {
  return SVG(
    className,
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.66 0l2.6-2.6a4 4 0 0 0-5.66-5.66l-1.2 1.2" />
      <path d="M13.5 10.5a4 4 0 0 0-5.66 0l-2.6 2.6a4 4 0 1 0 5.66 5.66l1.2-1.2" />
    </>,
  )
}

export function IconCheck({ className }: IconProps) {
  return SVG(className, <path d="m5 12.5 4.5 4.5L19 7" />)
}

export function IconPlus({ className }: IconProps) {
  return SVG(
    className,
    <>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </>,
  )
}

export function IconMinus({ className }: IconProps) {
  return SVG(className, <path d="M5.5 12h13" />)
}

export function IconSearch({ className }: IconProps) {
  return SVG(
    className,
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m15.5 15.5 4 4" />
    </>,
  )
}

export function IconClose({ className }: IconProps) {
  return SVG(
    className,
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>,
  )
}

export function IconHelp({ className }: IconProps) {
  return SVG(
    className,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4" />
      <path d="M12 16.8h.01" />
    </>,
  )
}

/** Recenter / home view. */
export function IconGlobe({ className }: IconProps) {
  return SVG(
    className,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5z" />
    </>,
  )
}

/** Drag / spin affordance for the intro card. */
export function IconDrag({ className }: IconProps) {
  return SVG(
    className,
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4.5V9h-4.5" />
    </>,
  )
}

/** Zoom-to-detail affordance for the intro card. */
export function IconZoomIn({ className }: IconProps) {
  return SVG(
    className,
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M11 8.6v4.8" />
      <path d="M8.6 11h4.8" />
      <path d="m15.5 15.5 4 4" />
    </>,
  )
}

/** Keyboard glyph for the shortcuts affordance. */
export function IconKeyboard({ className }: IconProps) {
  return SVG(
    className,
    <>
      <rect x="2.75" y="6.25" width="18.5" height="11.5" rx="2" />
      <path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7 13.2h.01M17 13.2h.01" />
      <path d="M10 13.2h4" />
    </>,
  )
}
