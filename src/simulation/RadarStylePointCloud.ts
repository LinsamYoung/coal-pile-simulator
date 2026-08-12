import type { RadarConfig, RadarPoint } from '../types'
import { HeightField } from './HeightField'

interface SurfaceTriangle {
  a: [number, number, number]
  b: [number, number, number]
  c: [number, number, number]
  cumulativeArea: number
}

export function generateRadarPointCloud(
  field: HeightField,
  config: RadarConfig,
  random: () => number = Math.random,
): RadarPoint[] {
  const triangles = buildCoalSurfaceTriangles(field)
  if (triangles.length === 0) return []

  const points: RadarPoint[] = []
  const totalArea = triangles[triangles.length - 1].cumulativeArea
  const maxAttempts = Math.max(config.sampleCount * 30, 1_000)
  let attempts = 0

  while (points.length < config.sampleCount && attempts < maxAttempts) {
    attempts += 1
    const triangle = pickTriangle(triangles, random() * totalArea)
    const surface = sampleTriangle(triangle, random(), random())
    const measured = measurePoint(surface, config, random)
    if (measured && random() >= config.dropoutRate) points.push(measured)
  }

  const outlierCount = Math.round(points.length * config.outlierRate)
  for (let i = 0; i < outlierCount; i += 1) {
    points.push(createOutlier(config, random))
  }
  return points
}

function buildCoalSurfaceTriangles(field: HeightField): SurfaceTriangle[] {
  const triangles: SurfaceTriangle[] = []
  let cumulativeArea = 0
  const vertex = (row: number, col: number): [number, number, number] => {
    const index = field.index(row, col)
    return [field.xAt(col), field.yAt(row), field.surfaceAt(index)]
  }
  const addTriangle = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ) => {
    const area = triangleArea(a, b, c)
    if (area <= 1e-8) return
    cumulativeArea += area
    triangles.push({ a, b, c, cumulativeArea })
  }

  for (let row = 0; row < field.rows - 1; row += 1) {
    for (let col = 0; col < field.cols - 1; col += 1) {
      const i00 = field.index(row, col)
      const i10 = field.index(row, col + 1)
      const i01 = field.index(row + 1, col)
      const i11 = field.index(row + 1, col + 1)
      if (Math.max(field.coal[i00], field.coal[i10], field.coal[i01], field.coal[i11]) <= 0.001) continue
      const v00 = vertex(row, col)
      const v10 = vertex(row, col + 1)
      const v01 = vertex(row + 1, col)
      const v11 = vertex(row + 1, col + 1)
      addTriangle(v00, v10, v11)
      addTriangle(v00, v11, v01)
    }
  }
  return triangles
}

function triangleArea(a: number[], b: number[], c: number[]): number {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const abz = b[2] - a[2]
  const acx = c[0] - a[0]
  const acy = c[1] - a[1]
  const acz = c[2] - a[2]
  const crossX = aby * acz - abz * acy
  const crossY = abz * acx - abx * acz
  const crossZ = abx * acy - aby * acx
  return 0.5 * Math.hypot(crossX, crossY, crossZ)
}

function pickTriangle(triangles: SurfaceTriangle[], target: number): SurfaceTriangle {
  let low = 0
  let high = triangles.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (triangles[middle].cumulativeArea < target) low = middle + 1
    else high = middle
  }
  return triangles[low]
}

function sampleTriangle(triangle: SurfaceTriangle, u: number, v: number): [number, number, number] {
  const sqrtU = Math.sqrt(u)
  const wa = 1 - sqrtU
  const wb = sqrtU * (1 - v)
  const wc = sqrtU * v
  return [
    wa * triangle.a[0] + wb * triangle.b[0] + wc * triangle.c[0],
    wa * triangle.a[1] + wb * triangle.b[1] + wc * triangle.c[1],
    wa * triangle.a[2] + wb * triangle.b[2] + wc * triangle.c[2],
  ]
}

function measurePoint(
  point: [number, number, number],
  config: RadarConfig,
  random: () => number,
): RadarPoint | null {
  const vector: [number, number, number] = [
    point[0] - config.position[0],
    point[1] - config.position[1],
    point[2] - config.position[2],
  ]
  const rawRange = Math.hypot(...vector)
  if (rawRange < config.minRange || rawRange > config.maxRange) return null
  const angles = localAngles(vector, config.yawDeg, config.pitchDeg)
  if (Math.abs(angles.azimuth) > config.horizontalFovDeg / 2) return null
  if (Math.abs(angles.elevation) > config.verticalFovDeg / 2) return null

  const noisyRange = Math.max(config.minRange, rawRange + gaussian(random) * config.rangeNoiseSigma)
  const scale = noisyRange / rawRange
  const incidenceVariation = 0.72 + random() * 0.28
  const intensity = Math.round(255 * incidenceVariation / (1 + rawRange * rawRange * 0.0015))
  return {
    x: config.position[0] + vector[0] * scale,
    y: config.position[1] + vector[1] * scale,
    z: config.position[2] + vector[2] * scale,
    range: noisyRange,
    azimuth: angles.azimuth,
    elevation: angles.elevation,
    intensity,
  }
}

function localAngles(vector: [number, number, number], yawDeg: number, pitchDeg: number) {
  const yaw = yawDeg * Math.PI / 180
  const pitch = pitchDeg * Math.PI / 180
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)
  const forward: [number, number, number] = [cosPitch * cosYaw, cosPitch * sinYaw, sinPitch]
  const right: [number, number, number] = [-sinYaw, cosYaw, 0]
  const up: [number, number, number] = [-sinPitch * cosYaw, -sinPitch * sinYaw, cosPitch]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const forwardDistance = dot(vector, forward)
  const rightDistance = dot(vector, right)
  const upDistance = dot(vector, up)
  return {
    azimuth: Math.atan2(rightDistance, forwardDistance) * 180 / Math.PI,
    elevation: Math.atan2(upDistance, Math.hypot(forwardDistance, rightDistance)) * 180 / Math.PI,
  }
}

function gaussian(random: () => number): number {
  const u = Math.max(Number.EPSILON, random())
  const v = Math.max(Number.EPSILON, random())
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function createOutlier(config: RadarConfig, random: () => number): RadarPoint {
  const range = config.minRange + random() * (config.maxRange - config.minRange)
  const azimuth = (random() - 0.5) * config.horizontalFovDeg
  const elevation = (random() - 0.5) * config.verticalFovDeg
  const yaw = (config.yawDeg + azimuth) * Math.PI / 180
  const pitch = (config.pitchDeg + elevation) * Math.PI / 180
  return {
    x: config.position[0] + range * Math.cos(pitch) * Math.cos(yaw),
    y: config.position[1] + range * Math.cos(pitch) * Math.sin(yaw),
    z: config.position[2] + range * Math.sin(pitch),
    range,
    azimuth,
    elevation,
    intensity: Math.round(20 + random() * 60),
  }
}
