import type {
  GridPointAddition,
  GridPointReplacement,
  GridReplacementResult,
  PointCloudData,
  SourceScanGrid,
} from '../types'
import { HeightField } from './HeightField'
import { analyzeSourceScanGrid, gridToPoint, pointToGrid } from './SourceScanGrid'

export interface GridReplacementOptions {
  coalThreshold: number
  groundTolerance: number
  preserveSourceZResidual: boolean
  /** Number of source grid spacings used to taper the pile into the ground. */
  transitionCells: number
  /** Maximum number of synthesized gap points for browser safety. */
  maxAdditions: number
}

const DEFAULT_OPTIONS: GridReplacementOptions = {
  coalThreshold: 0.0001,
  groundTolerance: 0.35,
  preserveSourceZResidual: true,
  transitionCells: 3,
  maxAdditions: 750_000,
}

interface SourceGridEntry {
  anyIndex: number
  groundIndex: number
  groundResidual: number
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface SourceResidualModel {
  median: number
  limit: number
}

interface SourceSpatialIndex {
  cellSize: number
  buckets: Map<string, number[]>
}

/**
 * Mode B+: replace covered source ground points and synthesize only missing
 * lattice positions inside the pile/contact skirt. Added XY values are snapped
 * to the inferred source scan basis and therefore retain its linear layout.
 */
export function buildGridAlignedReplacements(
  source: PointCloudData,
  field: HeightField,
  options: Partial<GridReplacementOptions> = {},
): GridReplacementResult {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const scanGrid = analyzeSourceScanGrid(source)
  const sourceGrid = new Map<string, SourceGridEntry>()
  const residualSamples: number[] = []
  const sourceBounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const snapTolerance = Math.hypot(scanGrid.alongSpacing, scanGrid.crossSpacing) * 0.52
  const sourceSpatialIndex = createSourceSpatialIndex(
    source,
    field,
    settings.groundTolerance,
    Math.min(scanGrid.alongSpacing, scanGrid.crossSpacing) * 0.72,
  )

  // Preserve file order while indexing source XY onto its inferred lattice.
  for (let index = 0; index < source.pointCount; index += 1) {
    const x = source.positions[index * 3]
    const y = source.positions[index * 3 + 1]
    const z = source.positions[index * 3 + 2]
    sourceBounds.minX = Math.min(sourceBounds.minX, x)
    sourceBounds.minY = Math.min(sourceBounds.minY, y)
    sourceBounds.maxX = Math.max(sourceBounds.maxX, x)
    sourceBounds.maxY = Math.max(sourceBounds.maxY, y)
    const coordinate = pointToGrid(scanGrid, x, y)
    if (coordinate.error > snapTolerance) continue
    const key = gridKey(coordinate.alongIndex, coordinate.lineIndex)
    const sampled = bilinearSampleField(field, x, y)
    const residual = sampled ? z - sampled.ground : Infinity
    if (Number.isFinite(residual) && Math.abs(residual) <= settings.groundTolerance) {
      // Bounded reservoir-like sampling keeps robust statistics inexpensive.
      if (residualSamples.length < 50_000 || index % 17 === 0 && residualSamples.length < 80_000) {
        residualSamples.push(residual)
      }
    }
    const existing = sourceGrid.get(key)
    if (!existing) {
      sourceGrid.set(key, {
        anyIndex: index,
        groundIndex: Math.abs(residual) <= settings.groundTolerance ? index : -1,
        groundResidual: residual,
      })
    } else if (Math.abs(residual) < Math.abs(existing.groundResidual)) {
      existing.groundResidual = residual
      if (Math.abs(residual) <= settings.groundTolerance) existing.groundIndex = index
    }
  }

  const activeBounds = findActiveCoalBounds(field, settings.coalThreshold)
  if (!activeBounds) return emptyResult(source, scanGrid)
  const transitionWidth = Math.max(scanGrid.alongSpacing, scanGrid.crossSpacing) * settings.transitionCells
  const contactCoal = buildContinuousContactCoalField(field, settings.coalThreshold, transitionWidth)
  const residualModel = buildResidualModel(residualSamples, settings.groundTolerance)
  const expanded = {
    minX: Math.max(sourceBounds.minX, activeBounds.minX - transitionWidth),
    minY: Math.max(sourceBounds.minY, activeBounds.minY - transitionWidth),
    maxX: Math.min(sourceBounds.maxX, activeBounds.maxX + transitionWidth),
    maxY: Math.min(sourceBounds.maxY, activeBounds.maxY + transitionWidth),
  }
  const gridRange = projectedGridRange(scanGrid, expanded)
  const replacements: GridPointReplacement[] = []
  const additions: GridPointAddition[] = []
  const replacedGridKeys = new Set<string>()
  let targetGridPoints = 0

  // Replacement stays source-driven: every eligible existing ground point is
  // retained at its exact original XY and original vertex index.
  for (let index = 0; index < source.pointCount; index += 1) {
    const x = source.positions[index * 3]
    const y = source.positions[index * 3 + 1]
    if (!insideBounds(x, y, expanded)) continue
    const surface = samplePreparedSurface(field, contactCoal, x, y)
    if (!surface || surface.coal <= settings.coalThreshold) continue
    const sourceZ = source.positions[index * 3 + 2]
    const residual = sourceZ - surface.ground
    if (Math.abs(residual) > settings.groundTolerance) continue
    replacements.push({
      index,
      x,
      y,
      z: surface.ground + surface.coal + (settings.preserveSourceZResidual
        ? clamp(residual, -settings.groundTolerance, settings.groundTolerance)
        : 0),
      intensity: source.intensities?.[index],
    })
    const coordinate = pointToGrid(scanGrid, x, y)
    replacedGridKeys.add(gridKey(coordinate.alongIndex, coordinate.lineIndex))
  }

  for (let lineIndex = gridRange.minLine; lineIndex <= gridRange.maxLine; lineIndex += 1) {
    for (let alongIndex = gridRange.minAlong; alongIndex <= gridRange.maxAlong; alongIndex += 1) {
      const position = gridToPoint(scanGrid, alongIndex, lineIndex)
      if (!insideBounds(position.x, position.y, expanded)) continue
      const surface = samplePreparedSurface(field, contactCoal, position.x, position.y)
      if (!surface || surface.coal <= settings.coalThreshold) continue
      targetGridPoints += 1
      const key = gridKey(alongIndex, lineIndex)
      if (replacedGridKeys.has(key)) continue
      const sourceEntry = sourceGrid.get(key)
      if (sourceEntry?.groundIndex !== undefined && sourceEntry.groundIndex >= 0) continue

      // A global grid cannot model every small scan-line drift. Do a physical
      // proximity check as well, otherwise phase drift periodically creates a
      // second row beside an existing row and appears as bright/dark stripes.
      if (hasNearbySourcePoint(
        source,
        sourceSpatialIndex,
        position.x,
        position.y,
        Math.min(scanGrid.alongSpacing, scanGrid.crossSpacing) * 0.58,
      )) continue

      if (additions.length >= settings.maxAdditions) {
        throw new Error(`需要补充的网格点超过 ${settings.maxAdditions.toLocaleString()}，请减小煤堆范围或增加源网格间距。`)
      }
      const templateIndex = findNearestTemplateIndex(sourceGrid, alongIndex, lineIndex)
      const surfaceResidual = settings.preserveSourceZResidual
        ? interpolateResidualContinuously(
          sourceGrid,
          alongIndex,
          lineIndex,
          residualModel,
        )
        : 0
      additions.push({
        x: position.x,
        y: position.y,
        z: surface.ground + surface.coal + surfaceResidual,
        templateIndex,
        scanLineIndex: lineIndex,
        pointIndexInLine: alongIndex,
      })
    }
  }

  additions.sort((a, b) => a.scanLineIndex - b.scanLineIndex || a.pointIndexInLine - b.pointIndexInLine)
  const filled = replacements.length + additions.length
  return {
    replacements,
    additions,
    scanGrid,
    coveredSourcePoints: replacements.length,
    preservedSourcePoints: source.pointCount - replacements.length,
    filledGapPoints: additions.length,
    targetGridPoints,
    outputPointCount: source.pointCount + additions.length,
    coveragePercent: targetGridPoints > 0 ? Math.min(100, filled / targetGridPoints * 100) : 100,
  }
}

export function bilinearSampleField(
  field: HeightField,
  x: number,
  y: number,
): { ground: number; coal: number } | null {
  const gridX = (x - field.originX) / field.cellSize
  const gridY = (y - field.originY) / field.cellSize
  if (gridX < 0 || gridY < 0 || gridX > field.cols - 1 || gridY > field.rows - 1) return null
  const col0 = Math.min(field.cols - 2, Math.max(0, Math.floor(gridX)))
  const row0 = Math.min(field.rows - 2, Math.max(0, Math.floor(gridY)))
  const col1 = col0 + 1
  const row1 = row0 + 1
  const tx = clamp(gridX - col0, 0, 1)
  const ty = clamp(gridY - row0, 0, 1)
  const sample = (values: Float32Array) => {
    const v00 = values[field.index(row0, col0)]
    const v10 = values[field.index(row0, col1)]
    const v01 = values[field.index(row1, col0)]
    const v11 = values[field.index(row1, col1)]
    return (v00 + (v10 - v00) * tx) * (1 - ty) + (v01 + (v11 - v01) * tx) * ty
  }
  return { ground: sample(field.ground), coal: sample(field.coal) }
}

function buildContinuousContactCoalField(
  field: HeightField,
  threshold: number,
  transitionWidth: number,
): Float32Array {
  const result = field.coal.slice()
  const maxOffset = Math.max(1, Math.ceil(transitionWidth / field.cellSize))
  const active: Array<{ dx: number; dy: number; distance: number }> = []
  for (let dy = -maxOffset; dy <= maxOffset; dy += 1) {
    for (let dx = -maxOffset; dx <= maxOffset; dx += 1) {
      if (dx === 0 && dy === 0) continue
      const distance = Math.hypot(dx, dy) * field.cellSize
      if (distance <= transitionWidth + field.cellSize * 0.75) active.push({ dx, dy, distance })
    }
  }
  active.sort((a, b) => a.distance - b.distance)

  for (let row = 0; row < field.rows; row += 1) {
    for (let col = 0; col < field.cols; col += 1) {
      const index = field.index(row, col)
      if (field.coal[index] > threshold) continue
      let weightedCoal = 0
      let weightSum = 0
      for (const offset of active) {
        const neighborRow = row + offset.dy
        const neighborCol = col + offset.dx
        if (neighborRow < 0 || neighborRow >= field.rows || neighborCol < 0 || neighborCol >= field.cols) continue
        const coal = field.coal[field.index(neighborRow, neighborCol)]
        if (coal <= threshold) continue
        // Continuous compact kernel avoids the former 0.5 m ring quantization.
        const normalized = clamp(1 - offset.distance / (transitionWidth + field.cellSize), 0, 1)
        const weight = normalized * normalized * (3 - 2 * normalized)
        weightedCoal += coal * weight
        weightSum += weight
      }
      if (weightSum > 0) result[index] = weightedCoal / weightSum * clamp(weightSum, 0, 1)
    }
  }
  return result
}

function samplePreparedSurface(
  field: HeightField,
  preparedCoal: Float32Array,
  x: number,
  y: number,
): { ground: number; coal: number } | null {
  const sampled = bilinearSampleArrays(field, x, y, field.ground, preparedCoal)
  return sampled ? { ground: sampled.first, coal: sampled.second } : null
}

function bilinearSampleArrays(
  field: HeightField,
  x: number,
  y: number,
  first: Float32Array,
  second: Float32Array,
): { first: number; second: number } | null {
  const gridX = (x - field.originX) / field.cellSize
  const gridY = (y - field.originY) / field.cellSize
  if (gridX < 0 || gridY < 0 || gridX > field.cols - 1 || gridY > field.rows - 1) return null
  const col0 = Math.min(field.cols - 2, Math.max(0, Math.floor(gridX)))
  const row0 = Math.min(field.rows - 2, Math.max(0, Math.floor(gridY)))
  const col1 = col0 + 1
  const row1 = row0 + 1
  const tx = clamp(gridX - col0, 0, 1)
  const ty = clamp(gridY - row0, 0, 1)
  const sample = (values: Float32Array) => {
    const v00 = values[field.index(row0, col0)]
    const v10 = values[field.index(row0, col1)]
    const v01 = values[field.index(row1, col0)]
    const v11 = values[field.index(row1, col1)]
    return (v00 + (v10 - v00) * tx) * (1 - ty) + (v01 + (v11 - v01) * tx) * ty
  }
  return { first: sample(first), second: sample(second) }
}

function buildResidualModel(samples: number[], groundTolerance: number): SourceResidualModel {
  if (samples.length === 0) return { median: 0, limit: Math.min(0.02, groundTolerance) }
  const sorted = samples.slice().sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
  const mad = deviations[Math.floor(deviations.length / 2)]
  // 1.4826*MAD estimates sigma. Limit generated texture to measurement-scale
  // variation rather than the much wider device-rejection tolerance.
  // Large residual variation is usually ground-model bias or an existing
  // object, not scanner noise. Carrying it onto synthesized rows creates
  // visible contour bands, so retain only measurement-scale texture.
  const limit = Math.min(groundTolerance, 0.025, Math.max(0.006, mad * 1.4826 * 1.5))
  return { median, limit }
}

function interpolateResidualContinuously(
  sourceGrid: ReadonlyMap<string, SourceGridEntry>,
  alongIndex: number,
  lineIndex: number,
  model: SourceResidualModel,
): number {
  let weighted = 0
  let weightSum = 0
  const radius = 10
  for (let lineOffset = -radius; lineOffset <= radius; lineOffset += 1) {
    for (let alongOffset = -radius; alongOffset <= radius; alongOffset += 1) {
      const entry = sourceGrid.get(gridKey(alongIndex + alongOffset, lineIndex + lineOffset))
      if (!entry || !Number.isFinite(entry.groundResidual)) continue
      const distanceSquared = alongOffset * alongOffset + lineOffset * lineOffset
      const weight = 1 / Math.pow(1 + distanceSquared, 1.35)
      const residual = clamp(entry.groundResidual - model.median, -model.limit, model.limit)
      weighted += residual * weight
      weightSum += weight
    }
  }
  if (weightSum === 0) return model.median
  return model.median + weighted / weightSum
}

function createSourceSpatialIndex(
  source: PointCloudData,
  field: HeightField,
  groundTolerance: number,
  requestedCellSize: number,
): SourceSpatialIndex {
  const cellSize = Math.max(0.005, requestedCellSize)
  const buckets = new Map<string, number[]>()
  for (let index = 0; index < source.pointCount; index += 1) {
    const x = source.positions[index * 3]
    const y = source.positions[index * 3 + 1]
    const z = source.positions[index * 3 + 2]
    const ground = bilinearSampleField(field, x, y)?.ground
    if (ground === undefined || Math.abs(z - ground) > groundTolerance) continue
    const key = spatialKey(Math.floor(x / cellSize), Math.floor(y / cellSize))
    const bucket = buckets.get(key)
    if (bucket) bucket.push(index)
    else buckets.set(key, [index])
  }
  return { cellSize, buckets }
}

function hasNearbySourcePoint(
  source: PointCloudData,
  index: SourceSpatialIndex,
  x: number,
  y: number,
  radius: number,
): boolean {
  const centerX = Math.floor(x / index.cellSize)
  const centerY = Math.floor(y / index.cellSize)
  const cells = Math.max(1, Math.ceil(radius / index.cellSize))
  const radiusSquared = radius * radius
  for (let dy = -cells; dy <= cells; dy += 1) {
    for (let dx = -cells; dx <= cells; dx += 1) {
      const bucket = index.buckets.get(spatialKey(centerX + dx, centerY + dy))
      if (!bucket) continue
      for (const pointIndex of bucket) {
        const px = source.positions[pointIndex * 3]
        const py = source.positions[pointIndex * 3 + 1]
        if ((px - x) ** 2 + (py - y) ** 2 <= radiusSquared) return true
      }
    }
  }
  return false
}

function spatialKey(x: number, y: number): string {
  return `${x}:${y}`
}

function findActiveCoalBounds(field: HeightField, threshold: number): Bounds | null {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  let found = false
  for (let row = 0; row < field.rows; row += 1) {
    for (let col = 0; col < field.cols; col += 1) {
      if (field.coal[field.index(row, col)] <= threshold) continue
      found = true
      const x = field.xAt(col)
      const y = field.yAt(row)
      bounds.minX = Math.min(bounds.minX, x)
      bounds.minY = Math.min(bounds.minY, y)
      bounds.maxX = Math.max(bounds.maxX, x)
      bounds.maxY = Math.max(bounds.maxY, y)
    }
  }
  return found ? bounds : null
}

function projectedGridRange(grid: SourceScanGrid, bounds: Bounds) {
  const corners = [
    [bounds.minX, bounds.minY], [bounds.minX, bounds.maxY],
    [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY],
  ]
  const projected = corners.map(([x, y]) => pointToGrid(grid, x, y))
  return {
    minAlong: Math.min(...projected.map((point) => point.alongIndex)) - 1,
    maxAlong: Math.max(...projected.map((point) => point.alongIndex)) + 1,
    minLine: Math.min(...projected.map((point) => point.lineIndex)) - 1,
    maxLine: Math.max(...projected.map((point) => point.lineIndex)) + 1,
  }
}

function findNearestTemplateIndex(
  sourceGrid: ReadonlyMap<string, SourceGridEntry>,
  alongIndex: number,
  lineIndex: number,
): number {
  for (let radius = 0; radius <= 8; radius += 1) {
    for (let lineOffset = -radius; lineOffset <= radius; lineOffset += 1) {
      for (const alongOffset of [-radius, radius]) {
        const entry = sourceGrid.get(gridKey(alongIndex + alongOffset, lineIndex + lineOffset))
        if (entry) return entry.groundIndex >= 0 ? entry.groundIndex : entry.anyIndex
      }
    }
    for (let alongOffset = -radius + 1; alongOffset < radius; alongOffset += 1) {
      for (const lineOffset of [-radius, radius]) {
        const entry = sourceGrid.get(gridKey(alongIndex + alongOffset, lineIndex + lineOffset))
        if (entry) return entry.groundIndex >= 0 ? entry.groundIndex : entry.anyIndex
      }
    }
  }
  return 0
}

function emptyResult(source: PointCloudData, scanGrid: SourceScanGrid): GridReplacementResult {
  return {
    replacements: [], additions: [], scanGrid,
    coveredSourcePoints: 0, preservedSourcePoints: source.pointCount,
    filledGapPoints: 0, targetGridPoints: 0, outputPointCount: source.pointCount,
    coveragePercent: 100,
  }
}

function insideBounds(x: number, y: number, bounds: Bounds): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY
}

function gridKey(alongIndex: number, lineIndex: number): string {
  return `${lineIndex}:${alongIndex}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
