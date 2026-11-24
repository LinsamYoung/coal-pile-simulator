import { HeightField } from './HeightField'

export const YARD_RADIUS = 60
export const CLEARANCE_RADIUS = 7
export const WALL_HEIGHT = 15
export const CELL_SIZE = 0.5

export function isYardWorkArea(x: number, y: number): boolean {
  const distanceSquared = x * x + y * y
  return distanceSquared >= CLEARANCE_RADIUS ** 2 && distanceSquared <= YARD_RADIUS ** 2
}

export function createCircularYard(): HeightField {
  const size = Math.round(2 * YARD_RADIUS / CELL_SIZE) + 1
  const enabled = new Uint8Array(size * size)
  const field = new HeightField({
    rows: size, cols: size, cellSize: CELL_SIZE, originX: -YARD_RADIUS, originY: -YARD_RADIUS, enabled,
  })
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (isYardWorkArea(field.xAt(col), field.yAt(row))) enabled[field.index(row, col)] = 1
    }
  }
  return field
}

