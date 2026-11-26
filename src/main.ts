import './style.css'
import type { BrushSettings, GridReplacementResult, PointCloudData, ToolMode } from './types'
import { parsePly } from './io/PlyImporter'
import { downloadBlob, replaceCoveredPointsInSourcePly } from './io/PointCloudExporter'
import { buildGroundGrid } from './simulation/GroundGridBuilder'
import { applyBrushStroke } from './simulation/BrushEngine'
import { calculateCoalStatistics } from './simulation/VolumeCalculator'
import { buildGridAlignedReplacements } from './simulation/GridAlignedPointCloud'
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
      <div class="workspace-header">
        <a class="workspace-link" href="./circular-yard.html">圆形料场 <span aria-hidden="true">↗</span></a>
        <div class="scene-status"><span class="status-dot"></span><span id="scene-status">等待导入点云</span></div>
      </div>
      <div class="topbar-help"><kbd>中键</kbd> 平移 <kbd>右键</kbd> 旋转 <kbd>滚轮</kbd> 缩放</div>
    </header>

    <aside class="sidebar">
      <div class="sidebar-tabs" role="tablist">
        <button class="tab is-active" data-tab="edit" type="button">堆场编辑</button>
        <button class="tab" data-tab="export" type="button">点云生成</button>
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
              <label class="range-control"><span>安息角 <output id="repose-angle-output">37°</output></span><input id="repose-angle" type="range" min="25" max="45" step="1" value="37"></label>
              <label class="range-control"><span>塌落强度 <output id="relaxation-output">35%</output></span><input id="relaxation" type="range" min="0" max="1" step="0.01" value="0.35"></label>
            </div>
            <div class="inline-fields">
              <label><span>最大堆高</span><div><input id="max-height" type="number" min="0.5" max="80" step="0.5" value="18"><em>m</em></div></label>
              <label><span>堆积密度</span><div><input id="density" type="number" min="0.1" max="5" step="0.05" value="0.85"><em>t/m³</em></div></label>
            </div>
            <button class="danger-button" id="clear-coal" type="button"><span>⌫</span> 清空动态煤堆</button>
          </div>
        </section>

        <section class="tab-panel" data-panel="export">
          <div class="section">
            <div class="section-heading"><span>01</span><div><h2>源网格继承</h2><p>模式 B+ · 替换与接触补点</p></div></div>
            <div class="mode-card">
              <b>原点不动，空隙按源网格补齐</b>
              <p>原 PLY 顶点顺序和 XY 坐标保持不变；煤堆主体与坡脚缺点处按源扫描方向、间距和相位补点。</p>
            </div>
            <div class="source-grid-stats">
              <div><span>源文件点数</span><b id="source-point-count">—</b></div>
              <div><span>输出点数</span><b id="output-point-count">—</b></div>
            </div>
            <div class="grid-analysis" id="grid-analysis">扫描网格将在生成时自动分析</div>
          </div>

          <div class="section">
            <div class="section-heading"><span>02</span><div><h2>地面识别</h2><p>避免替换设备与墙体点</p></div></div>
            <label class="range-control"><span>地面容差 <output id="ground-tolerance-output">0.35 m</output></span><input id="ground-tolerance" type="range" min="0.05" max="1.5" step="0.05" value="0.35"></label>
            <label class="range-control"><span>坡脚过渡宽度 <output id="transition-cells-output">3 格</output></span><input id="transition-cells" type="range" min="1" max="8" step="1" value="3"></label>
            <label class="check-control"><input id="preserve-z-residual" type="checkbox" checked><span><b>沿用源高程残差</b><small>将原地面点的微小 Z 波动平移到煤堆表面，不改变 XY 网格。</small></span></label>
            <p class="method-note"><i>i</i> 高于局部地面容差的设备、围墙和其他静态点保持原样。</p>
          </div>

          <div class="section export-section">
            <button class="primary-button" id="generate-grid" type="button"><span>⌁</span> 生成并预览覆盖点</button>
            <div class="generation-result" id="grid-result"><span>覆盖区点云</span><b>尚未生成</b></div>
            <div class="generation-breakdown" id="generation-breakdown"><span>原位替换 —</span><span>空隙补点 —</span></div>
            <button class="export-full-button" id="export-ply" type="button">导出模式 B+ PLY</button>
            <p class="method-note"><i>i</i> 原点只改 Z；输出点数等于源点数加接触区实际补点数。</p>
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
scene.enableCameraAxes(element('viewport'))
let field: HeightField | null = null
let sourcePointCloud: PointCloudData | null = null
let gridResult: GridReplacementResult | null = null
let density = 0.85
let groundTolerance = 0.35
let preserveSourceZResidual = true
let transitionCells = 3
let painting = false
let hoverPoint: { x: number; y: number; z: number } | null = null
let lastPaintPoint: { x: number; y: number } | null = null
let lastPaintTime = 0
let statsUpdateTime = 0

const brush: BrushSettings = {
  mode: 'deposit', radius: 3, strength: 2, falloff: 0.65, maxHeight: 18, reposeAngleDeg: 37, relaxation: 0.35,
}

setupTabs()
setupBrushControls()
setupFileImport()
setupGridExportControls()
setupPointerEditing()
setupClearDialog()
requestAnimationFrame(paintLoop)

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function setupTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-tab], [data-panel]').forEach((node) => node.classList.remove('is-active'))
      button.classList.add('is-active')
      document.querySelector(`[data-panel="${button.dataset.tab}"]`)?.classList.add('is-active')
      scene.setGeneratedVisible(button.dataset.tab === 'export')
    })
  })
  scene.setGeneratedVisible(false)
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
  bindRange('repose-angle', (value) => { brush.reposeAngleDeg = value }, (value) => `${Math.round(value)}°`)
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
}

