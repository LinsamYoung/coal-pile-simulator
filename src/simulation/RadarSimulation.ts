import { Ray, Vector3 } from 'three'
import { HeightField } from './HeightField'
import { WALL_HEIGHT, YARD_RADIUS } from './CircularYard'

export interface RadarConfig {
  id: number
  wallAngle: number
  startAngle: number
  endAngle: number
  lineSpacing: number
  color: string
  placement?: 'roof' | 'wall'
  x?: number
  y?: number
  height?: number
  initialYaw?: number
  roll?: number
  beamMin?: number
  beamMax?: number
  beamCount?: number
  spinStart?: number
  spinSweep?: number
  spinStep?: number
  gimbalStart?: number
  gimbalSweep?: number
  gimbalStep?: number
  minRange?: number
  maxRange?: number
}
export interface ScanPoint { x: number; y: number; z: number }
const radians = Math.PI / 180
export const COAL_THRESHOLD = 0.002
export function radarPosition(radar: RadarConfig): Vector3 {
  return new Vector3(radar.x ?? Math.cos(radar.wallAngle) * YARD_RADIUS, radar.y ?? Math.sin(radar.wallAngle) * YARD_RADIUS, radar.height ?? WALL_HEIGHT)
}
export function radarDirection(radar: RadarConfig, angle: number): number {
  // 从雷达朝向场心观察时，零度为左侧，九十度为场心。
  return radar.wallAngle + Math.PI + (90 - angle) * radians
}
export function angleInSector(radar: RadarConfig, x: number, y: number): boolean {
  const origin = radarPosition(radar)
  const direction = Math.atan2(y - origin.y, x - origin.x)
  const offset = Math.atan2(Math.sin(direction - radar.wallAngle - Math.PI), Math.cos(direction - radar.wallAngle - Math.PI)) / radians
  const angle = 90 - offset
  return angle >= Math.min(radar.startAngle, radar.endAngle) - 1e-7 && angle <= Math.max(radar.startAngle, radar.endAngle) + 1e-7
}
export function snapshotField(field: HeightField): HeightField {
  const snapshot = new HeightField({ rows: field.rows, cols: field.cols, cellSize: field.cellSize, originX: field.originX, originY: field.originY, ground: field.ground.slice(), enabled: field.enabled.slice() })
  snapshot.coal.set(field.coal)
  return snapshot
}
export function completeCoalSurface(field: HeightField): ScanPoint[] {
  const points: ScanPoint[] = []
  for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) {
    const i = field.index(row, col)
    if (field.enabled[i] && field.coal[i] >= COAL_THRESHOLD) points.push({ x: field.xAt(col), y: field.yAt(row), z: field.surfaceAt(i) })
  }
  return points
}
export function elevationBounds(field: HeightField, radar: RadarConfig): [number, number] | null {
  const origin = radarPosition(radar)
  let low = Infinity
  let high = -Infinity
  const sectorLow = Math.min(radar.startAngle, radar.endAngle)
  const sectorHigh = Math.max(radar.startAngle, radar.endAngle)
  // 将煤三角形的邻域纳入保守包络，窄扇区和零宽扫描线也不会漏掉跨线三角形。
  for (let row = 0; row < field.rows; row++) for (let col = 0; col < field.cols; col++) {
    const index = field.index(row, col)
    if (!field.enabled[index]) continue
    let nearCoal = false
    for (let dy = -1; dy <= 1 && !nearCoal; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (row + dy < 0 || col + dx < 0 || row + dy >= field.rows || col + dx >= field.cols) continue
      const neighbor = field.index(row + dy, col + dx)
      if (field.enabled[neighbor] && field.coal[neighbor] >= COAL_THRESHOLD) { nearCoal = true; break }
    }
    if (!nearCoal) continue
    const x = field.xAt(col), y = field.yAt(row)
    const distance = Math.hypot(x - origin.x, y - origin.y)
    const padding = Math.asin(Math.min(1, field.cellSize * Math.SQRT2 / Math.max(distance, 1e-9))) / radians
    const direction = Math.atan2(y - origin.y, x - origin.x)
    const offset = Math.atan2(Math.sin(direction - radar.wallAngle - Math.PI), Math.cos(direction - radar.wallAngle - Math.PI)) / radians
    const angle = 90 - offset
    if (angle + padding < sectorLow || angle - padding > sectorHigh) continue
    const elevation = Math.atan2(field.surfaceAt(index) - origin.z, distance) / radians
    low = Math.min(low, elevation - padding)
    high = Math.max(high, elevation + padding)
  }
  return Number.isFinite(low) ? [Math.max(-89.9, low - 0.5), Math.min(89.9, high + 0.5)] : null
}
export function scanRadar(field: HeightField, radar: RadarConfig): ScanPoint[] {
  if (radar.beamMin !== undefined) {
    const points: ScanPoint[] = []
    for (const ray of cumulativeRays(radar)) {
      const point = firstCoalHit(field, ray, radar.minRange, radar.maxRange)
      if (point) points.push(point)
    }
    return points
  }
  if (!Number.isFinite(radar.lineSpacing) || radar.lineSpacing < 0.1) throw new Error('扫描线间隔至少为 0.1°。')
  const bounds = elevationBounds(field, radar)
  if (!bounds) return []
  const points: ScanPoint[] = []
  const origin = radarPosition(radar)
  const low = Math.min(radar.startAngle, radar.endAngle)
  const high = Math.max(radar.startAngle, radar.endAngle)
  const lines = Math.ceil((high - low) / radar.lineSpacing)
  const steps = Math.max(1, Math.ceil((bounds[1] - bounds[0]) / 0.5))
  for (let line = 0; line <= lines; line++) {
    const azimuth = radarDirection(radar, Math.min(high, low + line * radar.lineSpacing))
    for (let step = 0; step <= steps; step++) {
      const elevation = (bounds[0] + (bounds[1] - bounds[0]) * step / steps) * radians
      const ray = new Ray(origin, new Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation)))
      const point = firstCoalHit(field, ray)
      if (point) points.push(point)
    }
  }
  return points
}
export function firstCoalHit(field: HeightField, ray: Ray, minRange = 0, maxRange = Infinity): ScanPoint | null {
  // 外部传入的近似正交射线也采用相同清理规则，原始射线对象保持不变。
  if (['x', 'y', 'z'].some(axis => {
    const value = ray.direction[axis as 'x' | 'y' | 'z']
    return value !== 0 && Math.abs(value) < 1e-12
  })) {
    const cleaned = ray.direction.clone()
    for (const axis of ['x', 'y', 'z'] as const) if (Math.abs(cleaned[axis]) < 1e-12) cleaned[axis] = 0
    ray = new Ray(ray.origin, cleaned.normalize())
  }
  const { origin: o, direction: d } = ray
  const horizontal = d.x * d.x + d.y * d.y
  // 墙体始终完整；圆内起点取正向出圆根，竖直射线不使用圆柱除法。
  let limit = maxRange
  if (horizontal > 1e-16) {
    const projection = o.x * d.x + o.y * d.y
    const discriminant = projection * projection - horizontal * (o.x * o.x + o.y * o.y - YARD_RADIUS ** 2)
    if (discriminant < -1e-8) return null
    const exit = (-projection + Math.sqrt(Math.max(0, discriminant))) / horizontal
    if (exit <= 1e-7) return null
    // 出圆后不再可能命中场内煤面；墙高以内的出圆交点是实体遮挡。
    limit = Math.min(limit, exit)
  } else if (o.x * o.x + o.y * o.y > YARD_RADIUS ** 2 + 1e-7) return null
  if (d.z < 0) limit = Math.min(limit, -o.z / d.z)
  if (limit <= 1e-7 || !Number.isFinite(limit) && horizontal < 1e-16) return null
  if (horizontal === 0) return verticalCoalHit(field, ray, minRange, limit)
  const cellSize = field.cellSize
  const initial = ray.at(1e-6, new Vector3())
  let col = Math.floor((initial.x - field.originX) / cellSize)
  let row = Math.floor((initial.y - field.originY) / cellSize)
  const stepX = d.x >= 0 ? 1 : -1
  const stepY = d.y >= 0 ? 1 : -1
  const deltaX = Math.abs(cellSize / d.x)
  const deltaY = Math.abs(cellSize / d.y)
  let nextX = Math.abs(d.x) < 1e-12 ? Infinity : (field.xAt(col + (stepX > 0 ? 1 : 0)) - o.x) / d.x
  let nextY = Math.abs(d.y) < 1e-12 ? Infinity : (field.yAt(row + (stepY > 0 ? 1 : 0)) - o.y) / d.y
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3()
  const onXGrid = d.x === 0 && Math.abs((o.x - field.originX) / cellSize - Math.round((o.x - field.originX) / cellSize)) < 1e-10
  const onYGrid = d.y === 0 && Math.abs((o.y - field.originY) / cellSize - Math.round((o.y - field.originY) / cellSize)) < 1e-10
  let entered = 0
  while (entered <= limit && row >= 0 && col >= 0 && row < field.rows - 1 && col < field.cols - 1) {
    const cells: [number, number][] = [[row, col]]
    // 正交射线沿共享网格边前进时，合并两侧同一距离区间的三角形，再选择最近首击。
    if (onXGrid && col > 0) cells.push([row, col - 1])
    if (onYGrid && row > 0) cells.push([row - 1, col])
    const end = Math.min(nextX, nextY, limit)
    let maxHeight = -Infinity
    for (const [r, column] of cells) {
      const base = field.index(r, column)
      maxHeight = Math.max(maxHeight, field.surfaceAt(base), field.surfaceAt(base + 1), field.surfaceAt(base + field.cols), field.surfaceAt(base + field.cols + 1))
    }
    // 射线在整个格段均高于四角最高值时，不可能命中分片线性煤面。
    if (Math.min(o.z + entered * d.z, o.z + end * d.z) > maxHeight + 1e-7) {
      if (nextX < nextY) { entered = nextX; nextX += deltaX; col += stepX }
      else { entered = nextY; nextY += deltaY; row += stepY }
      continue
    }
    const triangles: number[][] = []
    for (const [r, column] of cells) {
      const base = field.index(r, column)
      if ((r + column) % 2 === 0) triangles.push([base, base + 1, base + field.cols + 1], [base, base + field.cols + 1, base + field.cols])
      else triangles.push([base, base + 1, base + field.cols], [base + 1, base + field.cols + 1, base + field.cols])
    }
    let nearest = Infinity
    let coal = 0
    let result: ScanPoint | null = null
    for (const ids of triangles) {
      if (ids.some(i => !field.enabled[i])) continue
      for (const [vertex, i] of [[a, ids[0]], [b, ids[1]], [c, ids[2]]] as const) vertex.set(field.xAt(i % field.cols), field.yAt(Math.floor(i / field.cols)), field.surfaceAt(i))
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue
      const t = (hit.x - o.x) * d.x + (hit.y - o.y) * d.y + (hit.z - o.z) * d.z
      if (t < 1e-6 || t < entered - 1e-7 || t > end + 1e-7 || t > limit + 1e-7 || t >= nearest) continue
      // 同一三角形上的煤厚采用重心插值，保持与显示网格一致。
      const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
      const u = ((b.y - c.y) * (hit.x - c.x) + (c.x - b.x) * (hit.y - c.y)) / denominator
      const v = ((c.y - a.y) * (hit.x - c.x) + (a.x - c.x) * (hit.y - c.y)) / denominator
      coal = u * field.coal[ids[0]] + v * field.coal[ids[1]] + (1 - u - v) * field.coal[ids[2]]
      nearest = t
      result = { x: hit.x, y: hit.y, z: hit.z }
    }
    if (result) return coal >= COAL_THRESHOLD && nearest >= minRange - 1e-7 ? result : null
    if (nextX < nextY) { entered = nextX; nextX += deltaX; col += stepX }
    else { entered = nextY; nextY += deltaY; row += stepY }
  }
  return null
}

