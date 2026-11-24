import type { ScanPoint, RadarConfig } from '../simulation/RadarSimulation'
import { radarPosition, radarYaw, scanRadar } from '../simulation/RadarSimulation'
import type { HeightField } from '../simulation/HeightField'
import type { ScanBatch } from '../simulation/ScanBatch'

export function pointsToPly(points: readonly ScanPoint[], radar?: RadarConfig, snapshotId?: string, stationMetadata?: RadarConfig): Uint8Array<ArrayBuffer> {
  const origin = radar ? radarPosition(radar) : null
  const station = radar ?? stationMetadata
  const stationOrigin = station ? radarPosition(station) : null
  const yaw = station ? (radarYaw(station) % 360) * Math.PI / 180 : 0
  const cosine = Math.cos(yaw), sine = Math.sin(yaw)
  const coordinateComment = origin && radar
    ? `radar-local right-handed coordinates in meters; origin=radar; ${radar.initialYaw === undefined ? '+X=yard-center' : '+X=initial-yaw'} +Y=left +Z=up`
    : 'yard-centered Z-up coordinates in meters'
  const stationComment = station && stationOrigin
    ? `comment radar_id ${station.id}; yard_origin ${stationOrigin.x.toFixed(6)} ${stationOrigin.y.toFixed(6)} ${stationOrigin.z.toFixed(6)}\ncomment initial_yaw_degrees ${radarYaw(station)}; basis_x ${cosine} ${sine} 0; basis_y ${-sine} ${cosine} 0; basis_z 0 0 1\ncomment recipe ${JSON.stringify(station)}\n`
    : ''
  const header = `ply\nformat ascii 1.0\ncomment ${coordinateComment}\n${stationComment}${snapshotId ? `comment snapshot_id ${snapshotId}\n` : ''}element vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`
  const body = points.map(point => {
    // 仅在雷达文件写出时平移、旋转坐标，扫描计算和完整煤面继续使用场地坐标。
    const dx = origin ? point.x - origin.x : point.x, dy = origin ? point.y - origin.y : point.y
    const local = origin ? { x: cosine * dx + sine * dy, y: -sine * dx + cosine * dy, z: point.z - origin.z } : point
    return `${local.x.toFixed(6)} ${local.y.toFixed(6)} ${local.z.toFixed(6)}\n`
  }).join('')
  return new TextEncoder().encode(header + body)
}

export function radarFilename(radar: RadarConfig): string {
  return `radar_${String(radar.id).padStart(3, '0')}.ply`
}

export function radarBatchFiles(field: HeightField, radars: readonly RadarConfig[]): { name: string; data: Uint8Array<ArrayBuffer> }[] {
  return radars.flatMap(radar => {
    // 每台雷达只扫描一次，两种坐标文件使用同一批命中点，空扫描也成对保留。
    const points = scanRadar(field, radar)
    const filename = radarFilename(radar)
    return [
      { name: `yard_coordinates/${filename}`, data: pointsToPly(points, undefined, undefined, radar) },
      { name: `radar_local/${filename}`, data: pointsToPly(points, radar) },
    ]
  })
}

export function scanResultFiles(batch: ScanBatch): { name: string; data: Uint8Array<ArrayBuffer> }[] {
  return batch.results.flatMap(({ radar, points }) => [
    { name: `yard_coordinates/${radarFilename(radar)}`, data: pointsToPly(points, undefined, batch.id, radar) },
    { name: `radar_local/${radarFilename(radar)}`, data: pointsToPly(points, radar, batch.id) },
  ])
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function createStoredZip(files: readonly { name: string; data: Uint8Array<ArrayBuffer> }[]): Blob {
  // 使用标准无压缩 ZIP：每项均带 CRC32 和中央目录，便于独立工具核验。
  if (files.length > 65535) throw new Error('ZIP 文件数量超过限制。')
  const encoder = new TextEncoder()
  const parts: ArrayBuffer[] = []
  const central: ArrayBuffer[] = []
  let offset = 0
  let centralSize = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const crc = crc32(file.data)
    const local = new Uint8Array(30 + name.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0x800, true)
    view.setUint16(12, 33, true)
    view.setUint32(14, crc, true)
    view.setUint32(18, file.data.length, true)
    view.setUint32(22, file.data.length, true)
    view.setUint16(26, name.length, true)
    local.set(name, 30)
    parts.push(local.buffer, file.data.buffer)
    const directory = new Uint8Array(46 + name.length)
    const entry = new DataView(directory.buffer)
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x800, true)
    entry.setUint16(14, 33, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, file.data.length, true)
    entry.setUint32(24, file.data.length, true)
    entry.setUint16(28, name.length, true)
    entry.setUint32(42, offset, true)
    directory.set(name, 46)
    central.push(directory.buffer)
    centralSize += directory.length
    offset += local.length + file.data.length
  }
  if (offset + centralSize > 0xffffffff) throw new Error('ZIP 大小超过限制。')
  const end = new ArrayBuffer(22)
  const view = new DataView(end)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, files.length, true)
  view.setUint16(10, files.length, true)
  view.setUint32(12, centralSize, true)
  view.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}
