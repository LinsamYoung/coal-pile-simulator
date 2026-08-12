export class HeightField {
  readonly rows: number
  readonly cols: number
  readonly cellSize: number
  readonly originX: number
  readonly originY: number
  readonly ground: Float32Array
  readonly coal: Float32Array
  readonly enabled: Uint8Array

  constructor(options: {
    rows: number
    cols: number
    cellSize: number
    originX?: number
    originY?: number
    ground?: Float32Array
    enabled?: Uint8Array
  }) {
    const { rows, cols, cellSize, originX = 0, originY = 0 } = options
    if (rows < 2 || cols < 2 || cellSize <= 0) {
      throw new Error('高度场至少需要 2×2 个格点，且网格尺寸必须为正数。')
    }
    const size = rows * cols
    if (options.ground && options.ground.length !== size) {
      throw new Error('地面高度数组尺寸与网格不一致。')
    }
    if (options.enabled && options.enabled.length !== size) {
      throw new Error('可编辑区域数组尺寸与网格不一致。')
    }
    this.rows = rows
    this.cols = cols
    this.cellSize = cellSize
    this.originX = originX
    this.originY = originY
    this.ground = options.ground ?? new Float32Array(size)
    this.coal = new Float32Array(size)
    this.enabled = options.enabled ?? new Uint8Array(size).fill(1)
  }

  get size(): number {
    return this.rows * this.cols
  }

  index(row: number, col: number): number {
    return row * this.cols + col
  }

  xAt(col: number): number {
    return this.originX + col * this.cellSize
  }

  yAt(row: number): number {
    return this.originY + row * this.cellSize
  }

  surfaceAt(index: number): number {
    return this.ground[index] + this.coal[index]
  }

  clearCoal(): void {
    this.coal.fill(0)
  }
}
