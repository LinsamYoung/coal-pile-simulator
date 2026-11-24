import * as THREE from 'three'
import type { RadarConfig, ScanPoint } from '../simulation/RadarSimulation'
import { gimbalAngles, spinAngles, physicalDirection, radarDirection, radarPosition } from '../simulation/RadarSimulation'
import { YARD_RADIUS } from '../simulation/CircularYard'

export function directionBins(radar: RadarConfig): boolean[] {
  const bins = Array<boolean>(180).fill(false)
  if (radar.beamMin === undefined) {
    for (let angle = Math.min(radar.startAngle, radar.endAngle); angle <= Math.max(radar.startAngle, radar.endAngle); angle += 0.5) {
      const yaw = radarDirection(radar, angle)
      bins[((Math.floor(yaw * 90 / Math.PI) % 180) + 180) % 180] = true
    }
    return bins
  }
  // 遮罩仅显示方向包络：用有界姿态采样投影到两度角格，实际可见煤面以首击结果为准。
  const sampledIndices = (count: number, cap: number) => Array.from({ length: Math.min(count, cap) }, (_, i) => count <= cap ? i : Math.round(i * (count - 1) / (cap - 1)))
  const gimbals = gimbalAngles(radar)
  const spins = spinAngles(radar)
  for (const g of sampledIndices(gimbals.length, 37)) for (const b of sampledIndices(radar.beamCount!, 9)) for (const spin of sampledIndices(spins.length, 72)) {
    const beta = radar.beamCount === 1 ? (radar.beamMin! + radar.beamMax!) / 2 : radar.beamMin! + (radar.beamMax! - radar.beamMin!) * b / (radar.beamCount! - 1)
    const direction = physicalDirection(radar, beta, spins[spin], gimbals[g])
    if (direction.z > 1e-8 || Math.hypot(direction.x, direction.y) < 1e-8) continue
    const index = ((Math.floor(Math.atan2(direction.y, direction.x) * 90 / Math.PI + 1e-9) % 180) + 180) % 180
    bins[index] = true
  }
  return bins
}

export function floorReachPoints(radar: RadarConfig): ScanPoint[] {
  if (radar.beamMin === undefined) return []
  const indices = (count: number, cap: number) => Array.from({ length: Math.min(count, cap) }, (_, i) => count <= cap ? i : Math.round(i * (count - 1) / (cap - 1)))
  const gimbals = gimbalAngles(radar), spins = spinAngles(radar), origin = radarPosition(radar)
  const points: ScanPoint[] = []
  // 参考可达范围只投影真实采样方向中能在量程内到达地面的射线，不代替煤面首击。
  for (const g of indices(gimbals.length, 37)) for (const b of indices(radar.beamCount!, 9)) for (const spin of indices(spins.length, 91)) {
    const beta = radar.beamCount === 1 ? (radar.beamMin! + radar.beamMax!) / 2 : radar.beamMin! + (radar.beamMax! - radar.beamMin!) * b / (radar.beamCount! - 1)
    const direction = physicalDirection(radar, beta, spins[spin], gimbals[g])
    if (direction.z >= -1e-10) continue
    const distance = -origin.z / direction.z
    if (!Number.isFinite(distance) || distance < radar.minRange! || distance > radar.maxRange! + 1e-7) continue
    const x = origin.x + direction.x * distance, y = origin.y + direction.y * distance
    if (x * x + y * y <= YARD_RADIUS ** 2 + 1e-7) points.push({ x, y, z: 0 })
  }
  return points
}