function setupGridExportControls(): void {
  bindRange('ground-tolerance', (value) => {
    groundTolerance = value
    invalidateGridResult()
  }, (value) => `${value.toFixed(2)} m`)
  element<HTMLInputElement>('preserve-z-residual').addEventListener('change', (event) => {
    preserveSourceZResidual = (event.target as HTMLInputElement).checked
    invalidateGridResult()
  })
  bindRange('transition-cells', (value) => {
    transitionCells = Math.round(value)
    invalidateGridResult()
  }, (value) => `${Math.round(value)} 格`)
  element('generate-grid').addEventListener('click', generateGridPointCloud)
  element('export-ply').addEventListener('click', exportGridPointCloud)
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
    gridResult = null
    scene.updateCoalMesh()
    scene.setGridPreview([])
    updateStatistics()
    updateGridResult()
    showToast('动态煤堆已清空，场地点云保持不变')
  })
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
  gridResult = null
  scene.setPointCloud(data)
  scene.setHeightField(field)
  scene.fitToField(field)
  const width = (field.cols - 1) * field.cellSize
  const height = (field.rows - 1) * field.cellSize
  scene.setGridPreview([])
  element('file-name').textContent = data.sourceName
  element('file-meta').textContent = `${data.pointCount.toLocaleString()} 点 · ${width.toFixed(1)} × ${height.toFixed(1)} m · 网格 ${field.cols} × ${field.rows}`
  element('scene-status').textContent = `场景就绪 · ${result.effectiveCellSize.toFixed(2)} m 网格`
  element('source-point-count').textContent = data.pointCount.toLocaleString()
  element('output-point-count').textContent = data.pointCount.toLocaleString()
  updateStatistics()
  updateGridResult()
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
  invalidateGridResult()
  scene.updateCoalMesh()
  if (time - statsUpdateTime > 100) {
    updateStatistics()
    statsUpdateTime = time
  }
}

function generateGridPointCloud(): void {
  if (!field || !sourcePointCloud) return showToast('请先载入场地点云', true)
  const stats = calculateCoalStatistics(field, density)
  if (stats.activeCells === 0) return showToast('请先使用倒煤工具创建煤堆', true)
  const button = element<HTMLButtonElement>('generate-grid')
  button.disabled = true
  button.innerHTML = '<span class="mini-spinner"></span> 正在匹配源网格…'
  setTimeout(() => {
    gridResult = buildGridAlignedReplacements(sourcePointCloud!, field!, {
      groundTolerance,
      preserveSourceZResidual,
      transitionCells,
    })
    scene.setGridPreview([...gridResult.replacements, ...gridResult.additions])
    scene.setGeneratedVisible(true)
    updateGridResult()
    element('output-point-count').textContent = gridResult.outputPointCount.toLocaleString()
    element('grid-analysis').textContent = `扫描方向 ${gridResult.scanGrid.angleDeg.toFixed(1)}° · 点距 ${gridResult.scanGrid.alongSpacing.toFixed(3)} m · 行距 ${gridResult.scanGrid.crossSpacing.toFixed(3)} m`
    button.disabled = false
    button.innerHTML = '<span>⌁</span> 重新生成覆盖点'
    if (gridResult.replacements.length + gridResult.additions.length === 0) showToast('没有找到煤堆覆盖范围，请调整地面容差', true)
    else showToast(`已生成覆盖点：替换 ${gridResult.replacements.length.toLocaleString()}，补点 ${gridResult.additions.length.toLocaleString()}`)
  }, 30)
}

function exportGridPointCloud(): void {
  if (!gridResult || gridResult.replacements.length + gridResult.additions.length === 0) return showToast('请先生成覆盖点云', true)
  if (!sourcePointCloud) return showToast('原始 PLY 数据不可用', true)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const blob = replaceCoveredPointsInSourcePly(sourcePointCloud, gridResult.replacements, gridResult.additions)
  downloadBlob(blob, `coalfield_replaced_${timestamp}.ply`)
  showToast(`已导出模式 B+ PLY：${gridResult.outputPointCount.toLocaleString()} 点`)
}

function updateStatistics(): void {
  if (!field) return
  const stats = calculateCoalStatistics(field, density)
  element('stat-volume').textContent = stats.volume.toLocaleString(undefined, { maximumFractionDigits: 1 })
  element('stat-mass').textContent = stats.mass.toLocaleString(undefined, { maximumFractionDigits: 1 })
  element('stat-height').textContent = stats.maxHeight.toFixed(2)
}

function updateGridResult(): void {
  const result = element('grid-result')
  result.innerHTML = gridResult
    ? `<span>覆盖区点云</span><b>${(gridResult.coveredSourcePoints + gridResult.filledGapPoints).toLocaleString()} 点</b>`
    : '<span>覆盖区点云</span><b>尚未生成</b>'
  element('generation-breakdown').innerHTML = gridResult
    ? `<span>原位替换 ${gridResult.coveredSourcePoints.toLocaleString()}</span><span>空隙补点 ${gridResult.filledGapPoints.toLocaleString()}</span>`
    : '<span>原位替换 —</span><span>空隙补点 —</span>'
}

function invalidateGridResult(): void {
  if (!gridResult) return
  gridResult = null
  scene.setGridPreview([])
  if (sourcePointCloud) element('output-point-count').textContent = sourcePointCloud.pointCount.toLocaleString()
  element('grid-analysis').textContent = '扫描网格将在生成时自动分析'
  updateGridResult()
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

function syncRange(id: string, value: number): void {
  const input = element<HTMLInputElement>(id)
  input.value = String(value)
  input.dispatchEvent(new Event('input'))
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
