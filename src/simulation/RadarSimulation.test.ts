import { describe, expect, it } from 'vitest'
import { Ray, Vector3 } from 'three'
import { createCircularYard } from './CircularYard'
import { angleInSector, completeCoalSurface, elevationBounds, firstCoalHit, radarDirection, radarPosition, scanRadar, snapshotField, type RadarConfig } from './RadarSimulation'

const radar: RadarConfig = { id: 1, wallAngle: 0, startAngle: 45, endAngle: 135, lineSpacing: 1, color: '#ff0000' }

describe('圆形料场雷达', () => {
  it('将左右方向相对于朝向场心的雷达定义，独立端点允许交叉', () => {
    expect(Math.sin(radarDirection(radar, 45))).toBeLessThan(0)
    expect(Math.sin(radarDirection(radar, 135))).toBeGreaterThan(0)
    const asymmetric = { ...radar, startAngle: 120, endAngle: 100 }
    expect(angleInSector(asymmetric, 0, 20)).toBe(true)
    expect(angleInSector(asymmetric, 0, -20)).toBe(false)
  })
  it('空场和零宽范围均可导出合法空结果', () => {
    expect(scanRadar(createCircularYard(), radar)).toEqual([])
    expect(scanRadar(createCircularYard(), { ...radar, startAngle: 90, endAngle: 90 })).toEqual([])
  })
  it('零宽离网格扇区仍包含穿过三角形的煤面', () => {
    const field = createCircularYard()
    const angle = 90.123
    for (let row = 118; row <= 122; row++) for (let col = 158; col <= 162; col++) field.coal[field.index(row, col)] = 8
    const narrow = { ...radar, startAngle: angle, endAngle: angle }
    expect(elevationBounds(field, narrow)).not.toBeNull()
    expect(scanRadar(field, narrow).length).toBeGreaterThan(0)
  })
  it('快照与原场独立且只导出启用区煤面', () => {
    const field = createCircularYard()
    const inside = field.index(120, 160)
    field.coal[inside] = 4
    field.coal[field.index(120, 120)] = 10
    const snapshot = snapshotField(field)
    field.clearCoal()
    expect(completeCoalSurface(snapshot)).toEqual([{ x: 20, y: 0, z: 4 }])
  })
  it('首个煤面命中遮住后方煤面，禁堆区不能产生煤点', () => {
    const field = createCircularYard()
    for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) {
      if (field.enabled[field.index(row, col)]) field.coal[field.index(row, col)] = field.xAt(col) > 20 && field.xAt(col) < 35 ? 12 : 4
    }
    const origin = radarPosition(radar)
    const hit = firstCoalHit(field, new Ray(origin, new Vector3(-1, 0, -0.1).normalize()))
    expect(hit).not.toBeNull()
    expect(hit!.x).toBeGreaterThan(20)
    expect(hit!.z).toBeGreaterThan(10)
    const throughCenter = new Ray(origin, new Vector3(-60, 0, -15).normalize())
    field.clearCoal()
    field.coal[field.index(120, 120)] = 30
    expect(firstCoalHit(field, throughCenter)).toBeNull()
  })
  it('地面首击不会继续穿过后方煤堆，朝外射线被完整圆墙阻挡', () => {
    const field = createCircularYard()
    for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) if (field.xAt(col) < -20) field.coal[field.index(row, col)] = 10
    expect(firstCoalHit(field, new Ray(radarPosition(radar), new Vector3(-1, 0, -1).normalize()))).toBeNull()
    expect(firstCoalHit(field, new Ray(radarPosition(radar), new Vector3(1, 0, -0.1).normalize()))).toBeNull()
  })
})
