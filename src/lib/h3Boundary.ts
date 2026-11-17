import { cellToBoundary } from 'h3-js'

/**
 * Bounded LRU cache of H3 cell boundaries, in the exact form deck.gl's `H3HexagonLayer`
 * feeds its high-precision `PolygonLayer` sublayer — so the population layer can render
 * that `PolygonLayer` itself with a cached `getPolygon`, instead of recomputing every
 * boundary on every re-cull.
 *
 * Why it pays: on a `_GlobeView`, `H3HexagonLayer` with `highPrecision: 'auto'` always
 * takes its per-cell polygon path, whose `getPolygon` is
 * `flattenPolygon(h3ToPolygon(cellToBoundary(id)))`, and it is called THREE times per
 * cell per geometry change — once by `PolygonLayer._getPaths`, then by the polygon
 * tesselator's sizing pass and its fill pass — and that happens on every re-cull. Adjacent cull windows share most of their cells, so most of that
 * work is a repeat.
 *
 * Output contract (asserted in `h3Boundary.test.ts` against deck.gl's own sublayer
 * accessor): the closed ring — `cellToBoundary(id, true)` (GeoJSON order, [lng, lat],
 * first vertex repeated last), longitudes normalized against the first vertex exactly as
 * `h3-utils.normalizeLongitudes` does, flattened XY — the same float64 values in the
 * same order as deck.gl's `Float64Array`. Returned as a fresh plain `number[]`:
 * - fresh, because the tesselator keeps the first pass's arrays until its second pass
 *   and `PolygonLayer` keeps the `_getPaths` ones in its state (a view into the slab
 *   could be rewritten by a later eviction) — and nothing
 *   downstream mutates it (`_normalize: false` passes it through; `getSurfaceIndices`
 *   slices before preprojecting);
 * - a plain array, because a small `Float64Array` costs ~0.8 µs to allocate in V8 (its
 *   backing store is off-heap past 64 bytes) — as much as the lookup saves — while a
 *   14-element array costs ~25 ns. The tesselator reads both identically (flat XY,
 *   `positionFormat: 'XY'`) and copies into its own float32 attribute either way.
 *
 * Storage is flat and typed — no per-cell JS object is retained. The key is the packed
 * 64-bit index as two uint32 words (read straight off the `BigUint64Array`'s buffer, see
 * {@link h3Words}), so it survives the r8 tier's tile merges (a source-index key would
 * not), and one cache serves every tier (indices of different resolutions never collide).
 *
 * Memory (fixed at construction): per entry 12 float64 coords (96 B) + 2 key words
 * (8 B) + vertex count (1 B) + 2 LRU links (8 B) + 2 hash buckets (8 B) ≈ 121 B.
 * At {@link BOUNDARY_CACHE_CAPACITY} = 2^18 entries that is ≈ 31.7 MB, allocated once.
 */

/** Open-ring vertices stored inline per entry: hexagon 6, pentagon 5. */
export const SLOT_VERTS = 6
const STRIDE = SLOT_VERTS * 2

/**
 * Default hard cap: 262,144 cells ≈ 2.2 × the 120 k per-frame render cap — one full
 * mid/r8 cull plus the whole 71 k overview tier still fit with room for a pan's
 * leading edge (see `scripts/bench/boundary_bench.mjs` for the hit rates it buys).
 */
export const BOUNDARY_CACHE_CAPACITY = 1 << 18

/**
 * Byte order of this platform's typed arrays. Every browser engine in use is
 * little-endian; the check keeps the word split correct anywhere.
 */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
/** Offset of the low / high uint32 word of a 64-bit index within its pair in {@link h3Words}. */
export const LO_WORD = LITTLE_ENDIAN ? 0 : 1
export const HI_WORD = LITTLE_ENDIAN ? 1 : 0

/** Zero-copy uint32 view of a packed H3 column: cell `i` is words `2i + LO_WORD` / `2i + HI_WORD`. */
export function h3Words(packed: BigUint64Array): Uint32Array {
  return new Uint32Array(packed.buffer, packed.byteOffset, packed.length * 2)
}

/**
 * 32-bit mix of the two key words (murmur3 `fmix32` over a fold). An H3 cell's
 * distinguishing bits sit high in `lo` (unused digits are all-ones below them), so the
 * fold starts with a downward shift before any multiply.
 */
function hash(lo: number, hi: number): number {
  let h = lo ^ Math.imul(hi, 0x9e3779b1)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return h ^ (h >>> 16)
}

export class BoundaryCache {
  /** Hard cap on cached cells; {@link size} never exceeds it. */
  readonly capacity: number
  /** Cells currently cached. */
  size = 0
  hits = 0
  misses = 0
  evictions = 0
  /** Misses not cached because the boundary had more than {@link SLOT_VERTS} vertices. */
  bypassed = 0

  private readonly keyLo: Uint32Array
  private readonly keyHi: Uint32Array
  private readonly nVerts: Uint8Array
  private readonly coords: Float64Array
  /** LRU list links: `newer` points toward the most recent, `older` toward the eviction end. */
  private readonly newer: Int32Array
  private readonly older: Int32Array
  /** Open-addressing (linear probing) hash table of slot indices; −1 = empty. */
  private readonly table: Int32Array
  private readonly mask: number
  private mru = -1
  private lru = -1
  /** Reused split-long argument for h3-js (`[lo, hi]`): no string, no per-call array. */
  private readonly split: [number, number] = [0, 0]

