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
  relaxation: number
}

export interface RadarConfig {
  position: [number, number, number]
  yawDeg: number
  pitchDeg: number
  horizontalFovDeg: number
  verticalFovDeg: number
  minRange: number
  maxRange: number
  sampleCount: number
  rangeNoiseSigma: number
  dropoutRate: number
  outlierRate: number
}

export interface RadarPoint {
  x: number
  y: number
  z: number
  range: number
  azimuth: number
  elevation: number
  intensity: number
}

export interface CoalStatistics {
  volume: number
  mass: number
  maxHeight: number
  activeCells: number
}
