import { describe, expect, it } from 'vitest'
import type { BrushSettings, RadarConfig } from '../types'
import { HeightField } from './HeightField'
import { buildGroundGrid } from './GroundGridBuilder'
import { applyBrushStroke } from './BrushEngine'
import { calculateCoalStatistics } from './VolumeCalculator'
import { generateRadarPointCloud } from './RadarStylePointCloud'

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
    mode: 'deposit', radius: 2, strength: 2, falloff: 0.5, maxHeight: 10, relaxation: 0,
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
})

describe('radar-style point cloud', () => {
  it('samples only a non-empty coal surface and returns radar fields', () => {
    const field = new HeightField({ rows: 4, cols: 4, cellSize: 1 })
    field.coal.fill(1)
    const config: RadarConfig = {
      position: [-2, 1.5, 2], yawDeg: 0, pitchDeg: -10,
      horizontalFovDeg: 160, verticalFovDeg: 120,
      minRange: 0.1, maxRange: 20, sampleCount: 30,
      rangeNoiseSigma: 0, dropoutRate: 0, outlierRate: 0,
    }
    let state = 12345
    const random = () => {
      state = (state * 16807) % 2147483647
      return (state - 1) / 2147483646
    }
    const points = generateRadarPointCloud(field, config, random)
    expect(points).toHaveLength(30)
    expect(points.every((point) => point.range > 0 && Number.isFinite(point.azimuth))).toBe(true)
  })

  it('returns no points when there is no coal', () => {
    const field = new HeightField({ rows: 3, cols: 3, cellSize: 1 })
    const config: RadarConfig = {
      position: [0, 0, 2], yawDeg: 0, pitchDeg: 0,
      horizontalFovDeg: 180, verticalFovDeg: 120,
      minRange: 0, maxRange: 10, sampleCount: 10,
      rangeNoiseSigma: 0, dropoutRate: 0, outlierRate: 0,
    }
    expect(generateRadarPointCloud(field, config)).toEqual([])
  })
})
