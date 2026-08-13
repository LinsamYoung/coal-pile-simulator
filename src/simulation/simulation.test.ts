import { describe, expect, it } from 'vitest'
import type { BrushSettings } from '../types'
import { HeightField } from './HeightField'
import { buildGroundGrid } from './GroundGridBuilder'
import { applyBrushStroke } from './BrushEngine'
import { calculateCoalStatistics } from './VolumeCalculator'

describe('ground grid', () => {
  it('takes the lowest point and fills empty cells', () => {
    const positions = new Float32Array([
      0, 0, 2,
      0, 0, 1,
      2, 0, 1.5,
      0, 2, 1.2,
      2, 2, 1.7,
    ])
    const { field } = buildGroundGrid(positions, 1, 100)
    expect(field.ground[field.index(0, 0)]).toBeCloseTo(1)
    expect([...field.ground].every(Number.isFinite)).toBe(true)
  })
})

describe('brush and volume model', () => {
  const settings: BrushSettings = {
    mode: 'deposit', radius: 2, strength: 2, falloff: 0.5, maxHeight: 10, reposeAngleDeg: 37, relaxation: 0,
  }

  it('adds coal, preserves the ground, and never excavates below zero', () => {
    const ground = new Float32Array(25).fill(3)
    const field = new HeightField({ rows: 5, cols: 5, cellSize: 1, ground })
    applyBrushStroke(field, { x: 2, y: 2 }, { x: 2, y: 2 }, 0.5, settings)
    // A single update is capped to 100 ms so a stalled frame cannot create a spike.
    expect(field.coal[field.index(2, 2)]).toBeCloseTo(0.2)
    expect(field.ground[field.index(2, 2)]).toBe(3)
    expect(calculateCoalStatistics(field, 0.8).volume).toBeGreaterThan(0.2)

    applyBrushStroke(field, { x: 2, y: 2 }, { x: 2, y: 2 }, 1, {
      ...settings, mode: 'excavate', strength: 100,
    })
    expect(Math.min(...field.coal)).toBeGreaterThanOrEqual(0)
    expect(field.coal[field.index(2, 2)]).toBe(0)
  })

  it('caps coal at the configured maximum height', () => {
    const field = new HeightField({ rows: 5, cols: 5, cellSize: 1 })
    applyBrushStroke(field, { x: 2, y: 2 }, { x: 2, y: 2 }, 10, { ...settings, maxHeight: 0.4 })
    expect(Math.max(...field.coal)).toBeLessThanOrEqual(0.4)
  })

  it('spreads an unstable peak through diagonal neighbours while preserving coal volume', () => {
    const field = new HeightField({ rows: 7, cols: 7, cellSize: 1 })
    const baseline = new HeightField({ rows: 7, cols: 7, cellSize: 1 })
    field.coal[field.index(3, 3)] = 8
    baseline.coal[baseline.index(3, 3)] = 8
    const stroke = {
      ...settings, strength: 1, reposeAngleDeg: 35, relaxation: 1,
    }
    applyBrushStroke(baseline, { x: 3, y: 3 }, { x: 3, y: 3 }, 0.001, { ...stroke, relaxation: 0 })
    applyBrushStroke(field, { x: 3, y: 3 }, { x: 3, y: 3 }, 0.001, stroke)
    const after = calculateCoalStatistics(field, 1).volume
    expect(after).toBeCloseTo(calculateCoalStatistics(baseline, 1).volume, 5)
    expect(field.coal[field.index(2, 2)]).toBeGreaterThan(0)
    expect(field.coal[field.index(3, 3)]).toBeLessThan(8)
  })

  it('uses the terrain surface, not only coal thickness, to determine a stable slope', () => {
    const ground = new Float32Array(25)
    ground[12] = 2
    const field = new HeightField({ rows: 5, cols: 5, cellSize: 1, ground })
    const baseline = new HeightField({ rows: 5, cols: 5, cellSize: 1, ground: ground.slice() })
    field.coal[12] = 1
    baseline.coal[12] = 1
    const stroke = {
      ...settings, strength: 1, reposeAngleDeg: 30, relaxation: 1,
    }
    applyBrushStroke(baseline, { x: 2, y: 2 }, { x: 2, y: 2 }, 0.001, { ...stroke, relaxation: 0 })
    applyBrushStroke(field, { x: 2, y: 2 }, { x: 2, y: 2 }, 0.001, stroke)
    expect(field.coal[12]).toBeLessThan(1)
    expect(calculateCoalStatistics(field, 1).volume).toBeCloseTo(calculateCoalStatistics(baseline, 1).volume, 5)
  })
})