export function radarYaw(radar: RadarConfig): number {
  return radar.initialYaw ?? (radar.wallAngle * 180 / Math.PI + 180)
}

export function createRadar(id: number, x: number, y: number, placement: 'roof' | 'wall' = 'roof'): RadarConfig {
  const wallAngle = Math.atan2(y, x)
  return { id, wallAngle, x, y, height: placement === 'roof' ? 45 : WALL_HEIGHT, placement,
    initialYaw: Math.hypot(x, y) < 1e-9 ? 0 : wallAngle * 180 / Math.PI + 180, roll: 90, beamMin: -16, beamMax: 15, beamCount: 32,
    spinStart: 0, spinSweep: 360, spinStep: 1, gimbalStart: -90, gimbalSweep: 180, gimbalStep: 3, minRange: 0.05, maxRange: 58,
    startAngle: 45, endAngle: 135, lineSpacing: 3, color: `hsl(${(id * 137.508 + 20) % 360}, 85%, 65%)` }
}

export function validateRadar(radar: RadarConfig): void {
  const position = radarPosition(radar)
  if (![position.x, position.y, position.z, radarYaw(radar), radar.roll, radar.beamMin, radar.beamMax, radar.beamCount, radar.spinStep, radar.gimbalStart, radar.gimbalSweep, radar.gimbalStep, radar.minRange, radar.maxRange].every(Number.isFinite)) throw new Error('雷达参数必须是有限数值。')
  if (Math.hypot(position.x, position.y) > YARD_RADIUS + 1e-6 || position.z <= 0) throw new Error('雷达须在圆场投影内，高度必须大于零。')
  if (radar.beamMin! < -90 || radar.beamMax! > 90 || radar.beamMin! > radar.beamMax!) throw new Error('原竖直视场须为 −90° 至 90° 的有序范围。')
  if (!Number.isInteger(radar.beamCount) || radar.beamCount! < 1 || radar.beamCount! > 256) throw new Error('线束数量须为 1–256 的整数。')
  if (radar.spinStep! < 0.1 || radar.spinStep! > 360 || radar.gimbalStep! < 0.1 || radar.gimbalStep! > 360 || radar.gimbalSweep! < 0 || radar.gimbalSweep! > 360) throw new Error('采样角间隔至少 0.1°，云台累计转角须为 0°–360°。')
  if (!Number.isFinite(radar.spinStart ?? 0) || !Number.isFinite(radar.spinSweep ?? 360) || (radar.spinSweep ?? 360) < 0 || (radar.spinSweep ?? 360) > 360) throw new Error('雷达旋转窗口须为有限起始角和 0°–360° 转角。')
  if (radar.minRange! < 0 || radar.maxRange! <= radar.minRange!) throw new Error('有效量程须满足 0 ≤ 最短距离 < 最长距离。')
}

