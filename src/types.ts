export type ToolMode = 'deposit' | 'excavate'

export interface PointCloudData {
  positions: Float32Array
  intensities?: Float32Array
  /** Original bytes are retained so composite export can preserve its PLY schema and encoding. */
  sourceBuffer: ArrayBuffer
  pointCount: number
  sourceName: string
  sourceMin: [number, number, number]
  sourceMax: [number, number, number]
}

export interface BrushSettings {
  mode: ToolMode
  radius: number
  strength: number
  falloff: number
  maxHeight: number
  /** Bulk angle at which deposited coal begins to slide, measured from horizontal. */
  reposeAngleDeg: number
  relaxation: number
}

export interface CoalStatistics {
  volume: number
  mass: number
  maxHeight: number
  activeCells: number
}

export interface GridPointReplacement {
  /** Zero-based vertex index in the source PLY. */
  index: number
  /** Local coordinates; X/Y remain exactly equal to the source point. */
  x: number
  y: number
  z: number
  intensity?: number
}

export interface GridPointAddition {
  /** Local grid-aligned coordinates. */
  x: number
  y: number
  z: number
  /** Source vertex whose non-position PLY attributes should be copied. */
  templateIndex: number
  scanLineIndex: number
  pointIndexInLine: number
}

export interface SourceScanGrid {
  alongAxis: [number, number]
  crossAxis: [number, number]
  alongSpacing: number
  crossSpacing: number
  originAlong: number
  originCross: number
  angleDeg: number
  confidence: number
}

export interface GridReplacementResult {
  replacements: GridPointReplacement[]
  additions: GridPointAddition[]
  scanGrid: SourceScanGrid
  coveredSourcePoints: number
  preservedSourcePoints: number
  filledGapPoints: number
  targetGridPoints: number
  outputPointCount: number
  coveragePercent: number
}
