import { describe, expect, it } from 'vitest'
import { parsePly } from './PlyImporter'
import { appendPointsToSourcePly } from './PointCloudExporter'
import type { RadarPoint } from '../types'

const generatedPoint: RadarPoint = {
  x: 3, y: 5, z: 7, range: 9, azimuth: 11, elevation: 13, intensity: 197,
}

describe('PLY importer', () => {
  it('preserves a custom intensity property in ASCII PLY', () => {
    const source = [
      'ply', 'format ascii 1.0', 'element vertex 2',
      'property float x', 'property float y', 'property float z',
      'property float intensity', 'end_header',
      '10 20 30 7', '12 24 36 19', '',
    ].join('\n')
    const bytes = new TextEncoder().encode(source)
    const data = parsePly(bytes.buffer, 'sample.ply')
    expect(data.pointCount).toBe(2)
    expect([...data.positions]).toEqual([0, 0, 0, 2, 4, 6])
    expect([...(data.intensities ?? [])]).toEqual([7, 19])
  })

  it('appends points using the original ASCII schema and source coordinates', async () => {
    const source = [
      'ply', 'format ascii 1.0', 'comment keep this comment', 'element vertex 2',
      'property float x', 'property float y', 'property float z',
      'property ushort intensity', 'end_header',
      '10 20 30 7', '12 24 36 19', '',
    ].join('\n')
    const bytes = new TextEncoder().encode(source)
    const imported = parsePly(bytes.buffer, 'sample.ply')
    const mergedBuffer = await appendPointsToSourcePly(imported, [generatedPoint]).arrayBuffer()
    const mergedText = new TextDecoder().decode(mergedBuffer)
    expect(mergedText).toContain('comment keep this comment')
    expect(mergedText).toContain('element vertex 3')
    expect(mergedText).toContain('property ushort intensity')
    expect(mergedText).toContain('13.000000 25.000000 37.000000 16')
    const reimported = parsePly(mergedBuffer, 'merged.ply')
    expect(reimported.pointCount).toBe(3)
    expect(reimported.intensities?.[2]).toBe(16)
  })

  it('preserves a custom intensity property in little-endian binary PLY', () => {
    const header = [
      'ply', 'format binary_little_endian 1.0', 'element vertex 1',
      'property float x', 'property float y', 'property float z',
      'property ushort intensity', 'end_header', '',
    ].join('\n')
    const headerBytes = new TextEncoder().encode(header)
    const buffer = new ArrayBuffer(headerBytes.length + 14)
    new Uint8Array(buffer).set(headerBytes)
    const view = new DataView(buffer, headerBytes.length)
    view.setFloat32(0, 1, true)
    view.setFloat32(4, 2, true)
    view.setFloat32(8, 3, true)
    view.setUint16(12, 513, true)
    const data = parsePly(buffer, 'binary.ply')
    expect(data.intensities?.[0]).toBe(513)
  })

  it('appends points while preserving binary encoding and scalar types', async () => {
    const header = [
      'ply', 'format binary_little_endian 1.0', 'element vertex 1',
      'property double x', 'property double y', 'property double z',
      'property uchar red', 'property uchar green', 'property uchar blue',
      'end_header', '',
    ].join('\n')
    const headerBytes = new TextEncoder().encode(header)
    const buffer = new ArrayBuffer(headerBytes.length + 27)
    new Uint8Array(buffer).set(headerBytes)
    const view = new DataView(buffer, headerBytes.length)
    view.setFloat64(0, 100, true)
    view.setFloat64(8, 200, true)
    view.setFloat64(16, 300, true)
    view.setUint8(24, 1)
    view.setUint8(25, 2)
    view.setUint8(26, 3)
    const imported = parsePly(buffer, 'binary.ply')
    const merged = await appendPointsToSourcePly(imported, [generatedPoint]).arrayBuffer()
    const mergedText = new TextDecoder('ascii').decode(merged.slice(0, headerBytes.length + 32))
    expect(mergedText).toContain('format binary_little_endian 1.0')
    expect(mergedText).toContain('element vertex 2')
    const reimported = parsePly(merged, 'merged-binary.ply')
    expect(reimported.pointCount).toBe(2)
    expect([...reimported.positions.slice(3, 6)]).toEqual([3, 5, 7])
  })
})