export function gimbalAngles(radar: RadarConfig): number[] {
  const start = Math.abs(radar.gimbalStart!) > 1e9 ? radar.gimbalStart! % 360 : radar.gimbalStart!, sweep = radar.gimbalSweep!, step = radar.gimbalStep!
  const count = Math.ceil(sweep / step)
  const values: number[] = []
  for (let i = 0; i <= count; i++) {
    const offset = Math.min(sweep, i * step)
    if (sweep === 360 && offset === 360) break
    values.push(start + offset)
  }
  return values
}

export function physicalDirection(radar: RadarConfig, beam: number, spin: number, gimbal: number): Vector3 {
  const beta = beam * radians, phi = spin * radians, roll = radar.roll! * radians
  const nativeX = Math.cos(beta) * Math.cos(phi)
  const nativeY = Math.cos(beta) * Math.sin(phi)
  const nativeZ = Math.sin(beta)
  // 先绕雷达初始 X 轴侧装，再由铅垂云台旋转，二者不可交换。
  const y = Math.cos(roll) * nativeY - Math.sin(roll) * nativeZ
  const z = Math.sin(roll) * nativeY + Math.cos(roll) * nativeZ
  const yaw = (radarYaw(radar) % 360 + gimbal % 360) * radians
  const direction = new Vector3(Math.cos(yaw) * nativeX - Math.sin(yaw) * y, Math.sin(yaw) * nativeX + Math.cos(yaw) * y, z)
  // 清除正交姿态的浮点残差，避免竖直线落在网格边界时误选邻格。
  for (const axis of ['x', 'y', 'z'] as const) if (Math.abs(direction[axis]) < 1e-12) direction[axis] = 0
  return direction.normalize()
}

