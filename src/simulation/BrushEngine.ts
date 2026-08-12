import type { BrushSettings } from '../types'
import { HeightField } from './HeightField'

export interface BrushPoint {
  x: number
  y: number
}

export function applyBrushStroke(
  field: HeightField,
  from: BrushPoint,
  to: BrushPoint,
  deltaSeconds: number,
  settings: BrushSettings,
): number[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const spacing = Math.max(field.cellSize * 0.5, settings.radius * 0.22)
  const sampleCount = Math.max(1, Math.ceil(distance / spacing))
  const changed = new Set<number>()
  const deltaPerSample = Math.min(0.1, Math.max(0.001, deltaSeconds)) / sampleCount

  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const ratio = sample / sampleCount
    const x = from.x + (to.x - from.x) * ratio
    const y = from.y + (to.y - from.y) * ratio
    applyDab(field, x, y, deltaPerSample, settings, changed)
  }

  if (settings.relaxation > 0 && changed.size > 0 && settings.mode === 'deposit') {
    relaxCoal(field, changed, settings.relaxation)
  }
  return [...changed]
}

function applyDab(
  field: HeightField,
  centerX: number,
  centerY: number,
  deltaSeconds: number,
  settings: BrushSettings,
  changed: Set<number>,
): void {
  const minCol = Math.max(0, Math.floor((centerX - settings.radius - field.originX) / field.cellSize))
  const maxCol = Math.min(field.cols - 1, Math.ceil((centerX + settings.radius - field.originX) / field.cellSize))
  const minRow = Math.max(0, Math.floor((centerY - settings.radius - field.originY) / field.cellSize))
  const maxRow = Math.min(field.rows - 1, Math.ceil((centerY + settings.radius - field.originY) / field.cellSize))
  const exponent = 0.55 + settings.falloff * 2.8

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      const dx = field.xAt(col) - centerX
      const dy = field.yAt(row) - centerY
      const distance = Math.hypot(dx, dy)
      if (distance > settings.radius) continue
      const index = field.index(row, col)
      if (!field.enabled[index]) continue
      const t = Math.max(0, 1 - distance / settings.radius)
      const smooth = t * t * (3 - 2 * t)
      const weight = Math.pow(smooth, exponent)
      const amount = settings.strength * weight * deltaSeconds
      const previous = field.coal[index]
      field.coal[index] = settings.mode === 'deposit'
        ? Math.min(settings.maxHeight, previous + amount)
        : Math.max(0, previous - amount)
      if (field.coal[index] !== previous) changed.add(index)
    }
  }
}

function relaxCoal(field: HeightField, changed: Set<number>, amount: number): void {
  const transfers: Array<[number, number, number]> = []
  const maxSlope = field.cellSize * 0.9
  for (const index of changed) {
    const row = Math.floor(index / field.cols)
    const col = index % field.cols
    const neighbors = [
      col > 0 ? index - 1 : -1,
      col < field.cols - 1 ? index + 1 : -1,
      row > 0 ? index - field.cols : -1,
      row < field.rows - 1 ? index + field.cols : -1,
    ]
    for (const neighbor of neighbors) {
      if (neighbor < 0 || !field.enabled[neighbor]) continue
      const difference = field.surfaceAt(index) - field.surfaceAt(neighbor)
      if (difference <= maxSlope || field.coal[index] <= 0) continue
      const transfer = Math.min(field.coal[index] * 0.08, (difference - maxSlope) * 0.12 * amount)
      if (transfer > 0) transfers.push([index, neighbor, transfer])
    }
  }
  for (const [from, to, transfer] of transfers) {
    const actual = Math.min(field.coal[from], transfer)
    field.coal[from] -= actual
    field.coal[to] += actual
    changed.add(to)
  }
}
