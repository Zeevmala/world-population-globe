/** Shared domain types for the population globe. */
import type { H3Column } from './data/h3Column'

/** One level-of-detail entry as published in `public/data/manifest.json`. */
export interface LodEntry {
  lod: string
  /** Whole-tier Parquet path (absent for tiled tiers). */
  file?: string
  h3Res: number
  approxKm: number
  minZoom: number
  maxZoom: number
  cellCount: number
  maxPopulation: number
  sumPopulation: number
  bytes?: number
  /** Tiled tiers (e.g. r8) stream per-viewport from an index instead of a single file. */
  tiled?: boolean
  tileParentRes?: number
  indexFile?: string
}

/** One streamable tile (the r8 cells under a coarse H3 parent). */
export interface TileRef {
  parent: string
  file: string
  cellCount: number
}

/** Index of all tiles for a tiled tier (`public/data/tiles/r8/index.json`). */
export interface TileIndex {
  parentRes: number
  h3Res: number
  approxKm: number
  tileCount: number
  cellCount: number
  maxPopulation: number
  sumPopulation: number
  tiles: TileRef[]
}

/**
 * What a tiled tier's stream has published for the view it last served
 * (`useTileStreaming`; one per tiled manifest entry, in the store's `tiles` by tier name).
 */
export interface TileSet {
  lod: string
  /** H3 resolution of the tier's parent tiles (the index's `parentRes`). */
  parentRes: number
  /**
   * `loading`: the tier is in its band and the stream is fetching the tiles of a newer
   * key than `key`. `ready`: the load for `key` has settled. `failed`: the tile index
   * could not be loaded (retried after a cool-down) — the tier has nothing to draw.
   */
  status: 'loading' | 'ready' | 'failed'
  /** Re-selection key (`lib/tiles.ts` `tileKey`) whose load has settled; '' before the first. */
  key: string
  /**
   * Parents whose outcome for `key` is known — loaded, absent from the index (ocean), or
   * failed and being retried: the key's whole visible set. Coverage is judged on this,
   * not on `data`, so an ocean parent or a failed tile does not keep the tier off screen.
   */
  settled: ReadonlySet<string>
  /** The merged cells (may hold more parents than `key` needs; never fewer). Null if none. */
  data: LodData | null
  /** Parents merged into `data`. */
  parents: readonly string[]
}

/** Top-level data manifest describing all baked LOD tiers + provenance. */
export interface Manifest {
  source: string
  dataDate: string
  license: string
  attribution: string
  crs: string
  generatedAt: string
  lods: LodEntry[]
}

/**
 * Columnar in-memory representation of one LOD tier. Typed arrays (not row
 * objects) keep 2M-cell tiers light and let deck.gl accessors index directly.
 * The index column is packed 64-bit ({@link H3Column}), with strings built only
 * for the cells that reach a `getHexagon` call.
 */
export interface LodData {
  lod: string
  h3Res: number
  approxKm: number
  h3: H3Column
  population: Float32Array
  lng: Float32Array
  lat: Float32Array
  maxPopulation: number
}

/** Hovered hexagon, surfaced in the info panel. */
export interface HoverInfo {
  h3: string
  population: number
  lng: number
  lat: number
  approxKm: number
  /** Nominal area of a cell at this resolution (km²) — see `lib/density.ts`. */
  areaKm2: number
  /** People per km², the quantity the color ramp and column height encode. */
  density: number
}

/** GlobeView camera state (longitude/latitude/zoom, plus optional extras). */
export interface GlobeViewState {
  longitude: number
  latitude: number
  zoom: number
  minZoom?: number
  maxZoom?: number
  pitch?: number
  bearing?: number
  [k: string]: number | undefined
}