export function rayCount(radar: RadarConfig): number {
  validateRadar(radar)
  return gimbalAngles(radar).length * radar.beamCount! * spinAngles(radar).length
}

export function* cumulativeRays(radar: RadarConfig): Generator<Ray> {
  validateRadar(radar)
  const origin = radarPosition(radar)
  const spins = spinAngles(radar)
  for (const gimbal of gimbalAngles(radar)) for (let beam = 0; beam < radar.beamCount!; beam++) {
    const beta = radar.beamCount === 1 ? (radar.beamMin! + radar.beamMax!) / 2 : radar.beamMin! + (radar.beamMax! - radar.beamMin!) * beam / (radar.beamCount! - 1)
    for (const spin of spins) yield new Ray(origin, physicalDirection(radar, beta, spin, gimbal))
  }
}

function verticalCoalHit(field: HeightField, ray: Ray, minRange: number, limit: number): ScanPoint | null {
  const col = Math.floor((ray.origin.x - field.originX) / field.cellSize)
  const row = Math.floor((ray.origin.y - field.originY) / field.cellSize)
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3()
  let nearest = Infinity
  let result: ScanPoint | null = null
  // 竖直射线在网格边或顶点时检查所有相邻三角形，避免禁堆掩码单侧缺面造成漏点。
  for (const r of [row, row - 1]) for (const column of [col, col - 1]) {
    if (r < 0 || column < 0 || r >= field.rows - 1 || column >= field.cols - 1) continue
    const base = field.index(r, column)
    const triangles = (r + column) % 2 === 0
      ? [[base, base + 1, base + field.cols + 1], [base, base + field.cols + 1, base + field.cols]]
      : [[base, base + 1, base + field.cols], [base + 1, base + field.cols + 1, base + field.cols]]
    for (const ids of triangles) {
      if (ids.some(i => !field.enabled[i])) continue
      for (const [vertex, i] of [[a, ids[0]], [b, ids[1]], [c, ids[2]]] as const) vertex.set(field.xAt(i % field.cols), field.yAt(Math.floor(i / field.cols)), field.surfaceAt(i))
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue
      const distance = (hit.z - ray.origin.z) * ray.direction.z
      if (distance < 1e-6 || distance > limit + 1e-7 || distance >= nearest) continue
      const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
      const u = ((b.y - c.y) * (hit.x - c.x) + (c.x - b.x) * (hit.y - c.y)) / denominator
      const v = ((c.y - a.y) * (hit.x - c.x) + (a.x - c.x) * (hit.y - c.y)) / denominator
      const coal = u * field.coal[ids[0]] + v * field.coal[ids[1]] + (1 - u - v) * field.coal[ids[2]]
      nearest = distance
      result = coal >= COAL_THRESHOLD && distance >= minRange - 1e-7 ? { x: hit.x, y: hit.y, z: hit.z } : null
    }
  }
  return result
}

