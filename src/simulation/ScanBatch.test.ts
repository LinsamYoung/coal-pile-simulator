import { describe, expect, it } from 'vitest'
import { runScanBatch } from './ScanBatch'
import { createRadar } from './RadarSimulation'
import { createCircularYard } from './CircularYard'
import { scanResultFiles, pointsToPly } from '../io/RadarExporter'

const recipe = () => ({ ...createRadar(1, 20, 0), initialYaw: 0, spinStart: 0, spinSweep: 360, beamMin: 0, beamMax: 0, beamCount: 2, spinStep: 90, gimbalStart: 0, gimbalSweep: 0 })
function fieldWithCoal() {
  const field = createCircularYard()
  for (let row = 118; row <= 122; row++) for (let col = 158; col <= 162; col++) field.coal[field.index(row, col)] = 8
  return field
}

describe('可取消的冻结扫描批次', () => {
  it('冻结煤堆和配置，进度按真实射线计数，两组文件复用同批点', async () => {
    const field = fieldWithCoal(), radar = recipe()
    const progress: number[] = []
    const pending = runScanBatch(field, [radar], 0, { sliceMs: 0, progress: value => progress.push(value.completed) })
    field.clearCoal()
    radar.height = 100
    radar.initialYaw = 70
    const batch = await pending
    expect(batch.field.coal.some(value => value === 8)).toBe(true)
    expect(batch.results[0].radar.height).toBe(45)
    expect(batch.results[0].radar.initialYaw).toBe(0)
    expect(batch.results[0].candidates).toBe(8)
    expect(batch.results[0].points).toHaveLength(2)
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(8)
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true)
    expect(Object.isFrozen(batch.results[0].radar)).toBe(true)
    expect(Object.isFrozen(batch.results[0].points)).toBe(true)
    const files = scanResultFiles(batch)
    expect(files.map(file => file.name)).toEqual(['yard_coordinates/radar_001.ply', 'radar_local/radar_001.ply'])
    for (const file of files) {
      const text = new TextDecoder().decode(file.data)
      expect(text).toContain(`comment snapshot_id ${batch.id}\n`)
      expect(text).toContain('comment radar_id 1; yard_origin 20.000000 0.000000 45.000000\n')
      expect(text).toContain('comment initial_yaw_degrees 0; basis_x 1 0 0; basis_y 0 1 0; basis_z 0 0 1\n')
    }
    expect(files[0].data).toEqual(pointsToPly(batch.results[0].points, undefined, batch.id, batch.results[0].radar))
    expect(files[1].data).toEqual(pointsToPly(batch.results[0].points, batch.results[0].radar, batch.id))
  })
  it('统一去重容差默认保留重复，正容差确定性保留首个采样', async () => {
    const field = fieldWithCoal()
    const original = await runScanBatch(field, [recipe()], 0)
    const dedup = await runScanBatch(field, [recipe()], 0.1)
    expect(original.results[0].rawHits).toBe(2)
    expect(dedup.results[0].points).toHaveLength(1)
    expect(dedup.results[0].points[0]).toEqual(original.results[0].points[0])
  })
  it('分批让出后可以取消，不返回不完整批次', async () => {
    const controller = new AbortController()
    const pending = runScanBatch(fieldWithCoal(), [recipe()], 0, { sliceMs: 0, signal: controller.signal, progress: value => { if (value.completed > 0) controller.abort() } })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
