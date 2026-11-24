import { describe, expect, it, vi } from 'vitest'
import * as radarSimulation from '../simulation/RadarSimulation'
import { crc32, createStoredZip, pointsToPly, radarBatchFiles } from './RadarExporter'
import { createCircularYard } from '../simulation/CircularYard'
import { radarPosition, scanRadar, type RadarConfig } from '../simulation/RadarSimulation'

describe('雷达 PLY 与 ZIP', () => {
  it('完整保留场心坐标与空点文件头', () => {
    const empty = new TextDecoder().decode(pointsToPly([]))
    expect(empty).toContain('element vertex 0\n')
    expect(empty).toContain('comment yard-centered Z-up coordinates in meters\n')
    expect(new TextDecoder().decode(pointsToPly([{ x: -2, y: 3, z: 4 }]))).toContain('-2.000000 3.000000 4.000000')
  })
  it('不同雷达均以自身为原点，向心为 X、朝左为 Y，向上为 Z', () => {
    for (const wallAngle of [0, Math.PI / 2, 0.73]) {
      const radar: RadarConfig = { id: 2, wallAngle, startAngle: 45, endAngle: 135, lineSpacing: 1, color: '#fff' }
      const origin = radarPosition(radar)
      const cosine = Math.cos(wallAngle), sine = Math.sin(wallAngle)
      const points = [
        { x: origin.x, y: origin.y, z: origin.z },
        { x: origin.x - 3 * cosine, y: origin.y - 3 * sine, z: origin.z },
        { x: origin.x + 4 * sine, y: origin.y - 4 * cosine, z: origin.z },
        { x: origin.x, y: origin.y, z: origin.z + 5 },
        { x: origin.x - 3 * cosine + 4 * sine, y: origin.y - 3 * sine - 4 * cosine, z: origin.z - 7 },
      ]
      const before = points.map(point => ({ ...point }))
      const ply = new TextDecoder().decode(pointsToPly(points, radar))
      expect(ply).toContain('comment radar-local right-handed coordinates in meters; origin=radar; +X=yard-center +Y=left +Z=up\n')
      expect(ply).toContain('comment radar_id 2; yard_origin ')
      const coordinates = ply.split('end_header\n')[1].trim().split('\n').map(line => line.split(' ').map(Number))
      const expected = [[0, 0, 0], [3, 0, 0], [0, 4, 0], [0, 0, 5], [3, 4, -7]]
      for (let i = 0; i < expected.length; i++) for (let axis = 0; axis < 3; axis++) expect(coordinates[i][axis]).toBeCloseTo(expected[i][axis], 6)
      expect(points).toEqual(before)
    }
  })
  it('每台雷达仅扫描一次，同批命中点分别写出场地坐标和雷达局部坐标', () => {
    const field = createCircularYard()
    for (let row = 116; row <= 124; row++) for (let col = 156; col <= 164; col++) field.coal[field.index(row, col)] = 8
    const radars: RadarConfig[] = [0, Math.PI / 2].map((wallAngle, index) => ({ id: index + 1, wallAngle, startAngle: 0, endAngle: 180, lineSpacing: 5, color: '#fff' }))
    const worldPoints = radars.map(radar => scanRadar(field, radar))
    const scan = vi.spyOn(radarSimulation, 'scanRadar')
    try {
      const files = radarBatchFiles(field, radars)
      expect(scan).toHaveBeenCalledTimes(radars.length)
      expect(files).toHaveLength(radars.length * 2)
      for (let i = 0; i < radars.length; i++) {
        expect(worldPoints[i].length).toBeGreaterThan(0)
        expect(scan).toHaveBeenNthCalledWith(i + 1, field, radars[i])
        expect(files[i * 2].name).toBe(`yard_coordinates/radar_00${i + 1}.ply`)
        expect(files[i * 2 + 1].name).toBe(`radar_local/radar_00${i + 1}.ply`)
        expect(files[i * 2].data).toEqual(pointsToPly(worldPoints[i], undefined, undefined, radars[i]))
        expect(files[i * 2 + 1].data).toEqual(pointsToPly(worldPoints[i], radars[i]))
        expect(worldPoints[i].some(point => point.z >= 0 && point.z <= 8)).toBe(true)
      }
    } finally {
      scan.mockRestore()
    }
  })
  it('ZIP 包含两组成对空 PLY，路径唯一且没有目录记录或其他文件', async () => {
    const files = radarBatchFiles(createCircularYard(), [1, 3].map(id => ({ id, wallAngle: 0, startAngle: 45, endAngle: 135, lineSpacing: 1, color: '#fff' })))
    expect(files.map(file => file.name)).toEqual(['yard_coordinates/radar_001.ply', 'radar_local/radar_001.ply', 'yard_coordinates/radar_003.ply', 'radar_local/radar_003.ply'])
    const bytes = new Uint8Array(await createStoredZip(files).arrayBuffer())
    const view = new DataView(bytes.buffer)
    let offset = 0
    for (const file of files) {
      expect(view.getUint32(offset, true)).toBe(0x04034b50)
      const size = view.getUint32(offset + 18, true)
      const nameLength = view.getUint16(offset + 26, true)
      expect(new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength))).toBe(file.name)
      const data = bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + size)
      expect(crc32(data)).toBe(view.getUint32(offset + 14, true))
      const ply = new TextDecoder().decode(data)
      expect(ply).toContain('element vertex 0\n')
      expect(ply).toContain(file.name.startsWith('yard_coordinates/')
        ? 'comment yard-centered Z-up coordinates in meters\n'
        : 'comment radar-local right-handed coordinates in meters; origin=radar; +X=yard-center +Y=left +Z=up\n')
      offset += 30 + nameLength + size
    }
    expect(view.getUint32(offset, true)).toBe(0x02014b50)
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50)
    expect(view.getUint16(bytes.length - 14, true)).toBe(4)
  })
  it('使用标准 CRC32 校验多项式', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})
