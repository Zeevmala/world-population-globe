import { useMemo } from 'react'

/** mulberry32 — a tiny deterministic PRNG so the field is identical every load. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STAR_COUNT = 420
// Square viewBox scaled to cover the viewport (slice); 1000 units → screen px lets the
// sub-unit radii below render as ~0.5–2 CSS px stars on a typical display.
const VIEW = 1000

interface Star {
  x: number
  y: number
  r: number
  o: number
  blue: boolean
  tw: boolean
}

/**
 * Static screen-space starfield, painted behind the (transparent) globe canvas so it
 * shows in the space around the planet. Generated once from a fixed seed — no per-frame
 * cost, no network asset. A small fraction twinkle via CSS, gated behind
 * `prefers-reduced-motion: no-preference` in index.css.
 */
export function Starfield() {
  const stars = useMemo<Star[]>(() => {
    const rnd = mulberry32(0x5eed)
    return Array.from({ length: STAR_COUNT }, () => {
      const bright = rnd() > 0.9
      return {
        x: rnd() * VIEW,
        y: rnd() * VIEW,
        r: bright ? 0.6 + rnd() * 0.5 : 0.25 + rnd() * 0.3,
        o: bright ? 0.75 + rnd() * 0.25 : 0.2 + rnd() * 0.35,
        blue: rnd() > 0.82,
        tw: bright && rnd() > 0.5,
      }
    })
  }, [])

  return (
    <svg
      className="pointer-events-none absolute inset-0 z-0 h-full w-full"
      aria-hidden="true"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      preserveAspectRatio="xMidYMid slice"
    >
      {stars.map((s, i) => (
        <circle
          key={i}
          cx={s.x}
          cy={s.y}
          r={s.r}
          fill={s.blue ? '#bcd2ff' : '#ffffff'}
          opacity={s.o}
          className={s.tw ? 'star-tw' : undefined}
          style={s.tw ? { animationDelay: `${(i % 12) * 0.45}s` } : undefined}
        />
      ))}
    </svg>
  )
}
