/** Shared domain types for the population globe. */

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
 */
export interface LodData {
  lod: string
  h3Res: number
  approxKm: number
  h3: string[]
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
