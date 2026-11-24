import { Camera, Quaternion, Vector3 } from 'three'

export class CameraAxes {
  readonly element: SVGSVGElement
  private readonly axes: { direction: Vector3; line: SVGLineElement; label: SVGTextElement; tip: SVGCircleElement }[] = []
  private readonly previous = new Quaternion(0, 0, 0, 0)
  private readonly inverse = new Quaternion()
  private readonly projected = new Vector3()
  constructor(container: HTMLElement) {
    const namespace = 'http://www.w3.org/2000/svg'
    this.element = document.createElementNS(namespace, 'svg')
    this.element.setAttribute('viewBox', '0 0 112 112')
    this.element.setAttribute('aria-label', '随相机旋转的场地 XYZ 坐标轴，Z 向上')
    this.element.setAttribute('role', 'img')
    this.element.classList.add('camera-axes')
    const circle = document.createElementNS(namespace, 'circle')
    circle.setAttribute('cx', '56'); circle.setAttribute('cy', '56'); circle.setAttribute('r', '51')
    circle.setAttribute('fill', '#16251eb8'); circle.setAttribute('stroke', '#d5e6de44')
    this.element.append(circle)
    for (const [name, color, direction] of [['X', '#ed8c80', new Vector3(1, 0, 0)], ['Y', '#badb85', new Vector3(0, 1, 0)], ['Z', '#8bc9f4', new Vector3(0, 0, 1)]] as const) {
      const line = document.createElementNS(namespace, 'line')
      line.setAttribute('x1', '56'); line.setAttribute('y1', '56'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', '2.5')
      const label = document.createElementNS(namespace, 'text')
      label.textContent = name; label.setAttribute('fill', color); label.setAttribute('font-size', '12'); label.setAttribute('font-weight', '700'); label.setAttribute('text-anchor', 'middle'); label.setAttribute('dominant-baseline', 'middle')
      const tip = document.createElementNS(namespace, 'circle')
      tip.setAttribute('r', '3'); tip.setAttribute('fill', color)
      this.element.append(line, tip, label)
      this.axes.push({ direction, line, label, tip })
    }
    container.append(this.element)
  }
  update(camera: Camera): void {
    if (this.previous.equals(camera.quaternion)) return
    this.previous.copy(camera.quaternion)
    // 使用相机视图基变换世界轴，长度与缩放无关；正向朝观察者时提高亮度。
    this.inverse.copy(camera.quaternion).invert()
    for (const axis of this.axes) {
      this.projected.copy(axis.direction).applyQuaternion(this.inverse)
      axis.line.setAttribute('x2', String(56 + this.projected.x * 32))
      axis.line.setAttribute('y2', String(56 - this.projected.y * 32))
      axis.tip.setAttribute('cx', String(56 + this.projected.x * 32))
      axis.tip.setAttribute('cy', String(56 - this.projected.y * 32))
      const aligned = Math.hypot(this.projected.x, this.projected.y) < 0.15
      axis.label.setAttribute('x', String(56 + this.projected.x * 42 + (aligned ? 9 : 0)))
      axis.label.setAttribute('y', String(56 - this.projected.y * 42 - (aligned ? 10 : 0)))
      axis.line.setAttribute('opacity', this.projected.z < 0 ? '0.55' : '1')
    }
  }
}
