import { HeightField } from './HeightField'

export interface GroundGridBuildResult {
  field: HeightField
  requestedCellSize: number
  effectiveCellSize: number
  occupiedCells: number
}

export function buildGroundGrid(
  positions: Float32Array,
  requestedCellSize = 0.5,
  maxCells = 180_000,
): GroundGridBuildResult {
  if (positions.length < 3 || positions.length % 3 !== 0) {
    throw new Error('点云坐标为空或格式不正确。')
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i])
    minY = Math.min(minY, positions[i + 1])
    maxX = Math.max(maxX, positions[i])
    maxY = Math.max(maxY, positions[i + 1])
  }

  const width = Math.max(maxX - minX, requestedCellSize)
  const height = Math.max(maxY - minY, requestedCellSize)
  let cellSize = requestedCellSize
  const estimatedCells = (Math.ceil(width / cellSize) + 1) * (Math.ceil(height / cellSize) + 1)
  if (estimatedCells > maxCells) {
    cellSize = Math.sqrt((width * height) / (maxCells * 0.92))
  }

  const cols = Math.max(2, Math.ceil(width / cellSize) + 1)
  const rows = Math.max(2, Math.ceil(height / cellSize) + 1)
  const ground = new Float32Array(rows * cols)
  ground.fill(Infinity)
  const occupied = new Uint8Array(rows * cols)
  let occupiedCells = 0

  for (let i = 0; i < positions.length; i += 3) {
    const col = Math.min(cols - 1, Math.max(0, Math.round((positions[i] - minX) / cellSize)))
    const row = Math.min(rows - 1, Math.max(0, Math.round((positions[i + 1] - minY) / cellSize)))
    const index = row * cols + col
    if (!occupied[index]) {
      occupied[index] = 1
      occupiedCells += 1
    }
    ground[index] = Math.min(ground[index], positions[i + 2])
  }

  fillEmptyCellsByNearest(ground, occupied, rows, cols)
  smoothSparseArtifacts(ground, rows, cols)

  return {
    field: new HeightField({ rows, cols, cellSize, originX: minX, originY: minY, ground }),
    requestedCellSize,
    effectiveCellSize: cellSize,
    occupiedCells,
  }
}

function fillEmptyCellsByNearest(
  values: Float32Array,
  occupied: Uint8Array,
  rows: number,
  cols: number,
): void {
  const size = rows * cols
  const queue = new Int32Array(size)
  const source = new Int32Array(size)
  source.fill(-1)
  let head = 0
  let tail = 0
  for (let i = 0; i < size; i += 1) {
    if (occupied[i]) {
      queue[tail++] = i
      source[i] = i
    }
  }
  if (tail === 0) throw new Error('点云中没有可用于构建地面的有效点。')

  const offsets = [-1, 1, -cols, cols]
  while (head < tail) {
    const current = queue[head++]
    const row = Math.floor(current / cols)
    const col = current % cols
    for (const offset of offsets) {
      const next = current + offset
      if (next < 0 || next >= size || source[next] !== -1) continue
      const nextRow = Math.floor(next / cols)
      const nextCol = next % cols
      if (Math.abs(nextRow - row) + Math.abs(nextCol - col) !== 1) continue
      source[next] = source[current]
      queue[tail++] = next
    }
  }
  for (let i = 0; i < size; i += 1) {
    if (!occupied[i]) values[i] = values[source[i]]
  }
}

function smoothSparseArtifacts(values: Float32Array, rows: number, cols: number): void {
  const copy = values.slice()
  for (let row = 1; row < rows - 1; row += 1) {
    for (let col = 1; col < cols - 1; col += 1) {
      const index = row * cols + col
      const neighbors = [copy[index], copy[index - 1], copy[index + 1], copy[index - cols], copy[index + cols]]
      neighbors.sort((a, b) => a - b)
      const median = neighbors[2]
      if (Math.abs(copy[index] - median) > 1.5) values[index] = median
    }
  }
}
