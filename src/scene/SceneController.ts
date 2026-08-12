import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { PointCloudData, RadarConfig, RadarPoint, ToolMode } from '../types'
import { createPointCloudGeometry } from '../io/PlyImporter'
import { HeightField } from '../simulation/HeightField'

export class SceneController {
  readonly canvas: HTMLCanvasElement
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.05, 3_000)
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly resizeObserver: ResizeObserver
  private pointCloud: THREE.Points | null = null
  private coalMesh: THREE.Mesh | null = null
  private coalMaterial: THREE.ShaderMaterial | null = null
  private brushOverlay: THREE.Group
  private radarGroup = new THREE.Group()
  private radarPoints: THREE.Points | null = null
  private field: HeightField | null = null
  private animationFrame = 0

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'scene-canvas'
    container.append(this.canvas)
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.scene.background = new THREE.Color('#111612')
    this.scene.fog = new THREE.FogExp2('#111612', 0.0025)

    this.camera.up.set(0, 0, 1)
    this.camera.position.set(32, -38, 28)
    this.controls = new OrbitControls(this.camera, this.canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.075
    this.controls.screenSpacePanning = true
    this.controls.minDistance = 1
    this.controls.maxDistance = 1_000
    this.controls.mouseButtons.LEFT = -1 as THREE.MOUSE
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE

    this.scene.add(new THREE.HemisphereLight('#d8e9d4', '#293026', 1.8))
    const sun = new THREE.DirectionalLight('#fff3d8', 2.2)
    sun.position.set(-30, -25, 55)
    this.scene.add(sun)

    const grid = new THREE.GridHelper(200, 100, '#39443b', '#252d27')
    grid.rotation.x = Math.PI / 2
    grid.position.z = -0.03
    const gridMaterial = grid.material as THREE.LineBasicMaterial
    gridMaterial.transparent = true
    gridMaterial.opacity = 0.36
    this.scene.add(grid)

    this.brushOverlay = this.createBrushOverlay()
    this.scene.add(this.brushOverlay)
    this.scene.add(this.radarGroup)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    this.resize()
    this.animate()
  }

  setPointCloud(data: PointCloudData): void {
    if (this.pointCloud) {
      this.scene.remove(this.pointCloud)
      this.pointCloud.geometry.dispose()
      ;(this.pointCloud.material as THREE.Material).dispose()
    }
    const material = new THREE.PointsMaterial({
      size: 0.09,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.86,
      depthWrite: true,
    })
    this.pointCloud = new THREE.Points(createPointCloudGeometry(data), material)
    this.pointCloud.renderOrder = 0
    this.scene.add(this.pointCloud)
  }

  setHeightField(field: HeightField): void {
    this.field = field
    if (this.coalMesh) {
      this.scene.remove(this.coalMesh)
      this.coalMesh.geometry.dispose()
      this.coalMaterial?.dispose()
    }
    const geometry = createHeightFieldGeometry(field)
    this.coalMaterial = createCoalMaterial()
    this.coalMesh = new THREE.Mesh(geometry, this.coalMaterial)
    this.coalMesh.renderOrder = 1
    this.scene.add(this.coalMesh)
  }

  updateCoalMesh(): void {
    if (!this.coalMesh || !this.field) return
    const position = this.coalMesh.geometry.getAttribute('position') as THREE.BufferAttribute
    const thickness = this.coalMesh.geometry.getAttribute('coalThickness') as THREE.BufferAttribute
    for (let i = 0; i < this.field.size; i += 1) {
      position.setZ(i, this.field.surfaceAt(i) + 0.012)
      thickness.setX(i, this.field.coal[i])
    }
    position.needsUpdate = true
    thickness.needsUpdate = true
    this.coalMesh.geometry.computeBoundingSphere()
  }

  pick(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.coalMesh) return null
    const bounds = this.canvas.getBoundingClientRect()
    this.pointer.set(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hit = this.raycaster.intersectObject(this.coalMesh, false)[0]
    return hit?.point ?? null
  }

  setBrush(point: THREE.Vector3 | null, radius: number, mode: ToolMode): void {
    this.brushOverlay.visible = point !== null
    if (!point) return
    this.brushOverlay.position.set(point.x, point.y, point.z + 0.08)
    this.brushOverlay.scale.setScalar(radius)
    const color = mode === 'deposit' ? new THREE.Color('#d8ef51') : new THREE.Color('#ff9d52')
    for (const child of this.brushOverlay.children) {
      const material = (child as THREE.Mesh | THREE.Line).material as THREE.Material & { color?: THREE.Color }
      material.color?.copy(color)
    }
  }

  fitToField(field: HeightField): void {
    const width = (field.cols - 1) * field.cellSize
    const height = (field.rows - 1) * field.cellSize
    const size = Math.max(width, height, 10)
    const center = new THREE.Vector3(field.originX + width / 2, field.originY + height / 2, 0)
    this.controls.target.copy(center)
    this.camera.position.set(center.x + size * 0.55, center.y - size * 0.78, size * 0.62)
    this.camera.near = Math.max(0.02, size / 2_000)
    this.camera.far = Math.max(500, size * 12)
    this.camera.updateProjectionMatrix()
    this.controls.update()
    const grid = this.scene.children.find((child) => child instanceof THREE.GridHelper)
    if (grid) {
      grid.position.set(center.x, center.y, -0.03)
      grid.scale.setScalar(Math.max(1, size / 100))
    }
  }

  setRadarVisualization(config: RadarConfig, points: RadarPoint[]): void {
    this.radarGroup.clear()
    this.radarPoints?.geometry.dispose()
    if (this.radarPoints) (this.radarPoints.material as THREE.Material).dispose()

    const marker = new THREE.Group()
    marker.position.set(...config.position)
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.22, 0.42, 12),
      new THREE.MeshStandardMaterial({ color: '#73e3f3', metalness: 0.7, roughness: 0.25 }),
    )
    body.rotation.x = Math.PI / 2
    marker.add(body)
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 16, 12),
      new THREE.MeshBasicMaterial({ color: '#73e3f3', transparent: true, opacity: 0.13 }),
    )
    marker.add(pulse)
    this.radarGroup.add(marker)
    this.radarGroup.add(createRadarFrustum(config))

    if (points.length > 0) {
      const positions = new Float32Array(points.length * 3)
      const colors = new Float32Array(points.length * 3)
      const low = new THREE.Color('#47d8ea')
      const high = new THREE.Color('#f4f76f')
      const mixed = new THREE.Color()
      points.forEach((point, index) => {
        positions.set([point.x, point.y, point.z], index * 3)
        mixed.copy(low).lerp(high, point.intensity / 255)
        colors.set([mixed.r, mixed.g, mixed.b], index * 3)
      })
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      this.radarPoints = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 0.13,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
      }))
      this.radarGroup.add(this.radarPoints)
    } else {
      this.radarPoints = null
    }
  }

  setRadarVisible(visible: boolean): void {
    this.radarGroup.visible = visible
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.renderer.dispose()
  }

  private createBrushOverlay(): THREE.Group {
    const group = new THREE.Group()
    group.visible = false
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({ color: '#d8ef51', transparent: true, opacity: 0.105, depthWrite: false, side: THREE.DoubleSide }),
    )
    group.add(disc)
    const ringGeometry = new THREE.BufferGeometry()
    const positions = new Float32Array(65 * 3)
    for (let i = 0; i <= 64; i += 1) {
      const angle = (i / 64) * Math.PI * 2
      positions.set([Math.cos(angle), Math.sin(angle), 0.012], i * 3)
    }
    ringGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    group.add(new THREE.Line(ringGeometry, new THREE.LineBasicMaterial({ color: '#d8ef51', transparent: true, opacity: 0.95 })))
    group.renderOrder = 3
    return group
  }

  private resize(): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    if (width <= 0 || height <= 0) return
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  private animate = (): void => {
    this.animationFrame = requestAnimationFrame(this.animate)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }
}