export function spinAngles(radar: RadarConfig): number[] {
  const start = (radar.spinStart ?? 0) % 360, sweep = radar.spinSweep ?? 360
  const count = Math.ceil(sweep / radar.spinStep!)
  const output: number[] = []
  for (let i = 0; i <= count; i++) {
    const offset = Math.min(sweep, i * radar.spinStep!)
    if (sweep === 360 && offset === 360) break
    output.push(start + offset)
  }
  return output
}

export function alignStation(radar: RadarConfig): void {
  const point = radarPosition(radar)
  radar.wallAngle = Math.atan2(point.y, point.x)
  // 站位自动朝向场心；场心处采用固定 +X，云台范围围绕该方向对称。
  radar.initialYaw = Math.hypot(point.x, point.y) < 1e-9 ? 0 : radar.wallAngle * 180 / Math.PI + 180
  radar.gimbalStart = -radar.gimbalSweep! / 2
}

export function copyRadarAt(source: RadarConfig, id: number, x: number, y: number): RadarConfig {
  if (source.id === id) throw new Error('复制雷达必须使用独立编号。')
  const identity = createRadar(id, x, y, source.placement)
  // 复制已应用的扫描参数，仅替换身份和站位；朝向和对称云台起点按新位置重建。
  const copy = { ...identity, ...source, id, color: identity.color, x, y }
  alignStation(copy)
  validateRadar(copy)
  return copy
}
