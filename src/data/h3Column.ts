/**
 * H3 indices as packed 64-bit integers, with strings materialized on demand.
 *
 * A tier's index column used to live as `string[]` — 2 M JS strings for the mid tier,
 * ~1.8 s to decode and ~80 MB resident. But an H3 index *is* a 64-bit integer, and its
 * canonical string form is just its lowercase hex (always 15 digits: mode-1 indices set
 * bit 59, so the value never falls below 16^14). So the column travels as a
 * `BigUint64Array` — transferable, zero-copy out of the decode worker, 16 MB — and the
 * string is built only for cells that actually reach `getHexagon`, which the 120 k
 * render cap bounds. Each string is built at most once and cached.
 */
export interface H3Column {
  readonly length: number
  /** Canonical H3 string for cell `i` (memoized). */
  at(i: number): string
  /** Packed indices, for slicing/merging without touching strings. */
  readonly packed: BigUint64Array
}

export function h3Column(packed: BigUint64Array): H3Column {
  const cache = new Array<string | undefined>(packed.length)
  return {
    length: packed.length,
    packed,
    at(i: number): string {
      const hit = cache[i]
      if (hit !== undefined) return hit
      const s = packed[i].toString(16)
      cache[i] = s
      return s
    },
  }
}

/** Pack an array of H3 hex strings (the shape hyparquet decodes VARCHAR into). */
export function packH3(strings: ArrayLike<string>): BigUint64Array {
  const out = new BigUint64Array(strings.length)
  for (let i = 0; i < strings.length; i++) out[i] = BigInt(`0x${strings[i]}`)
  return out
}

/** Concatenate packed columns in order — the r8 tile merge, without per-cell strings. */
export function concatPacked(parts: BigUint64Array[], total: number): BigUint64Array {
  const out = new BigUint64Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
