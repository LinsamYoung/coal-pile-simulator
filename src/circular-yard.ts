import './style.css'
import { Vector3 } from 'three'
import { RadarVisuals } from './scene/RadarVisuals'
import { completeCoalSurface, snapshotField, createRadar, copyRadarAt, radarPosition, alignStation, validateRadar, type RadarConfig } from './simulation/RadarSimulation'
import { createStoredZip, pointsToPly, scanResultFiles } from './io/RadarExporter'
import { runScanBatch, type ScanBatch } from './simulation/ScanBatch'
import { overlapPoints, stationTransform, registrationError } from './simulation/RadarAnalysis'
import { downloadBlob } from './io/PointCloudExporter'
import { createCircularYardScenery, YARD_VIEW_RADIUS } from './scene/CircularYardScenery'
import { SceneController } from './scene/SceneController'
import { applyBrushStroke } from './simulation/BrushEngine'
import { CELL_SIZE, CLEARANCE_RADIUS, createCircularYard, isYardWorkArea, WALL_HEIGHT, YARD_RADIUS } from './simulation/CircularYard'
import { calculateCoalStatistics } from './simulation/VolumeCalculator'
import type { BrushSettings, ToolMode } from './types'

const propertyFields = [
  ['x', '位置 X（m）', -60, 60], ['y', '位置 Y（m）', -60, 60], ['height', '离地高度 Z（m）', 0.1, 200],
  ['maxRange', '有效最远距离（m）', 0.1, 1000], ['gimbalSweep', '云台对称扫描角（°）', 0, 360],
] as const
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <div class="app-shell circular-yard">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <div><b>CoalForm</b><span>圆形料场仿真</span></div>
      </div>
      <nav class="workspace-header" aria-label="仿真页面">
        <a class="workspace-link" href="./index.html"><span aria-hidden="true">←</span> 点云编辑</a>
      </nav>
      <div class="topbar-help"><kbd>中键</kbd> 平移 <kbd>右键</kbd> 旋转 <kbd>滚轮</kbd> 缩放</div>
    </header>

    <aside class="sidebar yard-sidebar" aria-label="料场控制">
      <section class="section">
        <div class="section-heading"><div><h2>场地参数</h2><p>工程参考尺寸</p></div></div>
        <dl class="yard-dimensions">
          <div><dt>内径</dt><dd>${YARD_RADIUS * 2} m</dd></div>
          <div><dt>挡煤墙高</dt><dd>${WALL_HEIGHT} m</dd></div>
          <div><dt>中央禁堆半径</dt><dd>${CLEARANCE_RADIUS} m</dd></div>
          <div><dt>仿真网格</dt><dd>${CELL_SIZE} m</dd></div>
        </dl>
        <button id="reset-yard" class="export-full-button" type="button" disabled>恢复空场</button>
      </section>

      <section class="section">
        <div class="section-heading"><div><h2>堆取料</h2><p>在场内按住并拖动</p></div></div>
        <div class="tool-switch" aria-label="作业工具">
          <button id="deposit" class="tool-button is-active" aria-pressed="true" type="button"><span class="tool-symbol" aria-hidden="true">＋</span><b>堆料</b></button>
          <button id="excavate" class="tool-button" aria-pressed="false" type="button"><span class="tool-symbol excavate" aria-hidden="true">−</span><b>取料</b></button>
        </div>
        <div class="control-list">
          <label class="range-control"><span>笔刷半径 <output id="radius-output"></output></span><input id="radius" type="range" min="1" max="14" step="0.5" value="6"></label>
          <label class="range-control"><span>作业强度 <output id="strength-output"></output></span><input id="strength" type="range" min="0.5" max="10" step="0.5" value="5"></label>
          <label class="range-control"><span>安息角 <output id="repose-angle-output"></output></span><input id="repose-angle" type="range" min="25" max="45" step="1" value="37"></label>
        </div>
        <div class="inline-fields">
          <label><span>堆积密度</span><div><input id="density" type="number" min="0.1" max="5" step="0.05" value="0.85"><em>t/m³</em></div></label>
        </div>
      </section>
      <section class="section radar-section">
        <div class="section-heading"><div><h2>雷达扫描</h2><p>屋顶 / 墙顶布设 · 右键设置</p></div></div>
        <label class="radar-select-label">新增布站模式<select id="placement-mode"><option value="roof">屋顶投影（默认 45 m）</option><option value="wall">墙顶内沿（15 m）</option></select></label>
        <button id="add-radar" class="export-full-button" type="button" aria-pressed="false">＋ 新增雷达</button>
        <label class="radar-select-label">复制来源<select id="copy-radar-source"><option value="">暂无可复制雷达</option></select></label>
        <button id="copy-radar" class="export-full-button" type="button" aria-pressed="false" disabled>复制已有雷达</button>
        <p id="radar-status" class="radar-help" role="status">屋顶模式自动切换俯视，左键放置；拖动标记可移动，Esc 取消。</p>
        <div id="radar-list" class="radar-list" aria-label="已布设雷达"></div>
        <button id="roof-presets" class="export-full-button" type="button">添加四站屋顶示例（30 m / 45 m）</button>
        <label class="radar-spacing">统一去重容差（m）<input id="dedup-tolerance" type="number" min="0" max="5" step="any" value="0"></label>
        <p class="radar-help">0 保留重复采样；正容差按顺序保留首个邻近点。所有雷达采用同一规则。</p>
        <button id="scan-radars" class="export-full-button" type="button" disabled>生成累计扫描快照</button>
        <button id="cancel-scan" class="export-full-button" type="button" hidden>取消扫描</button>
        <progress id="scan-progress" max="1" value="0" aria-label="累计扫描进度"></progress>
        <p id="view-mode" class="radar-help">当前煤堆编辑 · 浅色范围为平地参考可达范围，不计煤堆遮挡</p>
        <p id="snapshot-info" class="radar-help">尚无扫描快照</p>
        <button id="show-live" class="export-full-button" type="button">返回当前煤堆编辑</button>
        <button id="export-snapshot-coal" class="export-full-button" type="button" disabled>导出快照完整煤面 PLY</button>
        <button id="export-coal" class="export-full-button" type="button">导出完整煤面 PLY</button>
        <button id="export-radars" class="export-full-button" type="button" disabled>导出雷达扫描 ZIP</button>
        <p class="radar-help">ZIP 含两组雷达 PLY：yard_coordinates/ 为统一场地坐标（场心原点，Z 向上）；radar_local/ 为各雷达局部坐标（雷达原点，X 沿初始朝向、Y 向左、Z 向上；不随侧装或云台改变）。单位米，同一批扫描点，空扫描成对保留。完整煤面仍用场地坐标。</p>
      </section>
      <section class="section radar-analysis">
        <div class="section-heading"><div><h2>快照可见煤面与重叠</h2><p>统计只使用已完成快照</p></div></div>
        <label class="radar-select-label">单站预览<select id="preview-radar"><option value="">全部雷达</option></select></label>
        <label class="radar-select-label">雷达 A<select id="overlap-a"></select></label>
        <label class="radar-select-label">雷达 B<select id="overlap-b"></select></label>
        <label class="radar-spacing">最近邻阈值（m）<input id="overlap-threshold" type="number" min="0" max="10" step="any" value="0.5"></label>
        <button id="analyze-overlap" class="export-full-button" type="button">预览两站共同可见点</button>
        <pre id="overlap-result" class="radar-report">先生成扫描快照</pre>
        <p class="radar-help">A→B、B→A 分别以各自全部有效点为分母。指标受采样密度及阈值影响，不作为拼接成功保证。参考可达范围按实际采样方向投影至地面，并受有效距离与圆场边界限制；不代表遮挡后的煤面覆盖。快照预览只显示实际煤面首击点。</p>
        <pre id="station-reference" class="radar-report"></pre>
        <details><summary>输入 B→A 配准估计，与已知站位比较</summary>
          <div class="radar-estimate">${['yaw', 'x', 'y', 'z'].map(key => `<label>${key === 'yaw' ? '旋转角（°）' : `平移 ${key}（m）`}<input id="estimate-${key}" type="number" step="any" value="0"></label>`).join('')}</div>
          <button id="compare-registration" class="export-full-button" type="button">计算旋转 / 平移误差</button>
          <p id="registration-error" class="radar-help"></p>
        </details>
        <button id="overlap-graph-button" class="export-full-button" type="button">计算全部站位重叠连通图</button>
        <pre id="overlap-graph" class="radar-report"></pre>
      </section>
    </aside>

    <main class="viewport" id="viewport" aria-label="圆形料场三维视图">
      <div class="yard-view-controls" aria-label="观察视图">
        <button id="perspective-view" aria-pressed="true" type="button">立体</button>
        <button id="top-view" aria-pressed="false" type="button">俯视</button>
        <button id="cutaway" aria-pressed="true" type="button">挡墙剖视</button>
      </div>
      <div id="radar-properties" class="radar-properties" hidden role="dialog" aria-label="雷达属性">
        <div class="radar-properties-title"><b id="radar-title"></b><button id="close-radar" type="button" aria-label="关闭雷达属性">×</button></div>
        <p>站位自动朝向场心，移动后自动更新。局部 X 向前、Y 向左、Z 向上；场心位置以 +X 为前方。</p>
        <div class="radar-fields">${propertyFields.map(([key, label, min, max]) => `<label>${label}<input id="radar-${key}" data-radar-property="${key}" type="number" min="${min}" max="${max}" step="any"></label>`).join('')}</div>
        <fieldset class="radar-beam-settings">
          <legend>线束设置</legend>
          <label class="radar-select-label">激光线数<input id="radar-beamCount" type="number" min="1" max="256" step="1"></label>
          <p>原生垂直视场（侧装前，°）</p>
          <div class="radar-fields">
            <label>下限（°）<input id="radar-beamMin" type="number" min="-90" max="90" step="any"></label>
            <label>上限（°）<input id="radar-beamMax" type="number" min="-90" max="90" step="any"></label>
          </div>
          <p id="radar-beam-summary" class="radar-help"></p>
          <button id="apply-radar-beams" class="export-full-button" type="button">应用线束设置</button>
        </fieldset>
        <label class="radar-select-label">扫描方式<select id="radar-scan-window"><option value="forward">前下方（270°–360°）</option><option value="full">原生完整 360°（默认）</option></select></label>
        <div class="radar-range-presets"><button type="button" data-range-preset="50">50 m</button><button type="button" data-range-preset="80">80 m</button></div>
        <p>浅色范围为平地可达估算，实际覆盖以扫描点为准。新增默认：屋顶高 45 m、最远 58 m、云台对称 180°、原生完整 360°；32 条激光线、原生垂直视场 −16°～15°，均可调整；线束在所设范围内均匀分布（单线取中间角）。侧装 90°，旋转间隔 1°、云台间隔 3°、近距 0.05 m。有效距离为统一仿真截断，不代表真实逐通道量程。</p>
        <p id="radar-validation" role="status"></p>
        <button id="move-radar" class="export-full-button" type="button">重新选择投影位置</button>
        <button id="delete-radar" type="button">删除此雷达</button>
      </div>
      <div class="stats-panel" aria-label="盘煤统计">
        <div><span>煤堆体积</span><b id="stat-volume">0.0</b><em>m³</em></div>
        <div><span>估算质量</span><b id="stat-mass">0.0</b><em>t</em></div>
        <div><span>最大堆高</span><b id="stat-height">0.00</b><em>m</em></div>
      </div>
    </main>
  </div>
  <dialog id="clear-yard">
    <form method="dialog">
      <h2>恢复空场？</h2>
      <p>将清空当前场内的煤堆。</p>
      <div><button value="cancel" autofocus>取消</button><button value="confirm" class="confirm-clear">确认清空</button></div>
    </form>
  </dialog>
