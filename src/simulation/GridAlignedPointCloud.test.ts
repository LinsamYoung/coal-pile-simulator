import { describe, expect, it } from 'vitest'
import type { PointCloudData } from '../types'
import { HeightField } from './HeightField'
import { buildGridAlignedReplacements } from './GridAlignedPointCloud'

function sourceFromPositions(positions: number[]): PointCloudData {
  return {
    positions: new Float32Array(positions),
    sourceBuffer: new ArrayBuffer(0),
    pointCount: positions.length / 3,
    sourceName: 'test.ply',
    sourceMin: [100, 200, 300],
    sourceMax: [102, 202, 305],
  }
}

describe('grid-aligned Mode-B generation', () => {
  it('preserves source indices and XY while replacing only covered ground points', () => {
    const field = new HeightField({ rows: 3, cols: 3, cellSize: 1 })
    field.coal.fill(2)
    const source = sourceFromPositions([
      0, 0, 0.05,
      1, 0, 0.02,
      2, 0, 4,
      0, 1, 0.01,
    ])
    const result = buildGridAlignedReplacements(source, field, { groundTolerance: 0.2 })
    expect(result.replacements.map((point) => point.index)).toEqual([0, 1, 3])
    expect(result.replacements.map((point) => [point.x, point.y])).toEqual([[0, 0], [1, 0], [0, 1]])
    expect(result.replacements[0].z).toBeCloseTo(2.05)
    expect(result.replacements[1].z).toBeCloseTo(2.02)
    expect(result.replacements[2].z).toBeCloseTo(2.01)
    expect(result.preservedSourcePoints).toBe(1)
  })

  it('does not replace points outside coal coverage', () => {
    const field = new HeightField({ rows: 3, cols: 3, cellSize: 1 })
    const source = sourceFromPositions([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])
    const result = buildGridAlignedReplacements(source, field)
    expect(result.replacements).toEqual([])
    expect(result.additions).toEqual([])
  })

  it('fills a missing source lattice position with matching scan alignment', () => {
    const field = new HeightField({ rows: 3, cols: 3, cellSize: 1 })
    field.coal.fill(2)
    const source = sourceFromPositions([
      0, 0, 0, 1, 0, 0, 2, 0, 0,
      0, 1, 0,           2, 1, 0,
      0, 2, 0, 1, 2, 0, 2, 2, 0,
    ])
    const result = buildGridAlignedReplacements(source, field, { transitionCells: 1 })
    expect(result.additions.some((point) => Math.abs(point.x - 1) < 0.15 && Math.abs(point.y - 1) < 0.15)).toBe(true)
    expect(result.outputPointCount).toBe(source.pointCount + result.additions.length)
    expect(result.scanGrid.alongSpacing).toBeCloseTo(1, 1)
    expect(result.scanGrid.crossSpacing).toBeCloseTo(1, 1)
  })

  it('smoothly interpolates source residuals without periodic template bands', () => {
    const size = 22
    const positions: number[] = []
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        // A central source-data hole forces B+ additions. Surrounding source
        // residuals deliberately jump every four rows, like a bad template.
        if (row >= 5 && row <= 16 && col >= 5 && col <= 16) continue
        const residual = Math.floor(row / 4) % 2 === 0 ? 0.02 : 0.14
        positions.push(col, row, residual)
      }
    }
    const field = new HeightField({ rows: size, cols: size, cellSize: 1 })
    field.coal.fill(3)
    const source = sourceFromPositions(positions)
    source.sourceMax = [size - 1, size - 1, 3]
    const result = buildGridAlignedReplacements(source, field, {
      groundTolerance: 0.3,
      transitionCells: 1,
    })
    expect(result.additions.length).toBeGreaterThan(80)

    const byLine = new Map<number, number[]>()
    for (const point of result.additions) {
      const values = byLine.get(point.scanLineIndex) ?? []
      values.push(point.z - 3)
      byLine.set(point.scanLineIndex, values)
    }
    const lineMeans = [...byLine.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, values]) => values.reduce((sum, value) => sum + value, 0) / values.length)
    let maximumLineJump = 0
    for (let index = 1; index < lineMeans.length; index += 1) {
      maximumLineJump = Math.max(maximumLineJump, Math.abs(lineMeans[index] - lineMeans[index - 1]))
    }
    expect(maximumLineJump).toBeLessThan(0.06)
  })
})
