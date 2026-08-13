import type { GridPointAddition, GridPointReplacement, PointCloudData } from '../types'

type PlyProperty =
  | { kind: 'scalar'; type: string; name: string }
  | { kind: 'list'; countType: string; itemType: string; name: string }

interface PlySchema {
  format: 'ascii' | 'binary_little_endian' | 'binary_big_endian'
  vertexCount: number
  properties: PlyProperty[]
  header: string
  dataOffset: number
  eol: '\n' | '\r\n'
}

/**
 * Mode B+: replace covered ground vertices in place, then append only missing
 * scan-lattice points. Added records clone all non-position properties from a
 * nearby source vertex, keeping the source schema and encoding.
 */
export function replaceCoveredPointsInSourcePly(
  source: PointCloudData,
  replacements: readonly GridPointReplacement[],
  additions: readonly GridPointAddition[] = [],
): Blob {
  if (replacements.length === 0 && additions.length === 0) throw new Error('当前煤堆没有可生成的覆盖点。')
  const schema = parsePlySchema(source.sourceBuffer)
  if (schema.vertexCount !== source.pointCount) throw new Error('PLY 顶点数量与已导入点云不一致。')
  const replacementMap = new Map(replacements.map((point) => [point.index, point]))
  if (schema.format === 'ascii') return replaceAsciiVertices(source, schema, replacementMap, additions)
  return replaceBinaryVertices(source, schema, replacementMap, additions)
}

function replaceAsciiVertices(
  source: PointCloudData,
  schema: PlySchema,
  replacements: ReadonlyMap<number, GridPointReplacement>,
  additions: readonly GridPointAddition[],
): Blob {
  const body = new TextDecoder('ascii').decode(new Uint8Array(source.sourceBuffer, schema.dataOffset))
  const records = body.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((record) => record.length > 0) ?? []
  if (records.length < schema.vertexCount) throw new Error('PLY 顶点数量与文件内容不一致。')

  for (const [index, replacement] of replacements) {
    if (index < 0 || index >= schema.vertexCount) continue
    const record = records[index]
    const eolMatch = /(\r\n|\n|\r)$/.exec(record)
    let line = eolMatch ? record.slice(0, -eolMatch[0].length) : record
    const tokens = [...line.matchAll(/\S+/g)]
    let tokenIndex = 0
    const updates: Array<{ index: number; value: string }> = []
    for (const property of schema.properties) {
      if (property.kind === 'list') {
        const count = Number(tokens[tokenIndex]?.[0])
        tokenIndex += 1 + count
      } else {
        const name = property.name.toLowerCase()
        if (name === 'z') updates.push({
          index: tokenIndex,
          value: formatScalar(replacement.z + source.sourceMin[2], property.type),
        })
        tokenIndex += 1
      }
    }
    for (const update of updates.sort((a, b) => b.index - a.index)) {
      const token = tokens[update.index]
      if (!token || token.index === undefined) throw new Error(`PLY 第 ${index + 1} 个顶点数据不完整。`)
      line = line.slice(0, token.index) + update.value + line.slice(token.index + token[0].length)
    }
    records[index] = line + (eolMatch?.[0] ?? '')
  }
  const additionRecords = additions.map((addition) => {
    const templateIndex = clampIndex(addition.templateIndex, schema.vertexCount)
    const template = records[templateIndex]
    const templateEol = /(\r\n|\n|\r)$/.exec(template)
    let line = templateEol ? template.slice(0, -templateEol[0].length) : template
    line = updateAsciiPositionTokens(line, schema, {
      x: addition.x + source.sourceMin[0],
      y: addition.y + source.sourceMin[1],
      z: addition.z + source.sourceMin[2],
    })
    return line + schema.eol
  })
  const header = schema.header.replace(
    /(^|\r?\n)(element\s+vertex\s+)\d+(?=\r?\n)/,
    `$1$2${schema.vertexCount + additions.length}`,
  )
  return new Blob([
    new TextEncoder().encode(header).buffer as ArrayBuffer,
    records.slice(0, schema.vertexCount).join(''),
    additionRecords.join(''),
    records.slice(schema.vertexCount).join(''),
  ], { type: 'application/octet-stream' })
}

