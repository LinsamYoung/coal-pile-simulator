import type { PointCloudData, SourceScanGrid } from '../types'

interface DeltaSample {
  dx: number
  dy: number
  distance: number
}

/** Infer the source PLY scan-line basis and spacing from its original order. */
export function analyzeSourceScanGrid(source: PointCloudData): SourceScanGrid {
  if (source.pointCount < 4) throw new Error('源点云点数过少，无法分析扫描网格。')
  const maxSamples = 120_000
  const stride = Math.max(1, Math.floor((source.pointCount - 1) / maxSamples))
  const deltas: DeltaSample[] = []
  for (let index = stride; index < source.pointCount; index += stride) {
    // Sample many original consecutive pairs. Comparing index-stride would
    // multiply the inferred spacing whenever the cloud is downsampled here.
    const previous = index - 1
    const dx = source.positions[index * 3] - source.positions[previous * 3]
    const dy = source.positions[index * 3 + 1] - source.positions[previous * 3 + 1]
    const distance = Math.hypot(dx, dy)
    if (Number.isFinite(distance) && distance > 1e-5) deltas.push({ dx, dy, distance })
  }
  if (deltas.length < 3) throw new Error('源点云缺少可分析的相邻点。')

  const distances = deltas.map((delta) => delta.distance).sort((a, b) => a - b)
  const localScale = percentile(distances, 0.35)
  // Scan-line steps dominate the short-distance mode; row-wrap jumps must not
  // influence its direction even in small samples.
  const shortLimit = Math.max(localScale * 1.55, percentile(distances, 0.12) * 1.6)
  const short = deltas.filter((delta) => delta.distance <= shortLimit)
  const directionSamples = short.length >= 3 ? short : deltas.slice(0, Math.min(2_000, deltas.length))

  // A doubled-angle mean treats a direction and its reverse as the same line.
  let cos2 = 0
  let sin2 = 0
  for (const delta of directionSamples) {
    const angle = Math.atan2(delta.dy, delta.dx)
    const weight = 1 / Math.max(delta.distance, localScale * 0.4)
    cos2 += Math.cos(2 * angle) * weight
    sin2 += Math.sin(2 * angle) * weight
  }
  let angle = 0.5 * Math.atan2(sin2, cos2)
  let alongX = Math.cos(angle)
  let alongY = Math.sin(angle)
  let signedProgress = 0
  for (const delta of directionSamples) signedProgress += delta.dx * alongX + delta.dy * alongY
  if (signedProgress < 0) {
    alongX *= -1
    alongY *= -1
    angle += Math.PI
  }
  const crossX = -alongY
  const crossY = alongX

  const alongCandidates: number[] = []
  for (const delta of directionSamples) {
    const along = Math.abs(delta.dx * alongX + delta.dy * alongY)
    const cross = Math.abs(delta.dx * crossX + delta.dy * crossY)
    if (along > 1e-5 && cross <= Math.max(along * 0.45, localScale * 0.2)) alongCandidates.push(along)
  }
  alongCandidates.sort((a, b) => a - b)
  const alongSpacing = robustBaseSpacing(alongCandidates, localScale)

  const crossCandidates: number[] = []
  for (const delta of deltas) {
    const cross = Math.abs(delta.dx * crossX + delta.dy * crossY)
    if (cross >= alongSpacing * 0.55 && cross <= alongSpacing * 1.8) crossCandidates.push(cross)
  }
  crossCandidates.sort((a, b) => a - b)
  const crossSpacing = crossCandidates.length >= 8
    ? clamp(percentile(crossCandidates, 0.4), alongSpacing * 0.55, alongSpacing * 1.8)
    : alongSpacing

  let minAlong = Infinity
  let minCross = Infinity
  const phaseAlong: number[] = []
  const phaseCross: number[] = []
  const phaseStride = Math.max(1, Math.floor(source.pointCount / 40_000))
  for (let index = 0; index < source.pointCount; index += phaseStride) {
    const x = source.positions[index * 3]
    const y = source.positions[index * 3 + 1]
    const along = x * alongX + y * alongY
    const cross = x * crossX + y * crossY
    minAlong = Math.min(minAlong, along)
    minCross = Math.min(minCross, cross)
    phaseAlong.push(positiveModulo(along, alongSpacing))
    phaseCross.push(positiveModulo(cross, crossSpacing))
  }
  // Circular phase estimation anchors generated rows to the source lattice.
  const originAlong = phaseOrigin(phaseAlong, alongSpacing, minAlong)
  const originCross = phaseOrigin(phaseCross, crossSpacing, minCross)
  const coherence = Math.hypot(cos2, sin2) / Math.max(1, directionSamples.reduce(
    (sum, delta) => sum + 1 / Math.max(delta.distance, localScale * 0.4),
    0,
  ))

  return {
    alongAxis: [alongX, alongY],
    crossAxis: [crossX, crossY],
    alongSpacing,
    crossSpacing,
    originAlong,
    originCross,
    angleDeg: normalizeAngle(angle * 180 / Math.PI),
    confidence: clamp(coherence, 0, 1),
  }
}

export function pointToGrid(
  grid: SourceScanGrid,
  x: number,
  y: number,
): { alongIndex: number; lineIndex: number; error: number } {
  const along = x * grid.alongAxis[0] + y * grid.alongAxis[1]
  const cross = x * grid.crossAxis[0] + y * grid.crossAxis[1]
  const alongIndex = Math.round((along - grid.originAlong) / grid.alongSpacing)
  const lineIndex = Math.round((cross - grid.originCross) / grid.crossSpacing)
  const snapped = gridToPoint(grid, alongIndex, lineIndex)
  return { alongIndex, lineIndex, error: Math.hypot(x - snapped.x, y - snapped.y) }
}

export function gridToPoint(
  grid: SourceScanGrid,
  alongIndex: number,
  lineIndex: number,
): { x: number; y: number } {
  const along = grid.originAlong + alongIndex * grid.alongSpacing
  const cross = grid.originCross + lineIndex * grid.crossSpacing
  return {
    x: along * grid.alongAxis[0] + cross * grid.crossAxis[0],
    y: along * grid.alongAxis[1] + cross * grid.crossAxis[1],
  }
}

function robustBaseSpacing(sorted: number[], fallback: number): number {
  if (sorted.length === 0) return Math.max(0.01, fallback)
  const lower = percentile(sorted, 0.12)
  const upper = percentile(sorted, 0.62)
  const band = sorted.filter((value) => value >= lower * 0.75 && value <= Math.min(upper, lower * 1.8))
  return Math.max(0.005, percentile(band.length ? band : sorted, 0.5))
}

function phaseOrigin(phases: number[], spacing: number, minimum: number): number {
  let sin = 0
  let cos = 0
  for (const phase of phases) {
    const angle = 2 * Math.PI * phase / spacing
    sin += Math.sin(angle)
    cos += Math.cos(angle)
  }
  let phase = Math.atan2(sin, cos) * spacing / (2 * Math.PI)
  if (phase < 0) phase += spacing
  return phase + Math.floor((minimum - phase) / spacing) * spacing
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))]
}

function normalizeAngle(value: number): number {
  let angle = value % 180
  if (angle < -90) angle += 180
  if (angle >= 90) angle -= 180
  return angle
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
