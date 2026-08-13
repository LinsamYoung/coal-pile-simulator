import type { BrushSettings } from '../types'
import { HeightField } from './HeightField'

export interface BrushPoint {
  x: number
  y: number
}

interface Overflow {
  index: number
  amount: number
}

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
]

/**
 * Adds/removes material along a pointer stroke. Deposited material is then
 * redistributed until its local slopes approach the configured repose angle.
 */
export function applyBrushStroke(
  field: HeightField,
  from: BrushPoint,
  to: BrushPoint,
  deltaSeconds: number,
  settings: BrushSettings,
): number[] {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const spacing = Math.max(field.cellSize * 0.5, settings.radius * 0.22)
  const sampleCount = Math.max(1, Math.ceil(distance / spacing))
  const changed = new Set<number>()
  const overflows: Overflow[] = []
  const deltaPerSample = Math.min(0.1, Math.max(0.001, deltaSeconds)) / sampleCount

  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const ratio = sample / sampleCount
    applyDab(
      field,
      from.x + (to.x - from.x) * ratio,
      from.y + (to.y - from.y) * ratio,
      deltaPerSample,
      settings,
      changed,
      overflows,
    )
  }

  // A height cap is a storage constraint rather than a sink: material that no
  // longer fits under it is passed to nearby cells before slope relaxation.
  for (const overflow of overflows) distributeOverflow(field, overflow, settings.maxHeight, changed)
  if (settings.relaxation > 0 && changed.size > 0) relaxCoal(field, changed, settings)
  return [...changed]
}

function applyDab(
  field: HeightField,
  centerX: number,
  centerY: number,
  deltaSeconds: number,
  settings: BrushSettings,
  changed: Set<number>,
  overflows: Overflow[],
): void {
  const minCol = Math.max(0, Math.floor((centerX - settings.radius - field.originX) / field.cellSize))
  const maxCol = Math.min(field.cols - 1, Math.ceil((centerX + settings.radius - field.originX) / field.cellSize))
  const minRow = Math.max(0, Math.floor((centerY - settings.radius - field.originY) / field.cellSize))
  const maxRow = Math.min(field.rows - 1, Math.ceil((centerY + settings.radius - field.originY) / field.cellSize))
  const exponent = 0.55 + settings.falloff * 2.8

  for (let row = minRow; row <= maxRow; row += 1) {
    for (let col = minCol; col <= maxCol; col += 1) {
      const distance = Math.hypot(field.xAt(col) - centerX, field.yAt(row) - centerY)
      if (distance > settings.radius) continue
      const index = field.index(row, col)
      if (!field.enabled[index]) continue
      const t = Math.max(0, 1 - distance / settings.radius)
      const amount = settings.strength * Math.pow(t * t * (3 - 2 * t), exponent) * deltaSeconds
      const previous = field.coal[index]
      if (settings.mode === 'excavate') {
        field.coal[index] = Math.max(0, previous - amount)
      } else {
        const next = previous + amount
        field.coal[index] = Math.min(settings.maxHeight, next)
        if (next > settings.maxHeight) overflows.push({ index, amount: next - settings.maxHeight })
      }
      if (field.coal[index] !== previous) changed.add(index)
    }
  }
}

function distributeOverflow(field: HeightField, overflow: Overflow, maxHeight: number, changed: Set<number>): void {
  let remaining = overflow.amount
  const queue = [overflow.index]
  const visited = new Uint8Array(field.size)
  visited[overflow.index] = 1
  let cursor = 0
  while (remaining > 1e-7 && cursor < queue.length && cursor < 2_048) {
    const index = queue[cursor++]
    const row = Math.floor(index / field.cols)
    const col = index % field.cols
    const candidates = neighbours(field, row, col).filter(({ index: next }) => field.enabled[next] && field.coal[next] < maxHeight)
    if (candidates.length > 0) {
      const share = remaining / candidates.length
      for (const { index: next } of candidates) {
        const accepted = Math.min(share, maxHeight - field.coal[next])
        if (accepted <= 0) continue
        field.coal[next] += accepted
        remaining -= accepted
        changed.add(next)
      }
    }
    for (const { index: next } of neighbours(field, row, col)) {
      if (!visited[next]) {
        visited[next] = 1
        queue.push(next)
      }
    }
  }
}

function relaxCoal(field: HeightField, changed: Set<number>, settings: BrushSettings): void {
  const tangent = Math.tan(Math.max(1, Math.min(89, settings.reposeAngleDeg)) * Math.PI / 180)
  const iterations = Math.round(8 + settings.relaxation * 56)
  const movement = 0.45 + settings.relaxation * 0.55
  let frontier = new Set(changed)

  for (let iteration = 0; iteration < iterations && frontier.size > 0; iteration += 1) {
    const nextFrontier = new Set<number>()
    for (const index of frontier) {
      if (field.coal[index] <= 0) continue
      const row = Math.floor(index / field.cols)
      const col = index % field.cols
      const unstable = neighbours(field, row, col).filter(({ index: neighbour, distance }) => {
        return field.enabled[neighbour]
          && field.surfaceAt(index) - field.surfaceAt(neighbour) > distance * tangent + 1e-5
      })
      if (unstable.length === 0) continue

      let totalExcess = 0
      for (const { index: neighbour, distance } of unstable) {
        totalExcess += Math.max(0, field.surfaceAt(index) - field.surfaceAt(neighbour) - distance * tangent)
      }
      // Moving half a height difference makes a pair stable. The factor keeps
      // the interaction smooth while the queue converges across several cells.
      let available = Math.min(field.coal[index], totalExcess * 0.5 * movement)
      for (const { index: neighbour, distance } of unstable) {
        if (available <= 1e-7) break
        const excess = Math.max(0, field.surfaceAt(index) - field.surfaceAt(neighbour) - distance * tangent)
        const transfer = Math.min(available, available * (excess / totalExcess))
        if (transfer <= 1e-7) continue
        field.coal[index] -= transfer
        field.coal[neighbour] += transfer
        available -= transfer
        changed.add(index)
        changed.add(neighbour)
        nextFrontier.add(index)
        nextFrontier.add(neighbour)
        for (const adjacent of neighbours(field, Math.floor(neighbour / field.cols), neighbour % field.cols)) nextFrontier.add(adjacent.index)
      }
    }
    frontier = nextFrontier
  }
}

function neighbours(field: HeightField, row: number, col: number): Array<{ index: number, distance: number }> {
  const result: Array<{ index: number, distance: number }> = []
  for (const [dx, dy] of NEIGHBORS) {
    const nextCol = col + dx
    const nextRow = row + dy
    if (nextCol < 0 || nextCol >= field.cols || nextRow < 0 || nextRow >= field.rows) continue
    result.push({
      index: field.index(nextRow, nextCol),
      distance: field.cellSize * (dx === 0 || dy === 0 ? 1 : Math.SQRT2),
    })
  }
  return result
}
