import { describe, expect, it } from 'vitest'
import { alignStation, createRadar, copyRadarAt, cumulativeRays, spinAngles } from './RadarSimulation'
import { floorReachPoints } from '../scene/RadarVisuals'

describe('简化前下方扫描与参考可达范围', () => {
  it('演示初值固定为侧装32束、有限距离和前下方旋转窗口', () => {
    const radar = createRadar(1, 30, 0)
    expect(radar).toMatchObject({ roll: 90, beamCount: 32, beamMin: -16, beamMax: 15, spinStep: 1, gimbalStep: 3, minRange: 0.05, maxRange: 58, spinStart: 0, spinSweep: 360, gimbalSweep: 180, gimbalStart: -90 })
    expect(spinAngles(radar)).toHaveLength(360)
    expect(spinAngles(radar).at(0)).toBe(0)
    expect(spinAngles(radar).at(-1)).toBe(359)
  })
  it('无云台偏转时实际射线只朝前方和下方，完整原生窗口仍可作对比', () => {
    const radar = { ...createRadar(1, 30, 0), gimbalStart: 0, gimbalSweep: 0, spinStart: 270, spinSweep: 90 }
    const yaw = radar.initialYaw! * Math.PI / 180
    for (const ray of cumulativeRays(radar)) {
      expect(ray.direction.z).toBeLessThanOrEqual(1e-10)
      expect(ray.direction.x * Math.cos(yaw) + ray.direction.y * Math.sin(yaw)).toBeGreaterThanOrEqual(-1e-10)
    }
    const legacyWindow = { ...radar, spinStart: undefined, spinSweep: undefined }
    expect(spinAngles(legacyWindow)).toHaveLength(360)
    expect([...cumulativeRays(legacyWindow)].some(ray => ray.direction.z > 0.5)).toBe(true)
  })
  it('参考落地投影受三维有效距离、地面和圆场共同限制', () => {
    const radar = createRadar(1, 30, 0)
    const points = floorReachPoints(radar)
    expect(points.length).toBeGreaterThan(0)
    for (const point of points) {
      expect(point.z).toBe(0)
      expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(60 + 1e-6)
      expect(Math.hypot(point.x - radar.x!, point.y - radar.y!, radar.height!)).toBeLessThanOrEqual(58 + 1e-6)
    }
    expect(floorReachPoints({ ...radar, maxRange: 40 })).toEqual([])
    const close = floorReachPoints({ ...radar, maxRange: 50 })
    expect(close.length).toBeGreaterThan(0)
    expect(close.every(point => Math.hypot(point.x - radar.x!, point.y - radar.y!, radar.height!) <= 50 + 1e-6)).toBe(true)
  })
  it('移动和数值编辑重新朝向场心，云台自动对称，场心朝向稳定', () => {
    const radar = createRadar(1, 30, 0)
    radar.x = 0; radar.y = 30; radar.gimbalSweep = 120
    alignStation(radar)
    expect(radar.initialYaw).toBeCloseTo(270)
    expect(radar.gimbalStart).toBe(-60)
    radar.x = 0; radar.y = 0
    alignStation(radar)
    expect(radar.initialYaw).toBe(0)
    expect(createRadar(2, 0, 0).initialYaw).toBe(0)
  })
  it('墙顶保留实体高度，新增和复制站位独立并保留已应用扫描参数', () => {
    const wall = createRadar(7, 60, 0, 'wall')
    expect(wall.height).toBe(15)
    expect(wall.maxRange).toBe(58)
    expect(wall.spinSweep).toBe(360)
    const source = { ...createRadar(1, 30, 0), height: 52, maxRange: 72, beamCount: 64, beamMin: -20, beamMax: 10, gimbalSweep: 240, gimbalStart: -120, spinStart: 270, spinSweep: 90 }
    const before = { ...source }
    const copy = copyRadarAt(source, 2, 0, 25)
    expect(copy).toMatchObject({ id: 2, x: 0, y: 25, height: 52, placement: 'roof', maxRange: 72, beamCount: 64, beamMin: -20, beamMax: 10, gimbalSweep: 240, gimbalStart: -120, spinStart: 270, spinSweep: 90 })
    expect(copy.initialYaw).toBeCloseTo(270)
    expect(copy.color).not.toBe(source.color)
    expect(source).toEqual(before)
    copy.maxRange = 50
    expect(source.maxRange).toBe(72)
    const wallCopy = copyRadarAt(wall, 8, 0, 60)
    expect(wallCopy.placement).toBe('wall')
    expect(wallCopy.height).toBe(15)
    expect(wallCopy.initialYaw).toBeCloseTo(270)
    expect(copyRadarAt(source, 3, 0, 0).initialYaw).toBe(0)
    expect(() => copyRadarAt(source, 1, 0, 20)).toThrow('独立编号')
  })

})
