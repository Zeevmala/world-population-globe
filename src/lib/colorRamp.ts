/**
 * Inferno (perceptually uniform) color ramp — the right choice for sequential
 * density on a dark globe; a rainbow/jet ramp would fabricate visual breaks the
 * data doesn't have. Eight sampled stops, linearly interpolated in RGB.
 */
const INFERNO: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 4],
  [40, 11, 84],
  [101, 21, 110],
  [159, 42, 99],
  [212, 72, 66],
  [245, 125, 21],
  [250, 193, 39],
  [252, 255, 164],
]

/** Map t∈[0,1] to an Inferno RGB triple. */
export function inferno(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (INFERNO.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = INFERNO[i]
  const b = INFERNO[Math.min(INFERNO.length - 1, i + 1)]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

/** CSS `linear-gradient` stops for the legend, sampled from the same ramp. */
export function infernoCssStops(n = 8): string {
  return Array.from({ length: n }, (_, k) => {
    const [r, g, b] = inferno(k / (n - 1))
    return `rgb(${r},${g},${b}) ${Math.round((k / (n - 1)) * 100)}%`
  }).join(', ')
}