  constructor(capacity: number = BOUNDARY_CACHE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`bad capacity ${capacity}`)
    this.capacity = capacity
    this.keyLo = new Uint32Array(capacity)
    this.keyHi = new Uint32Array(capacity)
    this.nVerts = new Uint8Array(capacity)
    this.coords = new Float64Array(capacity * STRIDE)
    this.newer = new Int32Array(capacity)
    this.older = new Int32Array(capacity)
    let buckets = 1
    while (buckets < capacity * 2) buckets *= 2 // load factor ≤ 0.5
    this.table = new Int32Array(buckets).fill(-1)
    this.mask = buckets - 1
  }

  /** Flattened, longitude-normalized closed boundary of the cell whose 64-bit index is `hi:lo`. */
  polygon(lo: number, hi: number): number[] {
    const slot = this.lookup(lo, hi)
    if (slot >= 0) {
      this.hits++
      this.touch(slot)
      return this.emit(slot)
    }
    this.misses++
    this.split[0] = lo
    this.split[1] = hi
    const ring = cellToBoundary(this.split, true)
    // Same arithmetic as deck.gl `normalizeLongitudes(vertices)` (reference = first
    // vertex) followed by `flattenPolygon`, written into a fresh array instead of in place.
    const ref = ring[0][0]
    const out = new Array<number>(ring.length * 2)
    for (let k = 0; k < ring.length; k++) {
      let x = ring[k][0]
      const d = x - ref
      if (d > 180) x -= 360
      else if (d < -180) x += 360
      out[2 * k] = x
      out[2 * k + 1] = ring[k][1]
    }
    const open = ring.length - 1 // the GeoJSON ring repeats its first vertex last
    if (open > SLOT_VERTS) {
      this.bypassed++ // Class III distortion vertices (odd resolutions only): too wide to store
      return out
    }
    this.insert(lo, hi, out, open)
    return out
  }

  /** True if the cell is cached (does not touch its recency). */
  has(lo: number, hi: number): boolean {
    return this.lookup(lo, hi) >= 0
  }

  private emit(slot: number): number[] {
    const n = this.nVerts[slot] * 2
    const { coords } = this
    const base = slot * STRIDE
    const out = new Array<number>(n + 2)
    for (let k = 0; k < n; k++) out[k] = coords[base + k]
    out[n] = coords[base]
    out[n + 1] = coords[base + 1]
    return out
  }

  private lookup(lo: number, hi: number): number {
    const { table, mask, keyLo, keyHi } = this
    for (let b = hash(lo, hi) & mask; ; b = (b + 1) & mask) {
      const s = table[b]
      if (s < 0) return -1
      if (keyLo[s] === lo && keyHi[s] === hi) return s
    }
  }

  private insert(lo: number, hi: number, ring: number[], n: number): void {
    let slot: number
    if (this.size < this.capacity) {
      slot = this.size++
    } else {
      slot = this.lru
      this.evict(slot)
    }
    this.keyLo[slot] = lo
    this.keyHi[slot] = hi
    this.nVerts[slot] = n
    const base = slot * STRIDE
    for (let k = 0; k < n * 2; k++) this.coords[base + k] = ring[k]
    this.linkMru(slot)
    const { table, mask } = this
    let b = hash(lo, hi) & mask
    while (table[b] >= 0) b = (b + 1) & mask
    table[b] = slot
  }

  /** Drop `slot` (the LRU entry) from the list and the table; the slot is reused at once. */
  private evict(slot: number): void {
    this.evictions++
    this.unlink(slot)
    const { table, mask, keyLo, keyHi } = this
    let i = hash(keyLo[slot], keyHi[slot]) & mask
    while (table[i] !== slot) i = (i + 1) & mask
    // Backward-shift deletion: keep every remaining key reachable from its home bucket.
    table[i] = -1
    for (let j = (i + 1) & mask; table[j] >= 0; j = (j + 1) & mask) {
      const s = table[j]
      const home = hash(keyLo[s], keyHi[s]) & mask
      // Leave `s` where it is iff its home lies cyclically in (i, j].
      const stays = i <= j ? home > i && home <= j : home > i || home <= j
      if (!stays) {
        table[i] = s
        table[j] = -1
        i = j
      }
    }
  }

  private touch(slot: number): void {
    if (slot === this.mru) return
    this.unlink(slot)
    this.linkMru(slot)
  }

  private linkMru(slot: number): void {
    this.older[slot] = this.mru
    this.newer[slot] = -1
    if (this.mru >= 0) this.newer[this.mru] = slot
    this.mru = slot
    if (this.lru < 0) this.lru = slot
  }

  private unlink(slot: number): void {
    const o = this.older[slot]
    const n = this.newer[slot]
    if (o >= 0) this.newer[o] = n
    else this.lru = n
    if (n >= 0) this.older[n] = o
    else this.mru = o
  }
}
