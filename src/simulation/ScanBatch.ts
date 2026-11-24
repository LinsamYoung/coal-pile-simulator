import { cumulativeRays, firstCoalHit, rayCount, snapshotField, type RadarConfig, type ScanPoint } from './RadarSimulation'
import type { HeightField } from './HeightField'
import { PointIndex } from './RadarAnalysis'

export interface RadarScanResult {
  readonly radar: RadarConfig
  readonly points: readonly ScanPoint[]
  readonly candidates: number
  readonly rawHits: number
}
export interface ScanBatch {
  readonly id: string
  readonly createdAt: string
  readonly field: HeightField
  readonly tolerance: number
  readonly results: readonly RadarScanResult[]
}
export interface ScanProgress { completed: number; total: number; radarId: number; retained: number }
let sequence = 0

export async function runScanBatch(field: HeightField, radars: readonly RadarConfig[], tolerance: number, options: { signal?: AbortSignal; progress?: (progress: ScanProgress) => void; sliceMs?: number } = {}): Promise<ScanBatch> {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('去重容差须为非负有限数。')
  const frozenField = snapshotField(field)
  const recipes = radars.map(radar => Object.freeze({ ...radar }))
  const counts = recipes.map(rayCount)
  const total = counts.reduce((sum, count) => sum + count, 0)
  const id = `scan-${new Date().toISOString().replace(/[:.]/g, '-')}-${++sequence}`
  const createdAt = new Date().toISOString()
  const results: RadarScanResult[] = []
  let completed = 0, retained = 0
  const checkCanceled = () => { if (options.signal?.aborted) throw new DOMException('扫描已取消，保留上次完成的快照。', 'AbortError') }
  checkCanceled()
  options.progress?.({ completed, total, radarId: recipes[0]?.id ?? 0, retained })
  // 按真实候选射线计数并定期让出主线程，使进度、交互和取消均可响应。
  for (let station = 0; station < recipes.length; station++) {
    const radar = recipes[station]
    const points: ScanPoint[] = []
    const index = tolerance > 0 ? new PointIndex(tolerance) : null
    let deadline = performance.now() + (options.sliceMs ?? 8)
    let rawHits = 0
    for (const ray of cumulativeRays(radar)) {
      const point = firstCoalHit(frozenField, ray, radar.minRange, radar.maxRange)
      if (point) {
        rawHits++
        if (!index || !index.hasNeighbor(point)) { index?.add(point); points.push(Object.freeze(point)); retained++ }
      }
      completed++
      if (performance.now() >= deadline) {
        options.progress?.({ completed, total, radarId: radar.id, retained })
        await new Promise(resolve => setTimeout(resolve, 0))
        checkCanceled()
        deadline = performance.now() + (options.sliceMs ?? 8)
      }
    }
    results.push(Object.freeze({ radar, points: Object.freeze(points), candidates: counts[station], rawHits }))
    checkCanceled()
  }
  options.progress?.({ completed, total, radarId: recipes.at(-1)?.id ?? 0, retained })
  return Object.freeze({ id, createdAt, field: frozenField, tolerance, results: Object.freeze(results) })
}