function replaceBinaryVertices(
  source: PointCloudData,
  schema: PlySchema,
  replacements: ReadonlyMap<number, GridPointReplacement>,
  additions: readonly GridPointAddition[],
): Blob {
  const output = source.sourceBuffer.slice(0)
  const sourceView = new DataView(source.sourceBuffer)
  const outputView = new DataView(output)
  const littleEndian = schema.format === 'binary_little_endian'
  let offset = schema.dataOffset
  const recordRanges: Array<{ start: number; end: number }> = []

  for (let index = 0; index < schema.vertexCount; index += 1) {
    const recordStart = offset
    const replacement = replacements.get(index)
    for (const property of schema.properties) {
      if (property.kind === 'list') {
        const count = readBinaryScalar(sourceView, offset, property.countType, littleEndian)
        offset += scalarByteSize(property.countType) + count * scalarByteSize(property.itemType)
      } else {
        const name = property.name.toLowerCase()
        if (replacement && name === 'z') {
          writeBinaryScalar(outputView, offset, property.type, replacement.z + source.sourceMin[2], littleEndian)
        }
        offset += scalarByteSize(property.type)
      }
    }
    recordRanges.push({ start: recordStart, end: offset })
  }
  const vertexEnd = offset
  const additionBuffers = additions.map((addition) => {
    const templateIndex = clampIndex(addition.templateIndex, schema.vertexCount)
    const range = recordRanges[templateIndex]
    const record = source.sourceBuffer.slice(range.start, range.end)
    const recordView = new DataView(record)
    updateBinaryPosition(recordView, schema, littleEndian, {
      x: addition.x + source.sourceMin[0],
      y: addition.y + source.sourceMin[1],
      z: addition.z + source.sourceMin[2],
    })
    return record
  })
  const header = schema.header.replace(
    /(^|\r?\n)(element\s+vertex\s+)\d+(?=\r?\n)/,
    `$1$2${schema.vertexCount + additions.length}`,
  )
  return new Blob([
    new TextEncoder().encode(header).buffer as ArrayBuffer,
    output.slice(schema.dataOffset, vertexEnd),
    ...additionBuffers,
    output.slice(vertexEnd),
  ], { type: 'application/octet-stream' })
}

function updateAsciiPositionTokens(
  line: string,
  schema: PlySchema,
  position: { x: number; y: number; z: number },
): string {
  const tokens = [...line.matchAll(/\S+/g)]
  let tokenIndex = 0
  const updates: Array<{ index: number; value: string }> = []
  for (const property of schema.properties) {
    if (property.kind === 'list') {
      const count = Number(tokens[tokenIndex]?.[0])
      tokenIndex += 1 + count
      continue
    }
    const name = property.name.toLowerCase()
    if (name === 'x' || name === 'y' || name === 'z') {
      updates.push({ index: tokenIndex, value: formatScalar(position[name], property.type) })
    }
    tokenIndex += 1
  }
  for (const update of updates.sort((a, b) => b.index - a.index)) {
    const token = tokens[update.index]
    if (!token || token.index === undefined) throw new Error('PLY 顶点模板数据不完整。')
    line = line.slice(0, token.index) + update.value + line.slice(token.index + token[0].length)
  }
  return line
}

function updateBinaryPosition(
  view: DataView,
  schema: PlySchema,
  littleEndian: boolean,
  position: { x: number; y: number; z: number },
): void {
  let offset = 0
  for (const property of schema.properties) {
    if (property.kind === 'list') {
      const count = readBinaryScalar(view, offset, property.countType, littleEndian)
      offset += scalarByteSize(property.countType) + count * scalarByteSize(property.itemType)
      continue
    }
    const name = property.name.toLowerCase()
    if (name === 'x' || name === 'y' || name === 'z') {
      writeBinaryScalar(view, offset, property.type, position[name], littleEndian)
    }
    offset += scalarByteSize(property.type)
  }
}

function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(count - 1, Math.round(index)))
}