`

const field = createCircularYard()
const scenery = createCircularYardScenery()
const scene = new SceneController(element('viewport'), scenery)
scene.enableCameraAxes(element('viewport'))
const brush: BrushSettings = {
  mode: 'deposit', radius: 6, strength: 5, falloff: 0.6, maxHeight: 34, reposeAngleDeg: 37, relaxation: 0.35,
}
const { canvas } = scene
const radars: RadarConfig[] = []
const radarVisuals = new RadarVisuals()
scene.addOverlay(radarVisuals.object)
let radarExportBusy = false
let nextRadarId = 1
let placingRadar = false
let ghostPoint: Vector3 | null = null
let movingRadar: RadarConfig | null = null
let copySource: RadarConfig | null = null
let draggingRadar: number | null = null
let retainedBatch: ScanBatch | null = null
let scanAbort: AbortController | null = null
let viewingSnapshot = false
let selectedRadar: RadarConfig | null = null
let rightStart: { x: number; y: number; id: number | null; moved: boolean } | null = null
const resetButton = element<HTMLButtonElement>('reset-yard')
let density = 0.85
let cutaway = true
let pointerId: number | null = null
let hover: Vector3 | null = null
let from: Vector3 | null = null
let frame = 0
let lastPaintAt = 0
let lastStatsAt = 0

scene.setHeightField(field)
setView(false)
updateStatistics()

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function updateStatistics(): void {
  const stats = calculateCoalStatistics(viewingSnapshot && retainedBatch ? retainedBatch.field : field, density)
  resetButton.disabled = stats.volume === 0
  element('stat-volume').textContent = stats.volume.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  element('stat-mass').textContent = stats.mass.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  element('stat-height').textContent = stats.maxHeight.toFixed(2)
}

function setView(topDown: boolean): void {
  scene.fitToField(field, { outerRadius: YARD_VIEW_RADIUS, topDown })
  element('perspective-view').setAttribute('aria-pressed', String(!topDown))
  element('top-view').setAttribute('aria-pressed', String(topDown))
}

function bindRange(id: string, apply: (value: number) => void, unit: string): void {
  const input = element<HTMLInputElement>(id)
  const update = () => {
    const value = input.valueAsNumber
    apply(value)
    element<HTMLOutputElement>(`${id}-output`).value = `${value}${unit}`
    const progress = (value - Number(input.min)) / (Number(input.max) - Number(input.min))
    input.style.setProperty('--range-progress', `${progress * 100}%`)
  }
  input.addEventListener('input', update)
  update()
}

const toolModes: readonly ToolMode[] = ['deposit', 'excavate']
for (const mode of toolModes) {
  element(mode).addEventListener('click', () => {
    showLive()
    brush.mode = mode
    for (const candidate of toolModes) {
      element(candidate).classList.toggle('is-active', mode === candidate)
      element(candidate).setAttribute('aria-pressed', String(mode === candidate))
    }
  })
}
bindRange('radius', (value) => { brush.radius = value }, ' m')
bindRange('strength', (value) => { brush.strength = value }, ' m/s')
bindRange('repose-angle', (value) => { brush.reposeAngleDeg = value }, '°')
const densityInput = element<HTMLInputElement>('density')
densityInput.addEventListener('input', () => {
  if (densityInput.validity.valid && Number.isFinite(densityInput.valueAsNumber)) {
    density = densityInput.valueAsNumber
    updateStatistics()
  }
})
densityInput.addEventListener('change', () => { densityInput.value = String(density) })
element('perspective-view').addEventListener('click', () => setView(false))
element('top-view').addEventListener('click', () => setView(true))
element('cutaway').addEventListener('click', () => {
  cutaway = !cutaway
  scenery.setCutaway(cutaway)
  element('cutaway').setAttribute('aria-pressed', String(cutaway))
})
const clearDialog = element<HTMLDialogElement>('clear-yard')
resetButton.addEventListener('click', () => clearDialog.showModal())
clearDialog.addEventListener('submit', (event) => {
  event.preventDefault()
  if ((event.submitter as HTMLButtonElement | null)?.value === 'confirm') {
    showLive()
    field.clearCoal()
    scene.updateCoalMesh()
    updateStatistics()
  }
  clearDialog.close()
})

function updateHover(event: PointerEvent): void {
  if (placingRadar) { updateRadarGhost(event); return }
  if (viewingSnapshot) { hover = null; from = null; scene.setBrush(null, brush.radius, brush.mode); return }
  const hit = scene.pick(event.clientX, event.clientY)
  hover = hit && isYardWorkArea(hit.x, hit.y) ? hit : null
  if (!hover) from = null
  scene.setBrush(hover, brush.radius, brush.mode)
}

function paint(time: number): void {
  if (pointerId === null) return
  const elapsed = Math.min(0.08, (time - lastPaintAt) / 1000)
  lastPaintAt = time
  if (hover) {
    const changed = applyBrushStroke(field, from ?? hover, hover, elapsed, brush)
    from = hover
    if (changed.length > 0) {
      scene.updateCoalMesh()
      if (time - lastStatsAt >= 100) {
        updateStatistics()
        lastStatsAt = time
      }
    }
  }
  frame = requestAnimationFrame(paint)
}

function endStroke(): void {
  if (pointerId === null) return
  if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
  pointerId = null
  from = null
  cancelAnimationFrame(frame)
  updateStatistics()
}

canvas.addEventListener('pointermove', (event) => {
  if (draggingRadar !== null) { updateRadarGhost(event); return }
  if (rightStart && Math.hypot(event.clientX - rightStart.x, event.clientY - rightStart.y) > 4) rightStart.moved = true

  if (event.isPrimary && (event.buttons === 0 || event.pointerId === pointerId)) updateHover(event)
})
canvas.addEventListener('pointerleave', () => {
  ghostPoint = null
  radarVisuals.showGhost(null)
  hover = null
  from = null
  scene.setBrush(null, brush.radius, brush.mode)
})
canvas.addEventListener('pointerdown', (event) => {
  if (viewingSnapshot && event.button === 0) return
  if (event.button === 2) {
    const object = scene.pickOverlay(event.clientX, event.clientY, radarVisuals.markers)
    rightStart = { x: event.clientX, y: event.clientY, id: object?.userData.radarId ?? null, moved: false }
  }
  if (event.button === 0 && !placingRadar) {
    const object = scene.pickOverlay(event.clientX, event.clientY, radarVisuals.markers)
    if (object) {
      movingRadar = radars.find(radar => radar.id === object.userData.radarId) ?? null
      if (movingRadar) {
        endStroke()
        selectedRadar = movingRadar
        draggingRadar = event.pointerId
        canvas.setPointerCapture(event.pointerId)
        updateRadarGhost(event)
        return
      }
    }
  }
  if (placingRadar && event.button === 0) {
    updateRadarGhost(event)
    commitRadarPlacement()
    return
  }
  if (event.button === 0) element('radar-properties').hidden = true

  if (!event.isPrimary) {
    endStroke()
    scene.setBrush(null, brush.radius, brush.mode)
    return
  }
  if (event.button !== 0 || pointerId !== null) return
  updateHover(event)
  if (!hover) return
  pointerId = event.pointerId
  canvas.setPointerCapture(pointerId)
  lastPaintAt = performance.now() - 16
  paint(performance.now())
})
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(eventName, (event) => {
    if ((event as PointerEvent).pointerId === pointerId) endStroke()
  })
}


function placementMode(): 'roof' | 'wall' {
  return movingRadar?.placement ?? copySource?.placement ?? element<HTMLSelectElement>('placement-mode').value as 'roof' | 'wall'
}
function showLive(): void {
  endStroke()
  hover = null
  from = null
  viewingSnapshot = false
  radarVisuals.setReferenceVisible(true)
  element('view-mode').textContent = '当前煤堆编辑 · 浅色范围为平地参考可达范围，不计煤堆遮挡'
  radarVisuals.update(radars, selectedRadar?.id)
  scene.setHeightField(field)
  radarVisuals.setPreview([])
  updateStatistics()
}
function setRadarPlacement(active: boolean): void {
  const wasPlacing = placingRadar
  endStroke()
  if (active) { showLive(); element('radar-properties').hidden = true }
  placingRadar = active
  ghostPoint = null
  radarVisuals.showGhost(null)
  scene.setBrush(null, brush.radius, brush.mode)
  element('add-radar').setAttribute('aria-pressed', String(active))
  element('add-radar').textContent = active ? '取消布设（Esc）' : '＋ 新增雷达'
  element('copy-radar').setAttribute('aria-pressed', String(active && copySource !== null))
  element('copy-radar').textContent = active && copySource ? '取消复制（Esc）' : '复制已有雷达'
  element<HTMLSelectElement>('placement-mode').disabled = active && copySource !== null
  element<HTMLSelectElement>('copy-radar-source').disabled = active && copySource !== null
  if (active) {
    if (placementMode() === 'roof') setView(true)
    element('radar-status').textContent = placementMode() === 'roof' ? '在圆场投影内左键选择屋顶位置，Esc 取消。' : '移动至墙顶内沿，左键放置；Esc 取消。'
    if (copySource) element('radar-status').textContent = `复制雷达 ${copySource.id} · 继承${placementMode() === 'wall' ? '墙顶吸附' : '屋顶投影'}模式，高度 ${copySource.height} m；左键选择新位置，Esc 取消。`
  } else {
    movingRadar = null
    copySource = null
    if (wasPlacing && !radarExportBusy) element('radar-status').textContent = `已布设 ${radars.length} 台雷达 · 拖动移动 / 右键设置${retainedBatch ? ' · 修改不改变已保留快照' : ''}`
  }
  canvas.style.cursor = active ? 'crosshair' : ''
}
function updateRadarGhost(event: PointerEvent): void {
  const mode = placementMode()
  const point = scene.pickPlane(event.clientX, event.clientY, draggingRadar !== null ? radarPosition(movingRadar!).z : mode === 'roof' ? 0 : WALL_HEIGHT)
  ghostPoint = null
  if (point) {
    const distance = Math.hypot(point.x, point.y)
    if (mode === 'roof' && distance <= YARD_RADIUS) ghostPoint = new Vector3(point.x, point.y, movingRadar?.height ?? copySource?.height ?? 45)
    if (mode === 'wall' && Math.abs(distance - YARD_RADIUS) <= 5) {
      const angle = Math.atan2(point.y, point.x)
      ghostPoint = new Vector3(Math.cos(angle) * YARD_RADIUS, Math.sin(angle) * YARD_RADIUS, movingRadar?.height ?? copySource?.height ?? WALL_HEIGHT)
    }
  }
  radarVisuals.showGhost(ghostPoint)
  scene.setBrush(null, brush.radius, brush.mode)
}
function commitRadarPlacement(): void {
  if (!ghostPoint) return
  if (movingRadar) {
    movingRadar.x = ghostPoint.x
    movingRadar.y = ghostPoint.y
    alignStation(movingRadar)
  } else if (copySource) {
    if (!radars.some(radar => radar.id === copySource!.id)) { setRadarPlacement(false); element('radar-status').textContent = '复制来源已删除，请重新选择。'; return }
    radars.push(copyRadarAt(copySource, nextRadarId, ghostPoint.x, ghostPoint.y))
    nextRadarId++
  } else radars.push(createRadar(nextRadarId++, ghostPoint.x, ghostPoint.y, placementMode()))
  const moved = movingRadar
  setRadarPlacement(false)
  refreshRadars()
  if (moved) openRadar(moved, canvas.getBoundingClientRect().left + 24, canvas.getBoundingClientRect().top + 70)
}
function refreshRadars(): void {
  radarVisuals.update(viewingSnapshot && retainedBatch ? retainedBatch.results.map(result => result.radar) : radars, selectedRadar?.id)
  for (const id of ['scan-radars', 'export-radars']) element<HTMLButtonElement>(id).disabled = radarExportBusy || (id === 'scan-radars' ? radars.length === 0 : !retainedBatch && radars.length === 0)
  if (!radarExportBusy) element('radar-status').textContent = `已布设 ${radars.length} 台雷达 · 拖动移动 / 右键设置${retainedBatch ? ' · 修改不改变已保留快照' : ''}`
  const sources = element<HTMLSelectElement>('copy-radar-source')
  const previous = sources.value
  sources.replaceChildren()
  if (!radars.length) sources.add(new Option('暂无可复制雷达', ''))
  for (const radar of radars) sources.add(new Option(`雷达 ${String(radar.id).padStart(3, '0')} · ${radar.placement === 'wall' ? '墙顶' : '屋顶'}`, String(radar.id)))
  if (radars.some(radar => String(radar.id) === previous)) sources.value = previous
  element<HTMLButtonElement>('copy-radar').disabled = radars.length === 0
  if (copySource && !radars.some(radar => radar.id === copySource!.id)) { setRadarPlacement(false); element('radar-status').textContent = '复制来源已删除，请重新选择。' }
  element('radar-list').replaceChildren(...radars.map(radar => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.radarId = String(radar.id)
    button.style.setProperty('--radar-color', radar.color)
    const p = radarPosition(radar)
    button.textContent = `雷达 ${String(radar.id).padStart(3, '0')} · ${radar.placement === 'wall' ? '墙顶' : '屋顶'} (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`
    button.addEventListener('click', () => openRadar(radar, canvas.getBoundingClientRect().left + 24, canvas.getBoundingClientRect().top + 70))
    return button
  }))
}
function openRadar(radar: RadarConfig, clientX: number, clientY: number): void {
  if (placingRadar) setRadarPlacement(false)
  if (viewingSnapshot) showLive()
  selectedRadar = radar
  element<HTMLSelectElement>('radar-scan-window').value = radar.spinSweep === 360 ? 'full' : 'forward'
  radarVisuals.update(radars, radar.id)
  const panel = element('radar-properties')
  const bounds = element('viewport').getBoundingClientRect()
  panel.hidden = false
  panel.style.left = `${Math.max(8, Math.min(bounds.width - panel.offsetWidth - 8, clientX - bounds.left + 12))}px`
  panel.style.top = `${Math.max(58, Math.min(bounds.height - panel.offsetHeight - 8, clientY - bounds.top + 12))}px`
  element('radar-title').textContent = `雷达 ${String(radar.id).padStart(3, '0')} · ${radar.placement === 'wall' ? '墙顶' : '屋顶'}`
  element('radar-validation').textContent = ''
  for (const key of ['beamCount', 'beamMin', 'beamMax'] as const) element<HTMLInputElement>(`radar-${key}`).value = String(radar[key])
  updateBeamSummary(radar)
  for (const [key] of propertyFields) {
    const input = element<HTMLInputElement>(`radar-${key}`)
    input.value = String(radar[key])
    input.readOnly = radar.placement === 'wall' && (key === 'x' || key === 'y')
    input.title = input.readOnly ? '墙顶坐标通过拖动标记或重新选择位置修改，保持内沿圆周约束。' : ''
  }
}

element('add-radar').addEventListener('click', () => setRadarPlacement(!placingRadar))
element('copy-radar').addEventListener('click', () => {
  if (placingRadar && copySource) { setRadarPlacement(false); return }
  const source = radars.find(radar => radar.id === Number(element<HTMLSelectElement>('copy-radar-source').value))
  if (!source) { setRadarPlacement(false); element('radar-status').textContent = '请先新增雷达并选择有效复制来源。'; return }
  setRadarPlacement(false)
  copySource = { ...source }
  element<HTMLSelectElement>('placement-mode').value = source.placement ?? 'roof'
  setRadarPlacement(true)
})
element('placement-mode').addEventListener('change', () => { if (placingRadar) setRadarPlacement(true) })
element('close-radar').addEventListener('click', () => { element('radar-properties').hidden = true })
element('move-radar').addEventListener('click', () => {
  if (!selectedRadar) return
  movingRadar = selectedRadar
  element('radar-properties').hidden = true
  setRadarPlacement(true)
})
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (draggingRadar !== null && canvas.hasPointerCapture(draggingRadar)) canvas.releasePointerCapture(draggingRadar)
    draggingRadar = null
    setRadarPlacement(false)
    element('radar-properties').hidden = true
  }
})
canvas.addEventListener('pointerup', event => {
  if (event.pointerId === draggingRadar) {
    updateRadarGhost(event)
    if (ghostPoint) commitRadarPlacement()
    else setRadarPlacement(false)
    draggingRadar = null
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }
  if (event.button !== 2 || !rightStart) return
  if (!rightStart.moved && rightStart.id !== null) {
    const radar = radars.find(r => r.id === rightStart!.id)
    if (radar) openRadar(radar, event.clientX, event.clientY)
  }
  rightStart = null
})
canvas.addEventListener('pointercancel', () => { draggingRadar = null; setRadarPlacement(false) })
for (const [key] of propertyFields) {
  const input = element<HTMLInputElement>(`radar-${key}`)
  input.addEventListener('input', () => {
    if (!selectedRadar) return
    if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) { element('radar-validation').textContent = '请输入范围内的有效数值。'; return }
    const candidate = { ...selectedRadar, [key]: input.valueAsNumber }
    alignStation(candidate)
    try {
      validateRadar(candidate)
      Object.assign(selectedRadar, candidate)
      element('radar-validation').textContent = ''
      refreshRadars()
    } catch (error) { element('radar-validation').textContent = (error as Error).message }
  })
  input.addEventListener('change', () => { if (selectedRadar) input.value = String(selectedRadar[key]) })
}
function updateBeamSummary(radar: RadarConfig): void {
  element('radar-beam-summary').textContent = `当前已应用：${radar.beamCount} 条激光线，原生垂直视场 ${radar.beamMin}°～${radar.beamMax}°。`
}
for (const key of ['beamCount', 'beamMin', 'beamMax']) element(`radar-${key}`).addEventListener('input', () => {
  element('radar-beam-summary').textContent = '线束编辑尚未应用；可任意顺序修改上下限，完成后点击“应用线束设置”。'
})
element('apply-radar-beams').addEventListener('click', () => {
  if (!selectedRadar) return
  const count = element<HTMLInputElement>('radar-beamCount')
  const lower = element<HTMLInputElement>('radar-beamMin')
  const upper = element<HTMLInputElement>('radar-beamMax')
  if (![count, lower, upper].every(input => input.validity.valid && Number.isFinite(input.valueAsNumber))) {
    element('radar-validation').textContent = '激光线数须为 1–256 的整数；原生垂直视场上下限须为 −90°～90° 的有限数值。'
    return
  }
  // 三个草稿值一次性验证并应用，避免先改一个端点时因临时交叉而丢失输入。
  const candidate = { ...selectedRadar, beamCount: count.valueAsNumber, beamMin: lower.valueAsNumber, beamMax: upper.valueAsNumber }
  try {
    validateRadar(candidate)
    Object.assign(selectedRadar, candidate)
    updateBeamSummary(selectedRadar)
    element('radar-validation').textContent = '已应用线束设置；参考范围已更新，保留的扫描快照不变。'
    refreshRadars()
  } catch (error) { element('radar-validation').textContent = (error as Error).message }
})
element('radar-scan-window').addEventListener('change', () => {
  if (!selectedRadar) return
  const full = element<HTMLSelectElement>('radar-scan-window').value === 'full'
  selectedRadar.spinStart = full ? 0 : 270
  selectedRadar.spinSweep = full ? 360 : 90
  refreshRadars()
})
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-range-preset]')) button.addEventListener('click', () => {
  if (!selectedRadar) return
  selectedRadar.maxRange = Number(button.dataset.rangePreset)
  element<HTMLInputElement>('radar-maxRange').value = String(selectedRadar.maxRange)
  refreshRadars()
})
element('delete-radar').addEventListener('click', () => {
  if (!selectedRadar) return
  radars.splice(radars.indexOf(selectedRadar), 1)
  selectedRadar = null
  element('radar-properties').hidden = true
  refreshRadars()
})
element('roof-presets').addEventListener('click', () => {
  setRadarPlacement(false)
  showLive()
  for (let i = 0; i < 4; i++) radars.push(createRadar(nextRadarId++, 30 * Math.cos(i * Math.PI / 2), 30 * Math.sin(i * Math.PI / 2)))
  setView(true)
  refreshRadars()
})
element('show-live').addEventListener('click', showLive)

function exportCoal(points: ReturnType<typeof completeCoalSurface>, name: string, snapshotId?: string): void {
  if (points.length === 0) { element('radar-status').textContent = '当前没有煤堆，请先堆料后导出完整煤面。'; return }
  downloadBlob(new Blob([pointsToPly(points, undefined, snapshotId).buffer], { type: 'application/octet-stream' }), name)
  element('radar-status').textContent = `已导出${snapshotId ? `快照 ${snapshotId}` : '当前'}完整煤面：${points.length.toLocaleString()} 点`
}
element('export-coal').addEventListener('click', () => { endStroke(); exportCoal(completeCoalSurface(snapshotField(field)), 'coal_surface_current.ply') })
element('export-snapshot-coal').addEventListener('click', () => {
  if (retainedBatch) exportCoal(completeCoalSurface(retainedBatch.field), `coal_surface_${retainedBatch.id}.ply`, retainedBatch.id)
})
async function generateBatch(): Promise<boolean> {
  if (radarExportBusy || radars.length === 0) return false
  const input = element<HTMLInputElement>('dedup-tolerance')
  if (!input.validity.valid || !Number.isFinite(input.valueAsNumber)) { element('radar-status').textContent = '请输入有效去重容差。'; return false }
  endStroke()
  radarExportBusy = true
  scanAbort = new AbortController()
  element('cancel-scan').hidden = false
  element('scan-radars').textContent = '正在计算累计射线…'
  refreshRadars()
  try {
    retainedBatch = await runScanBatch(field, radars, input.valueAsNumber, { signal: scanAbort.signal, progress: progress => {
      element<HTMLProgressElement>('scan-progress').value = progress.total ? progress.completed / progress.total : 1
      element('radar-status').textContent = `雷达 ${progress.radarId} · ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()} 条射线 · ${progress.retained.toLocaleString()} 点`
    } })
    updateBatchUI()
    return true
  } catch (error) {
    element('radar-status').textContent = error instanceof Error ? error.message : '扫描失败'
    return false
  } finally {
    radarExportBusy = false
    scanAbort = null
    element('cancel-scan').hidden = true
    element('scan-radars').textContent = '重新生成累计扫描快照'
    for (const id of ['scan-radars', 'export-radars']) element<HTMLButtonElement>(id).disabled = id === 'scan-radars' ? radars.length === 0 : !retainedBatch && radars.length === 0
  }
}
element('cancel-scan').addEventListener('click', () => scanAbort?.abort())
element('scan-radars').addEventListener('click', () => { void generateBatch() })
element('export-radars').addEventListener('click', async () => {
  if (radarExportBusy) return
  if (!retainedBatch && !await generateBatch()) return
  if (!retainedBatch) return
  const files = scanResultFiles(retainedBatch)
  downloadBlob(createStoredZip(files), `radar_${retainedBatch.id}.zip`)
  element('radar-status').textContent = `快照 ${retainedBatch.id}：${retainedBatch.results.length} 台 × 2 组，共 ${files.length} 个 PLY（含成对空扫描）`
})
function updateBatchUI(): void {
  if (!retainedBatch) return
  const batch = retainedBatch
  element('snapshot-info').textContent = `${batch.id}\n${batch.createdAt} · 去重 ${batch.tolerance} m\n${batch.results.map(result => `雷达 ${result.radar.id}：${result.points.length.toLocaleString()} 点 / ${result.rawHits.toLocaleString()} 煤面首击 / ${result.candidates.toLocaleString()} 射线；${result.radar.beamCount} 条激光线，原生垂直视场 ${result.radar.beamMin}°～${result.radar.beamMax}°`).join('\n')}\n参数已冻结；现场编辑不会改变本批结果。`
  element<HTMLButtonElement>('export-snapshot-coal').disabled = false
  for (const id of ['preview-radar', 'overlap-a', 'overlap-b']) {
    const select = element<HTMLSelectElement>(id)
    select.replaceChildren()
    if (id === 'preview-radar') select.add(new Option('全部雷达', ''))
    for (const result of batch.results) select.add(new Option(`雷达 ${result.radar.id} · ${result.points.length} 点`, String(result.radar.id)))
    if (id === 'overlap-b' && batch.results.length > 1) select.selectedIndex = 1
  }
  element('overlap-result').textContent = '选择两台雷达并计算双向重叠。'
  element('overlap-graph').textContent = ''
  element('station-reference').textContent = ''
  previewBatch()
}
function previewBatch(): void {
  if (!retainedBatch) return
  endStroke()
  hover = null
  from = null
  scene.setBrush(null, brush.radius, brush.mode)
  viewingSnapshot = true
  radarVisuals.setReferenceVisible(false)
  element('view-mode').textContent = `正在查看冻结快照 ${retainedBatch.id}（编辑请返回当前煤堆）`
  radarVisuals.update(retainedBatch.results.map(result => result.radar))
  scene.setHeightField(retainedBatch.field)
  const selected = element<HTMLSelectElement>('preview-radar').value
  radarVisuals.setPreview(retainedBatch.results.filter(result => !selected || result.radar.id === Number(selected)).map(result => ({ points: result.points, color: result.radar.color })))
  updateStatistics()
}
element('preview-radar').addEventListener('change', previewBatch)
function selectedPair() {
  if (!retainedBatch) return null
  const a = retainedBatch.results.find(result => result.radar.id === Number(element<HTMLSelectElement>('overlap-a').value))
  const b = retainedBatch.results.find(result => result.radar.id === Number(element<HTMLSelectElement>('overlap-b').value))
  const input = element<HTMLInputElement>('overlap-threshold')
  if (!a || !b || a === b || !input.validity.valid || !Number.isFinite(input.valueAsNumber)) { element('overlap-result').textContent = '请选择不同雷达和有效距离阈值。'; return null }
  return { a, b, threshold: input.valueAsNumber }
}
element('analyze-overlap').addEventListener('click', () => {
  const pair = selectedPair()
  if (!pair) return
  const { a, b, threshold } = pair
  const overlap = overlapPoints(a.points, b.points, threshold)
  const ratioLabel = (matched: number, total: number, ratio: number) => total ? `${matched}/${total} = ${(ratio * 100).toFixed(2)}%` : '0/0（无有效点）'
  element('overlap-result').textContent = `快照 ${retainedBatch!.id}\n阈值 ${threshold} m；点到点最近邻\nA(${a.radar.id})→B(${b.radar.id})：${ratioLabel(overlap.matchedA, overlap.countA, overlap.ratioA)}\nB→A：${ratioLabel(overlap.matchedB, overlap.countB, overlap.ratioB)}\nA / B 采样：旋转 ${a.radar.spinStep}° / ${b.radar.spinStep}°，云台 ${a.radar.gimbalStep}° / ${b.radar.gimbalStep}°，激光线数 ${a.radar.beamCount} / ${b.radar.beamCount}，原生垂直视场 ${a.radar.beamMin}°～${a.radar.beamMax}° / ${b.radar.beamMin}°～${b.radar.beamMax}°`
  const transform = stationTransform(b.radar, a.radar)
  element('station-reference').textContent = `已知固定站位变换 B→A\n绕 Z 旋转 ${transform.yaw.toFixed(4)}°\n平移 (${transform.translation.x.toFixed(4)}, ${transform.translation.y.toFixed(4)}, ${transform.translation.z.toFixed(4)}) m\np_A = Rz(角度) · p_B + 平移`
  endStroke()
  hover = null
  from = null
  scene.setBrush(null, brush.radius, brush.mode)
  viewingSnapshot = true
  radarVisuals.setReferenceVisible(false)
  element('view-mode').textContent = `正在查看冻结快照 ${retainedBatch!.id} 的共同可见点`
  radarVisuals.update(retainedBatch!.results.map(result => result.radar))
  scene.setHeightField(retainedBatch!.field)
  radarVisuals.setPreview([{ points: overlap.commonA, color: a.radar.color }, { points: overlap.commonB, color: b.radar.color }])
  updateStatistics()
})
element('compare-registration').addEventListener('click', () => {
  const pair = selectedPair()
  if (!pair) return
  const values = ['yaw', 'x', 'y', 'z'].map(key => element<HTMLInputElement>(`estimate-${key}`).valueAsNumber)
  if (!values.every(Number.isFinite)) return
  const error = registrationError(pair.b.radar, pair.a.radar, { yaw: values[0], translation: { x: values[1], y: values[2], z: values[3] } })
  element('registration-error').textContent = `B→A 旋转误差 ${error.rotationDeg.toFixed(4)}°；平移误差 ${error.translationMeters.toFixed(4)} m`
})
element('overlap-graph-button').addEventListener('click', async () => {
  if (!retainedBatch) return
  const batch = retainedBatch
  const threshold = element<HTMLInputElement>('overlap-threshold').valueAsNumber
  if (!Number.isFinite(threshold) || threshold < 0) return
  const graph = new Map<number, number[]>(batch.results.map(result => [result.radar.id, []]))
  const lines: string[] = []
  for (let i = 0; i < batch.results.length; i++) for (let j = i + 1; j < batch.results.length; j++) {
    const a = batch.results[i], b = batch.results[j]
    const overlap = overlapPoints(a.points, b.points, threshold)
    if (overlap.matchedA && overlap.matchedB) { graph.get(a.radar.id)!.push(b.radar.id); graph.get(b.radar.id)!.push(a.radar.id) }
    lines.push(`${a.radar.id} ↔ ${b.radar.id}：${(overlap.ratioA * 100).toFixed(1)}% / ${(overlap.ratioB * 100).toFixed(1)}%`)
    element('overlap-graph').textContent = `阈值 ${threshold} m，至少一个双向匹配即连边\n${lines.join('\n')}`
    await new Promise(resolve => setTimeout(resolve, 0))
    if (retainedBatch !== batch) return
  }
  const seen = new Set<number>()
  const visit = (id: number) => { if (seen.has(id)) return; seen.add(id); for (const next of graph.get(id)!) visit(next) }
  if (batch.results.length) visit(batch.results[0].radar.id)
  element('overlap-graph').textContent += `\n${seen.size === batch.results.length ? '所有站位形成连通链' : '站位图不连通（含空扫描的孤立站）'}。无工程通过门槛。`
})
