import * as THREE from 'three'
import { CameraAxes } from './CameraAxes'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { GridPointAddition, GridPointReplacement, PointCloudData, ToolMode } from '../types'
import { createPointCloudGeometry } from '../io/PlyImporter'
import { HeightField } from '../simulation/HeightField'

interface SceneContext {
  background: string
  object: THREE.Object3D
  occluder: THREE.Object3D
  updateView(cameraPosition: THREE.Vector3): void
}

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
  private generatedGroup = new THREE.Group()
  private generatedPoints: THREE.Points | null = null
  private field: HeightField | null = null
  private animationFrame = 0
  private cameraAxes: CameraAxes | null = null

  constructor(container: HTMLElement, private readonly context?: SceneContext) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'scene-canvas'
    container.append(this.canvas)
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.scene.background = new THREE.Color(context?.background ?? '#111612')
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
    if (context) {
      this.controls.touches.ONE = -1 as THREE.TOUCH
      this.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE
    }

    this.scene.add(new THREE.HemisphereLight('#d8e9d4', '#293026', 1.8))
    const sun = new THREE.DirectionalLight('#fff3d8', 2.2)
    sun.position.set(-30, -25, 55)
    this.scene.add(sun)

    if (context) {
      this.scene.add(context.object)
    } else {
      const grid = new THREE.GridHelper(200, 100, '#39443b', '#252d27')
      grid.rotation.x = Math.PI / 2
      grid.position.z = -0.03
      const gridMaterial = grid.material as THREE.LineBasicMaterial
      gridMaterial.transparent = true
      gridMaterial.opacity = 0.36
      this.scene.add(grid)
    }

    this.brushOverlay = this.createBrushOverlay()
    this.scene.add(this.brushOverlay)
    this.scene.add(this.generatedGroup)

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
    if (hit && this.context) {
      const wall = this.raycaster.intersectObject(this.context.occluder, false)[0]
      if (wall && wall.distance < hit.distance) return null
    }
    return hit?.point ?? null
  }

  enableCameraAxes(container: HTMLElement): void {
    if (!this.cameraAxes) this.cameraAxes = new CameraAxes(container)
  }

  addOverlay(object: THREE.Object3D): void {
    this.scene.add(object)
  }

  pickPlane(clientX: number, clientY: number, height: number): THREE.Vector3 | null {
    this.prepareRay(clientX, clientY)
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -height), new THREE.Vector3())
  }

  pickOverlay(clientX: number, clientY: number, object: THREE.Object3D): THREE.Object3D | null {
    this.prepareRay(clientX, clientY)
    object.updateMatrixWorld(true)
    return this.raycaster.intersectObject(object, true)[0]?.object ?? null
  }

  private prepareRay(clientX: number, clientY: number): void {
    const bounds = this.canvas.getBoundingClientRect()
    this.pointer.set(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - bounds.top) / bounds.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, this.camera)
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

  fitToField(field: HeightField, circularView?: { outerRadius: number; topDown: boolean }): void {
    const width = (field.cols - 1) * field.cellSize
    const height = (field.rows - 1) * field.cellSize
    const size = Math.max(width, height, 10)
    const center = new THREE.Vector3(field.originX + width / 2, field.originY + height / 2, 0)
    if (circularView) center.z = circularView.topDown ? 0 : 5
    this.controls.target.copy(center)
    if (circularView) {
      const distance = circularView.outerRadius * 2.72 / Math.min(1, this.camera.aspect)
      const direction = circularView.topDown
        ? new THREE.Vector3(0, -0.001, 1)
        : new THREE.Vector3(0.29, -0.63, 0.72)
      this.camera.position.copy(center).addScaledVector(direction.normalize(), distance)
    } else {
      this.camera.position.set(center.x + size * 0.55, center.y - size * 0.78, size * 0.62)
    }
    const cameraDistance = this.camera.position.distanceTo(center)
    this.camera.near = circularView ? cameraDistance / 200 : Math.max(0.02, size / 2_000)
    this.camera.far = Math.max(500, size * 12, cameraDistance * 2)
    this.camera.updateProjectionMatrix()
    this.controls.update()
    const grid = this.scene.children.find((child) => child instanceof THREE.GridHelper)
    if (grid) {
      grid.position.set(center.x, center.y, -0.03)
      grid.scale.setScalar(Math.max(1, size / 100))
    }
  }

  setGridPreview(points: readonly (GridPointReplacement | GridPointAddition)[]): void {
    this.generatedGroup.clear()
    this.generatedPoints?.geometry.dispose()
    if (this.generatedPoints) (this.generatedPoints.material as THREE.Material).dispose()
    if (points.length === 0) {
      this.generatedPoints = null
      return
    }
    const positions = new Float32Array(points.length * 3)
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      positions.set([point.x, point.y, point.z + 0.02], index * 3)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.generatedPoints = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: '#70e2ec',
      size: 0.1,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    }))
    this.generatedPoints.renderOrder = 4
    this.generatedGroup.add(this.generatedPoints)
  }

  setGeneratedVisible(visible: boolean): void {
    this.generatedGroup.visible = visible
  }

  dispose(): void {
    cancelAnimationFrame(this.animationFrame)
    this.resizeObserver.disconnect()
    this.cameraAxes?.element.remove()
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
    this.context?.updateView(this.camera.position)
    this.cameraAxes?.update(this.camera)
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
  const addTriangle = (a: number, b: number, c: number) => {
    if (!field.enabled[a] || !field.enabled[b] || !field.enabled[c]) return
    indices.set([a, b, c], cursor)
    cursor += 3
  }
  for (let row = 0; row < field.rows - 1; row += 1) {
    for (let col = 0; col < field.cols - 1; col += 1) {
      const a = field.index(row, col)
      const b = field.index(row, col + 1)
      const c = field.index(row + 1, col)
      const d = field.index(row + 1, col + 1)
      // 交替使用对角线，避免整个场地出现方向一致的三角网纹理。
      if ((row + col) % 2 === 0) {
        addTriangle(a, b, d)
        addTriangle(a, d, c)
      } else {
        addTriangle(a, b, c)
        addTriangle(b, d, c)
      }
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('coalThickness', new THREE.BufferAttribute(field.coal.slice(), 1))
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, cursor), 1))
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
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
      }
      float fbm(vec2 p) { return noise(p) * .57 + noise(p * 2.07) * .29 + noise(p * 5.11) * .14; }
      void main() {
        if (vCoal < 0.002) discard;
        vec3 normal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
        if (!gl_FrontFacing) normal = -normal;
        vec2 coalUv = vWorldPosition.xy;
        float coarse = fbm(coalUv * 0.16);
        float grain = noise(coalUv * 2.8);
        normal = normalize(normal + vec3(dFdx(grain), dFdy(grain), 0.0) * 0.08);
        vec3 lightDir = normalize(vec3(-0.35, -0.42, 0.84));
        float diffuse = max(dot(normal, lightDir), 0.0);
        float slope = 1.0 - clamp(normal.z, 0.0, 1.0);
        vec3 compacted = vec3(0.075, 0.071, 0.062);
        vec3 dry = vec3(0.145, 0.132, 0.103);
        vec3 color = mix(compacted, dry, coarse * 0.62 + grain * 0.12);
        color *= 0.42 + diffuse * 0.62 - slope * 0.08;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  })
}
