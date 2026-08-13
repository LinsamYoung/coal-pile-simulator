import { describe, expect, it } from 'vitest'
import { parsePly } from './PlyImporter'
import { replaceCoveredPointsInSourcePly } from './PointCloudExporter'

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

  it('replaces an ASCII vertex in place without changing point count or XY order', async () => {
    const source = [
      'ply', 'format ascii 1.0', 'element vertex 3',
      'property float x', 'property float y', 'property float z',
      'property float intensity', 'end_header',
      '10 20 30 7', '11 20 30.1 8', '12 20 30.2 9', '',
    ].join('\n')
    const bytes = new TextEncoder().encode(source)
    const imported = parsePly(bytes.buffer, 'replace.ply')
    const output = replaceCoveredPointsInSourcePly(imported, [{ index: 1, x: 1, y: 0, z: 4, intensity: 8 }])
    const outputBuffer = await output.arrayBuffer()
    const text = new TextDecoder().decode(outputBuffer)
    expect(text).toContain('element vertex 3')
    expect(text).toContain('10 20 30 7')
    expect(text).toContain('11 20 34.000000 8')
    expect(text).toContain('12 20 30.2 9')
    const reimported = parsePly(outputBuffer, 'replaced.ply')
    expect(reimported.pointCount).toBe(3)
    expect([...reimported.positions.filter((_, index) => index % 3 !== 2)]).toEqual([0, 0, 1, 0, 2, 0])
    expect(reimported.positions[5]).toBeCloseTo(4)
  })

  it('appends an ASCII gap point by cloning source attributes', async () => {
    const source = [
      'ply', 'format ascii 1.0', 'element vertex 2',
      'property float x', 'property float y', 'property float z',
      'property ushort intensity', 'end_header',
      '10 20 30 7', '12 20 30 19', '',
    ].join('\n')
    const bytes = new TextEncoder().encode(source)
    const imported = parsePly(bytes.buffer, 'add.ply')
    const output = await replaceCoveredPointsInSourcePly(imported, [], [{
      x: 1, y: 0, z: 4, templateIndex: 1, scanLineIndex: 0, pointIndexInLine: 1,
    }]).arrayBuffer()
    const text = new TextDecoder().decode(output)
    expect(text).toContain('element vertex 3')
    expect(text).toContain('11.000000 20.000000 34.000000 19')
    const reimported = parsePly(output, 'added.ply')
    expect(reimported.pointCount).toBe(3)
    expect([...reimported.positions.slice(-3)]).toEqual([1, 0, 4])
    expect(reimported.intensities?.at(-1)).toBe(19)
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

  it('replaces binary Z while keeping record size and all other bytes', async () => {
    const header = [
      'ply', 'format binary_little_endian 1.0', 'element vertex 1',
      'property float x', 'property float y', 'property float z',
      'property ushort intensity', 'end_header', '',
    ].join('\n')
    const headerBytes = new TextEncoder().encode(header)
    const buffer = new ArrayBuffer(headerBytes.length + 14)
    new Uint8Array(buffer).set(headerBytes)
    const view = new DataView(buffer, headerBytes.length)
    view.setFloat32(0, 10, true)
    view.setFloat32(4, 20, true)
    view.setFloat32(8, 30, true)
    view.setUint16(12, 513, true)
    const imported = parsePly(buffer, 'replace-binary.ply')
    const output = await replaceCoveredPointsInSourcePly(imported, [
      { index: 0, x: 0, y: 0, z: 6, intensity: 513 },
    ]).arrayBuffer()
    expect(output.byteLength).toBe(buffer.byteLength)
    const outputView = new DataView(output, headerBytes.length)
    expect(outputView.getFloat32(0, true)).toBe(10)
    expect(outputView.getFloat32(4, true)).toBe(20)
    expect(outputView.getFloat32(8, true)).toBe(36)
    expect(outputView.getUint16(12, true)).toBe(513)
  })

  it('appends a binary gap point and preserves the template intensity', async () => {
    const header = [
      'ply', 'format binary_little_endian 1.0', 'element vertex 1',
      'property float x', 'property float y', 'property float z',
      'property ushort intensity', 'end_header', '',
    ].join('\n')
    const headerBytes = new TextEncoder().encode(header)
    const buffer = new ArrayBuffer(headerBytes.length + 14)
    new Uint8Array(buffer).set(headerBytes)
    const view = new DataView(buffer, headerBytes.length)
    view.setFloat32(0, 10, true); view.setFloat32(4, 20, true); view.setFloat32(8, 30, true); view.setUint16(12, 513, true)
    const imported = parsePly(buffer, 'add-binary.ply')
    const output = await replaceCoveredPointsInSourcePly(imported, [], [{
      x: 2, y: 3, z: 4, templateIndex: 0, scanLineIndex: 0, pointIndexInLine: 0,
    }]).arrayBuffer()
    const reimported = parsePly(output, 'added-binary.ply')
    expect(reimported.pointCount).toBe(2)
    expect([...reimported.positions.slice(-3)]).toEqual([2, 3, 4])
    expect(reimported.intensities?.at(-1)).toBe(513)
  })
})
