import { describe, expect, it } from 'vitest'
import { parsePly } from './PlyImporter'

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
})
