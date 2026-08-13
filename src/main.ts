import './style.css'
import type { BrushSettings, PointCloudData, RadarConfig, RadarPoint, ToolMode } from './types'
import { loadPlyFromUrl, parsePly } from './io/PlyImporter'
import { appendPointsToSourcePly, radarPointsToCsv, downloadBlob } from './io/PointCloudExporter'
import { buildGroundGrid } from './simulation/GroundGridBuilder'
import { applyBrushStroke } from './simulation/BrushEngine'
import { calculateCoalStatistics } from './simulation/VolumeCalculator'
import { generateRadarPointCloud } from './simulation/RadarStylePointCloud'
import { HeightField } from './simulation/HeightField'
import { SceneController } from './scene/SceneController'

const app = document.querySelector<HTMLDivElement>('#app')!

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>
        <div><b>CoalForm</b><span>三维煤场仿真台</span></div>
      </div>
      <div class="scene-status"><span class="status-dot"></span><span id="scene-status">正在准备场景</span></div>
      <div class="topbar-help"><kbd>中键</kbd> 平移 <kbd>右键</kbd> 旋转 <kbd>滚轮</kbd> 缩放</div>
    </header>

    <aside class="sidebar">
      <div class="sidebar-tabs" role="tablist">
        <button class="tab is-active" data-tab="edit" type="button">堆场编辑</button>
        <button class="tab" data-tab="radar" type="button">雷达仿真</button>
      </div>

      <div class="panel-scroll">
        <section class="tab-panel is-active" data-panel="edit">
          <div class="section upload-section">
            <div class="section-heading"><span>01</span><div><h2>场地模板</h2><p>只读点云 · PLY</p></div></div>
            <label class="upload-zone" id="upload-zone">
              <input id="file-input" type="file" accept=".ply" hidden>
              <span class="upload-icon">↥</span>
              <span><b>导入 PLY 点云</b><small>点击选择或拖放文件到这里</small></span>
            </label>
            <div class="file-card" id="file-card">
              <span class="file-glyph">PLY</span>
              <span><b id="file-name">尚未载入</b><small id="file-meta">等待点云文件</small></span>
              <button id="reload-sample" class="icon-button" type="button" title="载入内置样例">↻</button>
            </div>
          </div>

          <div class="section">
            <div class="section-heading"><span>02</span><div><h2>作业工具</h2><p>左键按住并拖动</p></div></div>
            <div class="tool-switch">
              <button class="tool-button is-active" data-tool="deposit" type="button"><span class="tool-symbol">＋</span><span><b>倒入煤堆</b><small>增加煤层</small></span></button>
              <button class="tool-button" data-tool="excavate" type="button"><span class="tool-symbol excavate">−</span><span><b>斗轮挖取</b><small>移除煤层</small></span></button>
            </div>
            <div class="control-list">
              <label class="range-control"><span>笔刷半径 <output id="radius-output">3.0 m</output></span><input id="radius" type="range" min="0.8" max="12" step="0.1" value="3"></label>
              <label class="range-control"><span>作业强度 <output id="strength-output">2.0 m/s</output></span><input id="strength" type="range" min="0.2" max="8" step="0.1" value="2"></label>
              <label class="range-control"><span>边缘柔和 <output id="falloff-output">65%</output></span><input id="falloff" type="range" min="0" max="1" step="0.01" value="0.65"></label>
              <label class="range-control"><span>自然坡面 <output id="relaxation-output">35%</output></span><input id="relaxation" type="range" min="0" max="1" step="0.01" value="0.35"></label>
            </div>
            <div class="inline-fields">
              <label><span>最大堆高</span><div><input id="max-height" type="number" min="0.5" max="80" step="0.5" value="18"><em>m</em></div></label>
              <label><span>堆积密度</span><div><input id="density" type="number" min="0.1" max="5" step="0.05" value="0.85"><em>t/m³</em></div></label>
            </div>
            <button class="danger-button" id="clear-coal" type="button"><span>⌫</span> 清空动态煤堆</button>
          </div>
        </section>

        <section class="tab-panel" data-panel="radar">
          <div class="section">
            <div class="section-heading"><span>01</span><div><h2>虚拟雷达</h2><p>局部坐标 · 米</p></div></div>
            <div class="coordinate-grid">
              <label><span>X</span><input id="radar-x" type="number" step="0.5" value="0"></label>
              <label><span>Y</span><input id="radar-y" type="number" step="0.5" value="0"></label>
              <label><span>Z</span><input id="radar-z" type="number" step="0.5" value="8"></label>
            </div>
            <div class="inline-fields">
              <label><span>水平朝向</span><div><input id="radar-yaw" type="number" min="-180" max="180" step="1" value="0"><em>°</em></div></label>
              <label><span>俯仰角</span><div><input id="radar-pitch" type="number" min="-89" max="89" step="1" value="-12"><em>°</em></div></label>
            </div>
          </div>

          <div class="section">
            <div class="section-heading"><span>02</span><div><h2>扫描参数</h2><p>视场、量程与测量噪声</p></div></div>
            <div class="inline-fields">
              <label><span>水平视场</span><div><input id="radar-hfov" type="number" min="1" max="180" value="100"><em>°</em></div></label>
              <label><span>垂直视场</span><div><input id="radar-vfov" type="number" min="1" max="120" value="60"><em>°</em></div></label>
              <label><span>最近量程</span><div><input id="radar-min-range" type="number" min="0" step="0.5" value="1"><em>m</em></div></label>
              <label><span>最远量程</span><div><input id="radar-max-range" type="number" min="1" step="1" value="120"><em>m</em></div></label>
            </div>
            <label class="range-control"><span>采样点数 <output id="sample-count-output">10,000</output></span><input id="sample-count" type="range" min="500" max="30000" step="500" value="10000"></label>
            <label class="range-control"><span>距离噪声 σ <output id="noise-output">0.030 m</output></span><input id="noise" type="range" min="0" max="0.3" step="0.005" value="0.03"></label>
            <label class="range-control"><span>随机漏检 <output id="dropout-output">8%</output></span><input id="dropout" type="range" min="0" max="0.8" step="0.01" value="0.08"></label>
            <label class="range-control"><span>离群点比例 <output id="outlier-output">1%</output></span><input id="outlier" type="range" min="0" max="0.2" step="0.005" value="0.01"></label>
          </div>

          <div class="section export-section">
            <button class="primary-button" id="generate-radar" type="button"><span>⌁</span> 生成并预览点云</button>
            <div class="radar-result" id="radar-result"><span>扫描结果</span><b>尚未生成</b></div>
            <div class="export-buttons">
              <button id="export-ply" type="button">导出合并 PLY</button>
              <button id="export-csv" type="button">导出 CSV</button>
            </div>
            <p class="method-note"><i>i</i> PLY 会保留原文件格式与顶点属性并追加煤堆点；CSV 为雷达测量明细。</p>
          </div>
        </section>
      </div>
    </aside>

    <main class="viewport" id="viewport">
      <div class="loading-overlay" id="loading-overlay"><span class="spinner"></span><b>正在载入煤场点云</b><small>解析 PLY 并构建地面高度网格…</small></div>
      <div class="viewport-badge"><span></span> LOCAL COORDINATE / Z-UP</div>
      <div class="compass" aria-hidden="true"><span>N</span><i></i></div>
      <div class="stats-panel">
        <div><span>煤堆体积</span><b id="stat-volume">0.0</b><em>m³</em></div>
        <div><span>估算质量</span><b id="stat-mass">0.0</b><em>t</em></div>
        <div><span>最大堆高</span><b id="stat-height">0.00</b><em>m</em></div>
      </div>
      <div class="tool-hud" id="tool-hud"><span>＋</span><div><small>当前工具</small><b>倒入煤堆</b></div><i></i><em>半径 3.0 m</em></div>
      <div class="axis-widget" aria-hidden="true"><i class="axis-z">Z</i><i class="axis-y">Y</i><i class="axis-x">X</i></div>
    </main>
  </div>
  <dialog id="clear-dialog">
    <form method="dialog">
      <div class="dialog-icon">!</div><h2>清空所有动态煤堆？</h2>
      <p>固定场地点云不会受影响，但当前煤层编辑无法恢复。</p>
      <div><button value="cancel">取消</button><button value="confirm" class="confirm-clear">确认清空</button></div>
    </form>
  </dialog>
  <div class="toast" id="toast"></div>
