import type { CoalStatistics } from '../types'
import { HeightField } from './HeightField'

export function calculateCoalStatistics(field: HeightField, density: number): CoalStatistics {
  let thicknessSum = 0
  let maxHeight = 0
  let activeCells = 0
  for (const thickness of field.coal) {
    thicknessSum += thickness
    maxHeight = Math.max(maxHeight, thickness)
    if (thickness > 0.001) activeCells += 1
  }
  const volume = thicknessSum * field.cellSize * field.cellSize
  return { volume, mass: volume * density, maxHeight, activeCells }
}
