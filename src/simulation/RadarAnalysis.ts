import type { RadarConfig, ScanPoint } from './RadarSimulation'
import { radarPosition, radarYaw } from './RadarSimulation'

const key = (x: number, y: number, z: number) => `${x},${y},${z}`
export class PointIndex {
  private readonly buckets = new Map<string, ScanPoint[]>()
  constructor(readonly tolerance: number) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('距离阈值必须为非负有限数。')
  }
  add(point: ScanPoint): void {
    const t = this.tolerance
    const bucket = t === 0 ? key(point.x, point.y, point.z) : key(Math.floor(point.x / t), Math.floor(point.y / t), Math.floor(point.z / t))
    const values = this.buckets.get(bucket) ?? []
    values.push(point)
    this.buckets.set(bucket, values)
  }
  hasNeighbor(point: ScanPoint): boolean {
    const t = this.tolerance
    if (t === 0) return this.buckets.has(key(point.x, point.y, point.z))
    const x = Math.floor(point.x / t), y = Math.floor(point.y / t), z = Math.floor(point.z / t)
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const other of this.buckets.get(key(x + dx, y + dy, z + dz)) ?? []) {
        if ((point.x - other.x) ** 2 + (point.y - other.y) ** 2 + (point.z - other.z) ** 2 <= t * t + 1e-12) return true
      }
    }
    return false
  }
}

export function deduplicatePoints(points: readonly ScanPoint[], tolerance = 0): ScanPoint[] {
  // 零容差明确保留重复采样；正容差按输入顺序保留首个欧氏距离代表点。
  if (tolerance === 0) return [...points]
  const index = new PointIndex(tolerance)
  const output: ScanPoint[] = []
  for (const point of points) if (!index.hasNeighbor(point)) { index.add(point); output.push(point) }
  return output
}

export interface OverlapResult {
  threshold: number
  countA: number
  countB: number
  matchedA: number
  matchedB: number
  ratioA: number
  ratioB: number
  commonA: ScanPoint[]
  commonB: ScanPoint[]
}
export function overlapPoints(a: readonly ScanPoint[], b: readonly ScanPoint[], threshold: number): OverlapResult {
  const indexA = new PointIndex(threshold), indexB = new PointIndex(threshold)
  for (const point of a) indexA.add(point)
  for (const point of b) indexB.add(point)
  const commonA = a.filter(point => indexB.hasNeighbor(point))
  const commonB = b.filter(point => indexA.hasNeighbor(point))
  return { threshold, countA: a.length, countB: b.length, matchedA: commonA.length, matchedB: commonB.length,
    ratioA: a.length ? commonA.length / a.length : 0, ratioB: b.length ? commonB.length / b.length : 0, commonA, commonB }
}

export function worldToLocal(point: ScanPoint, radar: RadarConfig): ScanPoint {
  const origin = radarPosition(radar), yaw = (radarYaw(radar) % 360) * Math.PI / 180
  const x = point.x - origin.x, y = point.y - origin.y
  return { x: Math.cos(yaw) * x + Math.sin(yaw) * y, y: -Math.sin(yaw) * x + Math.cos(yaw) * y, z: point.z - origin.z }
}
export function localToWorld(point: ScanPoint, radar: RadarConfig): ScanPoint {
  const origin = radarPosition(radar), yaw = (radarYaw(radar) % 360) * Math.PI / 180
  return { x: origin.x + Math.cos(yaw) * point.x - Math.sin(yaw) * point.y, y: origin.y + Math.sin(yaw) * point.x + Math.cos(yaw) * point.y, z: origin.z + point.z }
}
export function stationTransform(from: RadarConfig, to: RadarConfig): { yaw: number; translation: ScanPoint } {
  // 将来源站固定局部坐标转换到目标站固定局部坐标，供配准误差真值比较。
  const angle = (radarYaw(from) % 360 - radarYaw(to) % 360) * Math.PI / 180
  return { yaw: Math.atan2(Math.sin(angle), Math.cos(angle)) * 180 / Math.PI, translation: worldToLocal(radarPosition(from), to) }
}
export function registrationError(from: RadarConfig, to: RadarConfig, estimate: { yaw: number; translation: ScanPoint }): { rotationDeg: number; translationMeters: number } {
  const truth = stationTransform(from, to)
  const angle = (estimate.yaw - truth.yaw) * Math.PI / 180
  return { rotationDeg: Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)) * 180 / Math.PI), translationMeters: Math.hypot(estimate.translation.x - truth.translation.x, estimate.translation.y - truth.translation.y, estimate.translation.z - truth.translation.z) }
}
