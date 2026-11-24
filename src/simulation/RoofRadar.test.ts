import { describe, expect, it } from 'vitest'
import { Ray, Vector3 } from 'three'
import { createCircularYard } from './CircularYard'
import { createRadar, cumulativeRays, firstCoalHit, gimbalAngles, physicalDirection, rayCount } from './RadarSimulation'
import { directionBins } from '../scene/RadarVisuals'

const roof = () => ({ ...createRadar(1, 20, 0), initialYaw: 0, spinStart: 0, spinSweep: 360, beamMin: 0, beamMax: 0, beamCount: 1, spinStep: 90, gimbalStart: 0, gimbalSweep: 0 })
const expectVector = (value: Vector3, expected: number[]) => { expect(value.x).toBeCloseTo(expected[0], 8); expect(value.y).toBeCloseTo(expected[1], 8); expect(value.z).toBeCloseTo(expected[2], 8) }

describe('屋顶物理累计扫描', () => {
  it('先侧装再云台，区分原线束角、旋转角、侧装角与初始朝向', () => {
    const radar = roof()
    expectVector(physicalDirection({ ...radar, roll: 0 }, 0, 90, 0), [0, 1, 0])
    expectVector(physicalDirection(radar, 0, 90, 0), [0, 0, 1])
    expectVector(physicalDirection(radar, 0, 270, 0), [0, 0, -1])
    expectVector(physicalDirection(radar, 30, 0, 90), [0.5, Math.sqrt(3) / 2, 0])
    expectVector(physicalDirection({ ...radar, initialYaw: 90 }, 30, 0, 0), [0.5, Math.sqrt(3) / 2, 0])
  })
  it('跨零累计保持连续角度，完整周回不会重复首姿态', () => {
    const radar = roof()
    expect(gimbalAngles({ ...radar, gimbalStart: 350, gimbalSweep: 20, gimbalStep: 10 })).toEqual([350, 360, 370])
    expect(gimbalAngles({ ...radar, gimbalStart: -725, gimbalSweep: 360, gimbalStep: 90 })).toEqual([-725, -635, -545, -455])
    expect(rayCount({ ...radar, gimbalSweep: 360, gimbalStep: 90 })).toBe(16)
    expect([...cumulativeRays({ ...radar, beamCount: 3, beamMin: -10, beamMax: 10 })]).toHaveLength(12)
  })
  it('圆内起点、竖直向下、地面及量程盲区均遵守首击', () => {
    const field = createCircularYard()
    for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) if (field.enabled[field.index(row, col)]) field.coal[field.index(row, col)] = 8
    const down = new Ray(new Vector3(20, 0, 45), new Vector3(0, 0, -1))
    expect(firstCoalHit(field, new Ray(new Vector3(-7, 0, 45), new Vector3(0, 0, -1)))?.z).toBeCloseTo(8, 8)
    expect(firstCoalHit(field, down)).toEqual({ x: 20, y: 0, z: 8 })
    expect(firstCoalHit(field, down, 38, 100)).toBeNull()
    expect(firstCoalHit(field, down, 0, 36)).toBeNull()
    expect(firstCoalHit(field, down, 37, 37.5)?.z).toBe(8)
    expect(firstCoalHit(field, new Ray(new Vector3(0, 0, 45), new Vector3(0, 0, -1)))).toBeNull()
    expect(firstCoalHit(field, new Ray(new Vector3(20, 0, 20), new Vector3(0, 0, 1)), 0, 100)).toBeNull()
    expect(firstCoalHit(field, new Ray(new Vector3(20, 0, 12), new Vector3(1, 0, 0)), 0, 100)).toBeNull()
    const interior = firstCoalHit(field, new Ray(new Vector3(20, 0, 45), new Vector3(1, 0, -2).normalize()), 0, 100)
    expect(interior?.z).toBeCloseTo(8, 8)
  })
  it('非竖直正交射线沿共享网格边时检查禁堆区外侧，并保留最近首击及盲区遮挡', () => {
    for (const axis of ['x', 'y'] as const) {
      const field = createCircularYard()
      for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) {
        const index = field.index(row, col)
        if (!field.enabled[index]) continue
        const across = axis === 'x' ? field.xAt(col) : field.yAt(row)
        const along = axis === 'x' ? field.yAt(row) : field.xAt(col)
        if (across <= -7) field.coal[index] = along <= 0 ? 8 : 4
      }
      const origin = axis === 'x' ? new Vector3(-7, -2, 10) : new Vector3(-2, -7, 10)
      const direction = axis === 'x' ? new Vector3(0, 1, -1) : new Vector3(1, 0, -1)
      const ray = new Ray(origin, direction.normalize())
      const hit = firstCoalHit(field, ray, 0, 30)
      expect(hit).not.toBeNull()
      expect(hit!.x).toBeCloseTo(axis === 'x' ? -7 : 0, 8)
      expect(hit!.y).toBeCloseTo(axis === 'x' ? 0 : -7, 8)
      expect(hit!.z).toBeCloseTo(8, 8)
      expect(firstCoalHit(field, ray, 3, 30)).toBeNull()
      expect(firstCoalHit(field, ray, 0, 2)).toBeNull()
    }
  })
  it('方向遮罩遵循实际稀疏采样集合，非零原视场改变最终边界', () => {
    const radar = { ...roof(), spinStep: 360 }
    const bins = directionBins(radar)
    expect(bins.filter(Boolean)).toHaveLength(1)
    expect(bins[0]).toBe(true)
    const nonzero = directionBins({ ...radar, beamMin: -30, beamMax: 30, beamCount: 2 })
    expect(nonzero.filter(Boolean)).toHaveLength(2)
    expect(nonzero[15]).toBe(true)
    expect(nonzero[165]).toBe(true)
  })
})