export class RadarVisuals {
  readonly object = new THREE.Group()
  readonly markers = new THREE.Group()
  private readonly sectors = new THREE.Group()
  private readonly preview = new THREE.Group()
  private readonly ghostProjection = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.1, 24), new THREE.MeshBasicMaterial({ color: '#ffdc77', depthTest: false, side: THREE.DoubleSide }))
  private readonly ghost = new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: '#ffdc77', transparent: true, opacity: 0.65, depthTest: false }))
  constructor() {
    this.object.add(this.sectors, this.markers, this.preview, this.ghost, this.ghostProjection)
    this.ghost.visible = false
    this.ghostProjection.visible = false
  }
  showGhost(point: THREE.Vector3 | null): void {
    this.ghost.visible = point !== null
    this.ghostProjection.visible = point !== null
    if (point) { this.ghost.position.copy(point); this.ghostProjection.position.set(point.x, point.y, 0.2) }
  }
  private clear(group: THREE.Group): void {
    group.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        object.geometry.dispose()
        ;(object.material as THREE.Material).dispose()
      }
    })
    group.clear()
  }
  setPreview(clouds: readonly { points: readonly ScanPoint[]; color: string }[]): void {
    this.clear(this.preview)
    for (const cloud of clouds) {
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(cloud.points.flatMap(point => [point.x, point.y, point.z + 0.08]), 3))
      this.preview.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: cloud.color, size: 0.24, depthTest: false, transparent: true, opacity: 0.9 })))
    }
    this.preview.renderOrder = 9
  }
  setReferenceVisible(visible: boolean): void { this.sectors.visible = visible }
  update(radars: readonly RadarConfig[], selectedId?: number): void {
    this.clear(this.markers)
    this.clear(this.sectors)
    for (const radar of radars) {
      const origin = radarPosition(radar)
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 1.4, 16), new THREE.MeshBasicMaterial({ color: radar.color, depthTest: false }))
      marker.rotation.x = Math.PI / 2
      marker.position.copy(origin)
      marker.userData.radarId = radar.id
      marker.renderOrder = 8
      this.markers.add(marker)
      const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(origin.x, origin.y, 0), origin]), new THREE.LineBasicMaterial({ color: radar.color, transparent: true, opacity: 0.55 }))
      this.sectors.add(stem)
      const samples = floorReachPoints(radar)
      const bins = new Map<number, { min: number; max: number }>()
      for (const point of samples) {
        const dx = point.x - origin.x, dy = point.y - origin.y
        const bin = ((Math.floor(Math.atan2(dy, dx) * 90 / Math.PI) % 180) + 180) % 180
        const radius = Math.hypot(dx, dy)
        const previous = bins.get(bin)
        bins.set(bin, { min: Math.min(previous?.min ?? radius, radius), max: Math.max(previous?.max ?? radius, radius) })
      }
      const positions: number[] = [], edges: number[] = []
      const projected = (bin: number, radius: number) => {
        const angle = (bin + 0.5) * Math.PI / 90
        const dx = Math.cos(angle), dy = Math.sin(angle)
        const projection = origin.x * dx + origin.y * dy
        const yardLimit = -projection + Math.sqrt(Math.max(0, projection ** 2 + YARD_RADIUS ** 2 - origin.x ** 2 - origin.y ** 2))
        const rangeLimit = Math.sqrt(Math.max(0, radar.maxRange! ** 2 - origin.z ** 2))
        const bounded = Math.min(radius, yardLimit, rangeLimit)
        return [origin.x + dx * bounded, origin.y + dy * bounded, 0.12]
      }
      for (const [bin, values] of bins) {
        const next = bins.get((bin + 1) % 180)
        if (!next) continue
        const a = projected(bin, values.min), b = projected(bin, values.max)
        const c = projected(bin + 1, next.min), d = projected(bin + 1, next.max)
        positions.push(...a, ...b, ...d, ...a, ...d, ...c)
        edges.push(...a, ...c, ...b, ...d)
      }
      const referencePoints = new THREE.BufferGeometry()
      referencePoints.setAttribute('position', new THREE.Float32BufferAttribute(samples.flatMap(point => [point.x, point.y, 0.15]), 3))
      this.sectors.add(new THREE.Points(referencePoints, new THREE.PointsMaterial({ color: radar.color, size: 0.12, transparent: true, opacity: 0.35, depthWrite: false })))
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      const sector = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: radar.color, transparent: true, opacity: 0.14, depthWrite: false, depthTest: false, side: THREE.DoubleSide }))
      sector.renderOrder = 5
      this.sectors.add(sector)
      const outlineGeometry = new THREE.BufferGeometry()
      outlineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3))
      const outline = new THREE.LineSegments(outlineGeometry, new THREE.LineBasicMaterial({ color: radar.id === selectedId ? '#ffffff' : radar.color, transparent: true, opacity: radar.id === selectedId ? 1 : 0.4, depthTest: false }))
      outline.renderOrder = 6
      this.sectors.add(outline)
    }
  }
}
