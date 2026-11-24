import * as THREE from 'three'
import { CLEARANCE_RADIUS, WALL_HEIGHT, YARD_RADIUS } from '../simulation/CircularYard'

const WALL_THICKNESS = 1.6
const WALL_OUTER_RADIUS = YARD_RADIUS + WALL_THICKNESS
export const YARD_VIEW_RADIUS = 70

export function createCircularYardScenery() {
  const object = new THREE.Group()
  const foundation = new THREE.Mesh(
    new THREE.CylinderGeometry(WALL_OUTER_RADIUS + 0.9, WALL_OUTER_RADIUS + 0.9, 1.4, 192),
    new THREE.MeshStandardMaterial({ color: '#414b4e', roughness: 0.92 }),
  )
  foundation.rotation.x = Math.PI / 2
  foundation.position.z = -0.9
  object.add(foundation)

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(YARD_RADIUS, 192),
    new THREE.MeshStandardMaterial({ color: '#667577', roughness: 0.98 }),
  )
  floor.position.z = -0.07
  object.add(floor)

  const clearance = new THREE.Mesh(
    new THREE.CircleGeometry(CLEARANCE_RADIUS, 96),
    new THREE.MeshStandardMaterial({ color: '#465759', roughness: 0.98 }),
  )
  clearance.position.z = -0.048
  object.add(clearance)
  const clearanceMark = new THREE.Mesh(
    new THREE.RingGeometry(CLEARANCE_RADIUS - 0.24, CLEARANCE_RADIUS, 96),
    new THREE.MeshBasicMaterial({ color: '#b8c7ac' }),
  )
  clearanceMark.position.z = -0.03
  object.add(clearanceMark)

  const fullWall = createWallGeometry(false)
  const cutWall = createWallGeometry(true)
  const occluder = new THREE.Mesh(cutWall, [
    new THREE.MeshStandardMaterial({ color: '#6c7776', roughness: 0.87, side: THREE.DoubleSide }),
    new THREE.MeshStandardMaterial({ color: '#434f50', roughness: 0.92, side: THREE.DoubleSide }),
  ])
  object.add(occluder)
  object.add(createAngleScale())

  let cutaway = true
  return {
    background: '#567b9b',
    object,
    occluder,
    setCutaway(value: boolean) {
      cutaway = value
      occluder.geometry = cutaway ? cutWall : fullWall
    },
    updateView(cameraPosition: THREE.Vector3) {
      // 剖开朝向观察者的半圈墙体，保留背侧墙体作为空间参照。
      occluder.rotation.z = cutaway ? Math.atan2(cameraPosition.y, cameraPosition.x) + Math.PI : 0
      occluder.updateMatrixWorld()
    },
  }
}

function createWallGeometry(cutaway: boolean): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape()
  if (cutaway) {
    shape.absarc(0, 0, WALL_OUTER_RADIUS, -Math.PI / 2, Math.PI / 2, false)
    shape.absarc(0, 0, YARD_RADIUS, Math.PI / 2, -Math.PI / 2, true)
    shape.closePath()
  } else {
    shape.absarc(0, 0, WALL_OUTER_RADIUS, 0, 2 * Math.PI, false)
    const inside = new THREE.Path()
    inside.absarc(0, 0, YARD_RADIUS, 0, 2 * Math.PI, true)
    shape.holes.push(inside)
  }
  return new THREE.ExtrudeGeometry(shape, { depth: WALL_HEIGHT, bevelEnabled: false, curveSegments: 96 })
}

function createAngleScale(): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2048
  const context = canvas.getContext('2d')!
  const center = canvas.width / 2
  const pixelsPerMeter = center / (YARD_VIEW_RADIUS + 1)
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  for (let degrees = 0; degrees < 360; degrees += 2) {
    const radians = degrees * Math.PI / 180
    const dx = Math.sin(radians) * pixelsPerMeter
    const dy = -Math.cos(radians) * pixelsPerMeter
    const major = degrees % 10 === 0
    const cardinal = degrees % 90 === 0
    const start = WALL_OUTER_RADIUS + 1.7
    const end = start + (major ? 1.9 : 0.85)
    context.beginPath()
    context.moveTo(center + dx * start, center + dy * start)
    context.lineTo(center + dx * end, center + dy * end)
    context.lineWidth = major ? 3 : 1.6
    context.strokeStyle = cardinal ? '#f1efac' : major ? '#e7f1f8' : '#334d63'
    context.stroke()
    if (major) {
      context.fillStyle = cardinal ? '#f1efac' : '#edf5fb'
      context.font = '600 32px monospace'
      context.fillText(`${degrees}°`, center + dx * 68, center + dy * 68)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  const scale = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * (YARD_VIEW_RADIUS + 1), 2 * (YARD_VIEW_RADIUS + 1)),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, fog: false, toneMapped: false }),
  )
  scale.position.z = -0.24
  return scale
}
