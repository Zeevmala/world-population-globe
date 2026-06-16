import { useEffect, useState } from 'react'
import { useGlobeStore } from '../store/useGlobeStore'

// Apparent globe radius as a fraction of viewport height, sampled from the live deck
// GlobeView projection (radius scales with height via the perspective FOV, and grows
// non-linearly with zoom). Piecewise-linear between these points — accurate enough that
// the glow hugs the limb, with no fragile closed-form constant. (See verification notes:
// at zoom 1.3 this yields 0.553·H ≈ 150 px, matching the measured 149 px.)
const RADIUS_FRAC: ReadonlyArray<readonly [number, number]> = [
  [-1, 0.145],
  [-0.5, 0.198],
  [0, 0.268],
  [0.5, 0.357],
  [1, 0.47],
  [1.5, 0.609],
  [2, 0.778],
  [2.5, 0.98],
  [3, 1.219],
  [3.5, 1.5],
  [4, 1.83],
]

function radiusFrac(zoom: number): number {
  const pts = RADIUS_FRAC
  if (zoom <= pts[0][0]) return pts[0][1]
  const last = pts[pts.length - 1]
  if (zoom >= last[0]) return last[1] * 2 ** (zoom - last[0]) // off-screen tail at deep zoom
  for (let i = 1; i < pts.length; i++) {
    if (zoom <= pts[i][0]) {
      const [z0, g0] = pts[i - 1]
      const [z1, g1] = pts[i]
      return g0 + (g1 - g0) * ((zoom - z0) / (z1 - z0))
    }
  }
  return last[1]
}

/**
 * Screen-space atmosphere: a cool-blue glow hugging the globe's projected limb plus a
 * faint deep-space darkening toward the corners. Pure CSS driven by zoom — zero GPU cost
 * — and it stays outside the disc, so column colors remain full-bright. GlobeView keeps
 * the disc centered, so a single center-anchored radial-gradient tracks the limb; as you
 * zoom in the radius outgrows the viewport and the later stops collapse off-screen (CSS
 * clamps non-increasing positions), so the overlay fades to nothing at city scale.
 */
export function Atmosphere() {
  const zoom = useGlobeStore((s) => s.viewState.zoom)
  const [vh, setVh] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 800))

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const r = vh * radiusFrac(zoom)
  const background =
    'radial-gradient(circle at 50% 50%,' +
    ' transparent 0,' +
    ` transparent ${(r * 0.99).toFixed(1)}px,` +
    ` rgba(132,182,240,0.36) ${(r * 1.05).toFixed(1)}px,` +
    ` rgba(120,170,235,0.12) ${(r * 1.16).toFixed(1)}px,` +
    ` rgba(120,170,235,0) ${(r * 1.34).toFixed(1)}px,` +
    ' rgba(120,170,235,0) 68%,' +
    ' rgba(2,4,10,0.55) 100%)'

  return <div className="pointer-events-none absolute inset-0 z-10" style={{ background }} />
}