`

const scene = new SceneController(element('viewport'))
let field: HeightField | null = null
let sourcePointCloud: PointCloudData | null = null
let radarPoints: RadarPoint[] = []
let density = 0.85
let painting = false
let hoverPoint: { x: number; y: number; z: number } | null = null
let lastPaintPoint: { x: number; y: number } | null = null
let lastPaintTime = 0
let statsUpdateTime = 0

const brush: BrushSettings = {
  mode: 'deposit', radius: 3, strength: 2, falloff: 0.65, maxHeight: 18, relaxation: 0.35,
}

const radar: RadarConfig = {
  position: [0, 0, 8], yawDeg: 0, pitchDeg: -12,
  horizontalFovDeg: 100, verticalFovDeg: 60,
  minRange: 1, maxRange: 120, sampleCount: 10_000,
  rangeNoiseSigma: 0.03, dropoutRate: 0.08, outlierRate: 0.01,
}

setupTabs()
setupBrushControls()
setupFileImport()
setupRadarControls()
setupPointerEditing()
setupClearDialog()
requestAnimationFrame(paintLoop)
void loadBundledSample()

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function setupTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-tab], [data-panel]').forEach((node) => node.classList.remove('is-active'))
      button.classList.add('is-active')
      document.querySelector(`[data-panel="${button.dataset.tab}"]`)?.classList.add('is-active')
      scene.setRadarVisible(button.dataset.tab === 'radar')
    })
  })
  scene.setRadarVisible(false)
}

function setupBrushControls(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      brush.mode = button.dataset.tool as ToolMode
      document.querySelectorAll('[data-tool]').forEach((node) => node.classList.toggle('is-active', node === button))
      updateToolHud()
      if (hoverPoint) scene.setBrush(vectorLike(hoverPoint), brush.radius, brush.mode)
    })
  })
  bindRange('radius', (value) => { brush.radius = value; updateToolHud() }, (value) => `${value.toFixed(1)} m`)
  bindRange('strength', (value) => { brush.strength = value }, (value) => `${value.toFixed(1)} m/s`)
  bindRange('falloff', (value) => { brush.falloff = value }, percent)
  bindRange('relaxation', (value) => { brush.relaxation = value }, percent)
  element<HTMLInputElement>('max-height').addEventListener('change', (event) => {
    brush.maxHeight = Math.max(0.1, Number((event.target as HTMLInputElement).value))
  })
  element<HTMLInputElement>('density').addEventListener('input', (event) => {
    density = Math.max(0, Number((event.target as HTMLInputElement).value))
    updateStatistics()
  })
}

function setupFileImport(): void {
  const input = element<HTMLInputElement>('file-input')
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void loadUserFile(file)
    input.value = ''
  })
  const zone = element('upload-zone')
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.add('is-dragging') })
  }
  for (const eventName of ['dragleave', 'drop']) {
    zone.addEventListener(eventName, (event) => { event.preventDefault(); zone.classList.remove('is-dragging') })
  }
  zone.addEventListener('drop', (event) => {
    const file = (event as DragEvent).dataTransfer?.files[0]
    if (!file || !file.name.toLowerCase().endsWith('.ply')) return showToast('请选择 .ply 点云文件', true)
    void loadUserFile(file)
  })
  element('reload-sample').addEventListener('click', () => void loadBundledSample())
}

function setupRadarControls(): void {
  bindNumeric('radar-x', (value) => { radar.position[0] = value })
  bindNumeric('radar-y', (value) => { radar.position[1] = value })
  bindNumeric('radar-z', (value) => { radar.position[2] = value })
  bindNumeric('radar-yaw', (value) => { radar.yawDeg = value })
  bindNumeric('radar-pitch', (value) => { radar.pitchDeg = value })
  bindNumeric('radar-hfov', (value) => { radar.horizontalFovDeg = value })
  bindNumeric('radar-vfov', (value) => { radar.verticalFovDeg = value })
  bindNumeric('radar-min-range', (value) => { radar.minRange = value })
  bindNumeric('radar-max-range', (value) => { radar.maxRange = value })
  bindRange('sample-count', (value) => { radar.sampleCount = Math.round(value) }, (value) => Math.round(value).toLocaleString())
  bindRange('noise', (value) => { radar.rangeNoiseSigma = value }, (value) => `${value.toFixed(3)} m`)
  bindRange('dropout', (value) => { radar.dropoutRate = value }, percent)
  bindRange('outlier', (value) => { radar.outlierRate = value }, percent)
  element('generate-radar').addEventListener('click', generateRadar)
  element('export-ply').addEventListener('click', () => exportRadar('ply'))
  element('export-csv').addEventListener('click', () => exportRadar('csv'))
}

function setupPointerEditing(): void {
  const canvas = scene.canvas
  canvas.addEventListener('pointermove', (event) => {
    const hit = scene.pick(event.clientX, event.clientY)
    hoverPoint = hit ? { x: hit.x, y: hit.y, z: hit.z } : null
    scene.setBrush(hit, brush.radius, brush.mode)
  })
  canvas.addEventListener('pointerleave', () => {
    if (!painting) {
      hoverPoint = null
      scene.setBrush(null, brush.radius, brush.mode)
    }
  })
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !field) return
    const hit = scene.pick(event.clientX, event.clientY)
    if (!hit) return
    event.preventDefault()
    canvas.setPointerCapture(event.pointerId)
    painting = true
    hoverPoint = { x: hit.x, y: hit.y, z: hit.z }
    lastPaintPoint = { x: hit.x, y: hit.y }
    lastPaintTime = performance.now() - 20
  })
  const stop = () => {
    if (painting) updateStatistics()
    painting = false
    lastPaintPoint = null
  }
  canvas.addEventListener('pointerup', stop)
  canvas.addEventListener('pointercancel', stop)
  canvas.addEventListener('wheel', (event) => {
    if (!event.shiftKey && !event.ctrlKey) return
    event.preventDefault()
    if (event.shiftKey) {
      brush.radius = clamp(brush.radius + Math.sign(event.deltaY) * -0.35, 0.8, 12)
      syncRange('radius', brush.radius)
    } else {
      brush.strength = clamp(brush.strength + Math.sign(event.deltaY) * -0.2, 0.2, 8)
      syncRange('strength', brush.strength)
    }
    updateToolHud()
  }, { passive: false })
}

function setupClearDialog(): void {
  const dialog = element<HTMLDialogElement>('clear-dialog')
  element('clear-coal').addEventListener('click', () => {
    if (!field || calculateCoalStatistics(field, density).activeCells === 0) return showToast('当前没有可清空的动态煤堆')
    dialog.showModal()
  })
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'confirm' || !field) return
    field.clearCoal()
    radarPoints = []
    scene.updateCoalMesh()
    scene.setRadarVisualization(radar, [])
    updateStatistics()
    updateRadarResult()
    showToast('动态煤堆已清空，场地点云保持不变')
  })
}

async function loadBundledSample(): Promise<void> {
  setLoading(true, '正在载入内置煤场点云')
  try {
    const sampleUrl = new URL('../前端过滤后的煤场点云_20260811_153504.ply', import.meta.url).href
    await acceptPointCloud(await loadPlyFromUrl(sampleUrl, '前端过滤后的煤场点云_20260811_153504.ply'))
  } catch (error) {
    handleError(error)
  } finally {
    setLoading(false)
  }
}

async function loadUserFile(file: File): Promise<void> {
  setLoading(true, `正在解析 ${file.name}`)
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    await acceptPointCloud(parsePly(await file.arrayBuffer(), file.name))
  } catch (error) {
    handleError(error)
  } finally {
    setLoading(false)
  }
}

async function acceptPointCloud(data: PointCloudData): Promise<void> {
  element('scene-status').textContent = '正在构建地面高度网格'
  await new Promise((resolve) => setTimeout(resolve, 20))
  const result = buildGroundGrid(data.positions, 0.5)
  field = result.field
  sourcePointCloud = data
  radarPoints = []
  scene.setPointCloud(data)
  scene.setHeightField(field)
  scene.fitToField(field)
  const width = (field.cols - 1) * field.cellSize
  const height = (field.rows - 1) * field.cellSize
  radar.position = [Math.max(0, field.originX - 4), field.originY + height / 2, Math.max(6, width * 0.08)]
  radar.yawDeg = 0
  radar.maxRange = Math.ceil(Math.hypot(width, height) * 1.25)
  syncRadarFields()
  scene.setRadarVisualization(radar, [])
  element('file-name').textContent = data.sourceName
  element('file-meta').textContent = `${data.pointCount.toLocaleString()} 点 · ${width.toFixed(1)} × ${height.toFixed(1)} m · 网格 ${field.cols} × ${field.rows}`
  element('scene-status').textContent = `场景就绪 · ${result.effectiveCellSize.toFixed(2)} m 网格`
  updateStatistics()
  updateRadarResult()
  showToast(`已载入 ${data.pointCount.toLocaleString()} 个场地点`)
}

function paintLoop(time: number): void {
  requestAnimationFrame(paintLoop)
  if (!painting || !hoverPoint || !lastPaintPoint || !field) return
  const current = { x: hoverPoint.x, y: hoverPoint.y }
  const deltaSeconds = Math.min(0.08, Math.max(0.008, (time - lastPaintTime) / 1000))
  applyBrushStroke(field, lastPaintPoint, current, deltaSeconds, brush)
  lastPaintPoint = current
  lastPaintTime = time
  radarPoints = []
  scene.updateCoalMesh()
  if (time - statsUpdateTime > 100) {
    updateStatistics()
    statsUpdateTime = time
  }
}

function generateRadar(): void {
  if (!field) return showToast('请先载入场地点云', true)
  const stats = calculateCoalStatistics(field, density)
  if (stats.activeCells === 0) return showToast('请先使用倒煤工具创建煤堆', true)
  const button = element<HTMLButtonElement>('generate-radar')
  button.disabled = true
  button.innerHTML = '<span class="mini-spinner"></span> 正在扫描…'
  setTimeout(() => {
    radarPoints = generateRadarPointCloud(field!, radar)
    scene.setRadarVisualization(radar, radarPoints)
    scene.setRadarVisible(true)
    updateRadarResult()
    button.disabled = false
    button.innerHTML = '<span>⌁</span> 重新生成点云'
    if (radarPoints.length === 0) showToast('当前视场未扫描到煤堆，请调整位置或朝向', true)
    else showToast(`雷达点云已生成：${radarPoints.length.toLocaleString()} 点`)
  }, 30)
}

function exportRadar(format: 'ply' | 'csv'): void {
  if (radarPoints.length === 0) return showToast('请先生成雷达点云', true)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  if (format === 'ply') {
    if (!sourcePointCloud) return showToast('原始 PLY 数据不可用', true)
    const blob = appendPointsToSourcePly(sourcePointCloud, radarPoints)
    downloadBlob(blob, `coalfield_merged_${timestamp}.ply`)
    showToast(`已导出合并 PLY：${(sourcePointCloud.pointCount + radarPoints.length).toLocaleString()} 点`)
    return
  }
  downloadBlob(radarPointsToCsv(radarPoints), `radar_coal_${timestamp}.csv`)
  showToast('已导出雷达测量 CSV')
}

function updateStatistics(): void {
  if (!field) return
  const stats = calculateCoalStatistics(field, density)
  element('stat-volume').textContent = stats.volume.toLocaleString(undefined, { maximumFractionDigits: 1 })
  element('stat-mass').textContent = stats.mass.toLocaleString(undefined, { maximumFractionDigits: 1 })
  element('stat-height').textContent = stats.maxHeight.toFixed(2)
}

function updateRadarResult(): void {
  const result = element('radar-result')
  result.innerHTML = radarPoints.length
    ? `<span>扫描结果</span><b>${radarPoints.length.toLocaleString()} 点</b>`
    : '<span>扫描结果</span><b>尚未生成</b>'
}

function updateToolHud(): void {
  const hud = element('tool-hud')
  const depositing = brush.mode === 'deposit'
  hud.classList.toggle('is-excavate', !depositing)
  hud.querySelector('span')!.textContent = depositing ? '＋' : '−'
  hud.querySelector('b')!.textContent = depositing ? '倒入煤堆' : '斗轮挖取'
  hud.querySelector('em')!.textContent = `半径 ${brush.radius.toFixed(1)} m`
  if (hoverPoint) scene.setBrush(vectorLike(hoverPoint), brush.radius, brush.mode)
}

function bindRange(id: string, apply: (value: number) => void, format: (value: number) => string): void {
  const input = element<HTMLInputElement>(id)
  const output = element<HTMLOutputElement>(`${id}-output`)
  const update = () => {
    const value = Number(input.value)
    apply(value)
    output.textContent = format(value)
    const ratio = (value - Number(input.min)) / (Number(input.max) - Number(input.min))
    input.style.setProperty('--range-progress', `${ratio * 100}%`)
  }
  input.addEventListener('input', update)
  update()
}

function bindNumeric(id: string, apply: (value: number) => void): void {
  element<HTMLInputElement>(id).addEventListener('input', (event) => apply(Number((event.target as HTMLInputElement).value)))
}

function syncRange(id: string, value: number): void {
  const input = element<HTMLInputElement>(id)
  input.value = String(value)
  input.dispatchEvent(new Event('input'))
}

function syncRadarFields(): void {
  const values: Record<string, number> = {
    'radar-x': radar.position[0], 'radar-y': radar.position[1], 'radar-z': radar.position[2],
    'radar-yaw': radar.yawDeg, 'radar-pitch': radar.pitchDeg,
    'radar-max-range': radar.maxRange,
  }
  for (const [id, value] of Object.entries(values)) element<HTMLInputElement>(id).value = value.toFixed(value % 1 === 0 ? 0 : 1)
}

function setLoading(loading: boolean, title = ''): void {
  const overlay = element('loading-overlay')
  overlay.classList.toggle('is-visible', loading)
  if (title) overlay.querySelector('b')!.textContent = title
}

function showToast(message: string, isError = false): void {
  const toast = element('toast')
  toast.textContent = message
  toast.classList.toggle('is-error', isError)
  toast.classList.add('is-visible')
  window.setTimeout(() => toast.classList.remove('is-visible'), 2_600)
}

function handleError(error: unknown): void {
  console.error(error)
  element('scene-status').textContent = '载入失败'
  showToast(error instanceof Error ? error.message : '发生未知错误', true)
}

function vectorLike(point: { x: number; y: number; z: number }) {
  return { x: point.x, y: point.y, z: point.z } as import('three').Vector3
}

function percent(value: number): string { return `${Math.round(value * 100)}%` }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)) }

window.addEventListener('beforeunload', () => scene.dispose())
