import { describe, expect, it } from 'vitest'
import { deduplicatePoints, localToWorld, overlapPoints, registrationError, stationTransform, worldToLocal } from './RadarAnalysis'
import { createRadar } from './RadarSimulation'

describe('雷达覆盖和固定站位真值', () => {
  it('默认保留重复，正容差跨哈希桶按欧氏距离保留首个代表点', () => {
    const points = [{ x: 0.99, y: 0, z: 0 }, { x: 1.01, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }]
    expect(deduplicatePoints(points)).toEqual(points)
    expect(deduplicatePoints(points, 0.1)).toEqual([points[0], points[2]])
  })
  it('双向统计以各自数量为分母，空云没有匹配点', () => {
    const a = [{ x: 0, y: 0, z: 0 }, { x: 0.1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }]
    const b = [{ x: 0, y: 0, z: 0 }]
    const result = overlapPoints(a, b, 0.2)
    expect(result.matchedA).toBe(2)
    expect(result.matchedB).toBe(1)
    expect(result.ratioA).toBeCloseTo(2 / 3)
    expect(result.ratioB).toBe(1)
    expect(result.commonA).toEqual(a.slice(0, 2))
    expect(overlapPoints([], b, 0.2).matchedB).toBe(0)
    expect(overlapPoints(a, [], 0.2).countA).toBe(3)
  })
  it('初始偏航定义固定局部轴，与侧装和云台无关，并可逆变换', () => {
    const radar = { ...createRadar(1, 20, 10), height: 42, initialYaw: 90, roll: 75, gimbalStart: 350 }
    const point = { x: 18, y: 13, z: 37 }
    const local = worldToLocal(point, radar)
    expect(local.x).toBeCloseTo(3)
    expect(local.y).toBeCloseTo(2)
    expect(local.z).toBe(-5)
    expect(worldToLocal(point, { ...radar, roll: -20, gimbalStart: 20 })).toEqual(local)
    const inverse = localToWorld(local, radar)
    expect(inverse.x).toBeCloseTo(point.x)
    expect(inverse.y).toBeCloseTo(point.y)
    expect(inverse.z).toBeCloseTo(point.z)
  })
  it('已知 B→A 变换可作为配准旋转与平移误差真值', () => {
    const a = { ...createRadar(1, 10, 0), initialYaw: 0, height: 40 }
    const b = { ...createRadar(2, 0, 20), initialYaw: 90, height: 45 }
    const truth = stationTransform(b, a)
    expect(truth.yaw).toBeCloseTo(90)
    expect(truth.translation).toEqual({ x: -10, y: 20, z: 5 })
    expect(registrationError(b, a, truth)).toEqual({ rotationDeg: 0, translationMeters: 0 })
    const error = registrationError(b, a, { yaw: 100, translation: { x: -7, y: 24, z: 5 } })
    expect(error.rotationDeg).toBeCloseTo(10)
    expect(error.translationMeters).toBe(5)
  })
})