function parsePlySchema(buffer: ArrayBuffer): PlySchema {
  const bytes = new Uint8Array(buffer)
  const preview = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)))
  const headerEnd = /end_header(\r?\n)/.exec(preview)
  if (!headerEnd) throw new Error('PLY 文件头不完整。')
  const dataOffset = headerEnd.index + headerEnd[0].length
  const header = preview.slice(0, dataOffset)
  const formatMatch = /^format\s+(ascii|binary_little_endian|binary_big_endian)\s+/m.exec(header)
  if (!formatMatch) throw new Error('PLY 编码格式不受支持。')

  let vertexCount = 0
  let readingVertex = false
  const properties: PlyProperty[] = []
  for (const rawLine of header.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/)
    if (parts[0] === 'element') {
      readingVertex = parts[1] === 'vertex'
      if (readingVertex) vertexCount = Number(parts[2])
    } else if (readingVertex && parts[0] === 'property') {
      if (parts[1] === 'list') {
        properties.push({ kind: 'list', countType: parts[2], itemType: parts[3], name: parts[4] })
      } else {
        properties.push({ kind: 'scalar', type: parts[1], name: parts[2] })
      }
    }
  }
  if (!Number.isFinite(vertexCount) || vertexCount < 0 || properties.length === 0) {
    throw new Error('PLY 顶点定义不正确。')
  }
  return {
    format: formatMatch[1] as PlySchema['format'],
    vertexCount,
    properties,
    header,
    dataOffset,
    eol: headerEnd[1] as '\n' | '\r\n',
  }
}

function formatScalar(value: number, type: string): string {
  if (isIntegerType(type)) return String(normalizeInteger(value, type))
  return Number.isFinite(value) ? value.toFixed(type === 'double' || type === 'float64' ? 9 : 6) : '0'
}

function scalarByteSize(type: string): number {
  if (['char', 'uchar', 'int8', 'uint8'].includes(type)) return 1
  if (['short', 'ushort', 'int16', 'uint16'].includes(type)) return 2
  if (['int', 'uint', 'float', 'int32', 'uint32', 'float32'].includes(type)) return 4
  if (['double', 'float64'].includes(type)) return 8
  throw new Error(`不支持的 PLY 标量类型：${type}`)
}

function isIntegerType(type: string): boolean {
  return !['float', 'float32', 'double', 'float64'].includes(type)
}

function normalizeInteger(value: number, type: string): number {
  const rounded = Math.round(Number.isFinite(value) ? value : 0)
  switch (type) {
    case 'char': case 'int8': return Math.max(-128, Math.min(127, rounded))
    case 'uchar': case 'uint8': return Math.max(0, Math.min(255, rounded))
    case 'short': case 'int16': return Math.max(-32768, Math.min(32767, rounded))
    case 'ushort': case 'uint16': return Math.max(0, Math.min(65535, rounded))
    case 'uint': case 'uint32': return Math.max(0, Math.min(4294967295, rounded))
    default: return Math.max(-2147483648, Math.min(2147483647, rounded))
  }
}

function readBinaryScalar(view: DataView, offset: number, type: string, littleEndian: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset)
    case 'uchar': case 'uint8': return view.getUint8(offset)
    case 'short': case 'int16': return view.getInt16(offset, littleEndian)
    case 'ushort': case 'uint16': return view.getUint16(offset, littleEndian)
    case 'int': case 'int32': return view.getInt32(offset, littleEndian)
    case 'uint': case 'uint32': return view.getUint32(offset, littleEndian)
    case 'float': case 'float32': return view.getFloat32(offset, littleEndian)
    case 'double': case 'float64': return view.getFloat64(offset, littleEndian)
    default: throw new Error(`不支持的 PLY 标量类型：${type}`)
  }
}

function writeBinaryScalar(
  view: DataView,
  offset: number,
  type: string,
  value: number,
  littleEndian: boolean,
): number {
  const integer = normalizeInteger(value, type)
  switch (type) {
    case 'char': case 'int8': view.setInt8(offset, integer); return offset + 1
    case 'uchar': case 'uint8': view.setUint8(offset, integer); return offset + 1
    case 'short': case 'int16': view.setInt16(offset, integer, littleEndian); return offset + 2
    case 'ushort': case 'uint16': view.setUint16(offset, integer, littleEndian); return offset + 2
    case 'int': case 'int32': view.setInt32(offset, integer, littleEndian); return offset + 4
    case 'uint': case 'uint32': view.setUint32(offset, integer, littleEndian); return offset + 4
    case 'float': case 'float32': view.setFloat32(offset, value, littleEndian); return offset + 4
    case 'double': case 'float64': view.setFloat64(offset, value, littleEndian); return offset + 8
    default: throw new Error(`不支持的 PLY 标量类型：${type}`)
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
