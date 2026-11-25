import * as THREE from 'three'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import type { PointCloudData } from '../types'

const loader = new PLYLoader()

export function parsePly(buffer: ArrayBuffer, sourceName: string): PointCloudData {
  const geometry = loader.parse(buffer)
  const sourcePosition = geometry.getAttribute('position')
  if (!sourcePosition || sourcePosition.count === 0) {
    geometry.dispose()
    throw new Error('PLY 文件中没有顶点坐标。')
  }

  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) throw new Error('无法计算点云边界。')
  const sourceMin: [number, number, number] = [box.min.x, box.min.y, box.min.z]
  const sourceMax: [number, number, number] = [box.max.x, box.max.y, box.max.z]
  const positions = new Float32Array(sourcePosition.count * 3)
  for (let i = 0; i < sourcePosition.count; i += 1) {
    positions[i * 3] = sourcePosition.getX(i) - box.min.x
    positions[i * 3 + 1] = sourcePosition.getY(i) - box.min.y
    positions[i * 3 + 2] = sourcePosition.getZ(i) - box.min.z
  }

  // Three.js intentionally imports only standard PLY attributes. Read custom
  // scalar intensity ourselves so it survives both ASCII and binary imports.
  const intensities = extractVertexScalarProperty(buffer, 'intensity')
  geometry.dispose()
  return {
    positions,
    intensities,
    sourceBuffer: buffer,
    pointCount: sourcePosition.count,
    sourceName,
    sourceMin,
    sourceMax,
  }
}

type PlyProperty =
  | { kind: 'scalar'; type: string; name: string }
  | { kind: 'list'; countType: string; itemType: string; name: string }

function extractVertexScalarProperty(buffer: ArrayBuffer, requestedName: string): Float32Array | undefined {
  const bytes = new Uint8Array(buffer)
  const headerPreview = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)))
  const headerEndMatch = /end_header\r?\n/.exec(headerPreview)
  if (!headerEndMatch) return undefined
  const dataOffset = headerEndMatch.index + headerEndMatch[0].length
  const header = headerPreview.slice(0, headerEndMatch.index)
  const lines = header.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const format = lines.find((line) => line.startsWith('format '))?.split(/\s+/)[1]
  let vertexCount = 0
  let readingVertices = false
  const properties: PlyProperty[] = []

  for (const line of lines) {
    const parts = line.split(/\s+/)
    if (parts[0] === 'element') {
      readingVertices = parts[1] === 'vertex'
      if (readingVertices) vertexCount = Number(parts[2])
    } else if (readingVertices && parts[0] === 'property') {
      if (parts[1] === 'list') properties.push({ kind: 'list', countType: parts[2], itemType: parts[3], name: parts[4] })
      else properties.push({ kind: 'scalar', type: parts[1], name: parts[2] })
    }
  }
  if (!vertexCount || !properties.some((property) => property.kind === 'scalar' && property.name === requestedName)) {
    return undefined
  }

  const result = new Float32Array(vertexCount)
  if (format === 'ascii') {
    const body = new TextDecoder('ascii').decode(bytes.subarray(dataOffset))
    const tokens = body.trim().split(/\s+/)
    let cursor = 0
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      for (const property of properties) {
        if (property.kind === 'list') {
          const count = Number(tokens[cursor++])
          cursor += count
        } else {
          const value = Number(tokens[cursor++])
          if (property.name === requestedName) result[vertex] = value
        }
      }
    }
    return result
  }

  if (format !== 'binary_little_endian' && format !== 'binary_big_endian') return undefined
  const view = new DataView(buffer)
  const littleEndian = format === 'binary_little_endian'
  let cursor = dataOffset
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (const property of properties) {
      if (property.kind === 'scalar') {
        const [value, next] = readBinaryScalar(view, cursor, property.type, littleEndian)
        cursor = next
        if (property.name === requestedName) result[vertex] = value
      } else {
        const [count, afterCount] = readBinaryScalar(view, cursor, property.countType, littleEndian)
        cursor = afterCount + count * scalarByteSize(property.itemType)
      }
    }
  }
  return result
}

function readBinaryScalar(view: DataView, offset: number, type: string, littleEndian: boolean): [number, number] {
  switch (type) {
    case 'char': case 'int8': return [view.getInt8(offset), offset + 1]
    case 'uchar': case 'uint8': return [view.getUint8(offset), offset + 1]
    case 'short': case 'int16': return [view.getInt16(offset, littleEndian), offset + 2]
    case 'ushort': case 'uint16': return [view.getUint16(offset, littleEndian), offset + 2]
    case 'int': case 'int32': return [view.getInt32(offset, littleEndian), offset + 4]
    case 'uint': case 'uint32': return [view.getUint32(offset, littleEndian), offset + 4]
    case 'float': case 'float32': return [view.getFloat32(offset, littleEndian), offset + 4]
    case 'double': case 'float64': return [view.getFloat64(offset, littleEndian), offset + 8]
    default: throw new Error(`不支持的 PLY 标量类型：${type}`)
  }
}

function scalarByteSize(type: string): number {
  if (['char', 'uchar', 'int8', 'uint8'].includes(type)) return 1
  if (['short', 'ushort', 'int16', 'uint16'].includes(type)) return 2
  if (['int', 'uint', 'float', 'int32', 'uint32', 'float32'].includes(type)) return 4
  if (['double', 'float64'].includes(type)) return 8
  throw new Error(`不支持的 PLY 标量类型：${type}`)
}

export function createPointCloudGeometry(data: PointCloudData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3))
  const colors = new Float32Array(data.pointCount * 3)
  let minIntensity = Infinity
  let maxIntensity = -Infinity
  if (data.intensities) {
    for (const value of data.intensities) {
      minIntensity = Math.min(minIntensity, value)
      maxIntensity = Math.max(maxIntensity, value)
    }
  }
  const color = new THREE.Color()
  for (let i = 0; i < data.pointCount; i += 1) {
    const z = data.positions[i * 3 + 2]
    const normalizedIntensity = data.intensities
      ? (data.intensities[i] - minIntensity) / Math.max(1e-6, maxIntensity - minIntensity)
      : Math.min(1, z / 12)
    color.setHSL(0.31 - normalizedIntensity * 0.14, 0.18 + normalizedIntensity * 0.18, 0.37 + normalizedIntensity * 0.28)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.computeBoundingSphere()
  return geometry
}