function createHeightFieldGeometry(field: HeightField): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(field.size * 3)
  for (let row = 0; row < field.rows; row += 1) {
    for (let col = 0; col < field.cols; col += 1) {
      const index = field.index(row, col)
      positions.set([field.xAt(col), field.yAt(row), field.surfaceAt(index) + 0.012], index * 3)
    }
  }
  const indexCount = (field.rows - 1) * (field.cols - 1) * 6
  const indices = field.size > 65_535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount)
  let cursor = 0
  for (let row = 0; row < field.rows - 1; row += 1) {
    for (let col = 0; col < field.cols - 1; col += 1) {
      const a = field.index(row, col)
      const b = field.index(row, col + 1)
      const c = field.index(row + 1, col)
      const d = field.index(row + 1, col + 1)
      indices.set([a, b, d, a, d, c], cursor)
      cursor += 6
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('coalThickness', new THREE.BufferAttribute(field.coal.slice(), 1))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}

function createCoalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: false,
    vertexShader: `
      attribute float coalThickness;
      varying float vCoal;
      varying vec3 vWorldPosition;
      void main() {
        vCoal = coalThickness;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldPosition = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      varying float vCoal;
      varying vec3 vWorldPosition;
      void main() {
        if (vCoal < 0.002) discard;
        vec3 normal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
        if (!gl_FrontFacing) normal = -normal;
        vec3 lightDir = normalize(vec3(-0.35, -0.42, 0.84));
        float diffuse = max(dot(normal, lightDir), 0.0);
        float rim = pow(1.0 - max(dot(normal, normalize(cameraPosition - vWorldPosition)), 0.0), 2.0);
        float heightMix = clamp(vCoal / 8.0, 0.0, 1.0);
        vec3 lowColor = vec3(0.105, 0.094, 0.076);
        vec3 highColor = vec3(0.24, 0.205, 0.145);
        vec3 color = mix(lowColor, highColor, heightMix) * (0.48 + diffuse * 0.72);
        color += rim * vec3(0.12, 0.105, 0.075);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  })
}

function createRadarFrustum(config: RadarConfig): THREE.LineSegments {
  const position = new THREE.Vector3(...config.position)
  const corners: THREE.Vector3[] = []
  for (const elevation of [-config.verticalFovDeg / 2, config.verticalFovDeg / 2]) {
    for (const azimuth of [-config.horizontalFovDeg / 2, config.horizontalFovDeg / 2]) {
      const yaw = (config.yawDeg + azimuth) * Math.PI / 180
      const pitch = (config.pitchDeg + elevation) * Math.PI / 180
      corners.push(new THREE.Vector3(
        position.x + config.maxRange * Math.cos(pitch) * Math.cos(yaw),
        position.y + config.maxRange * Math.cos(pitch) * Math.sin(yaw),
        position.z + config.maxRange * Math.sin(pitch),
      ))
    }
  }
  const segments: number[] = []
  const add = (a: THREE.Vector3, b: THREE.Vector3) => segments.push(a.x, a.y, a.z, b.x, b.y, b.z)
  corners.forEach((corner) => add(position, corner))
  add(corners[0], corners[1])
  add(corners[1], corners[3])
  add(corners[3], corners[2])
  add(corners[2], corners[0])
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3))
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: '#62dbe9', transparent: true, opacity: 0.22 }))
}
