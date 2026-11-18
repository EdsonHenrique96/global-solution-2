import type { SimulationState } from '../sim/SimulationEngine'
import type { Phase } from '../sim/trafficLight'
import type { Point, RoadNetwork } from '../sim/types'
import { NEUTRAL_LANE, NIVEIS, type Nivel } from './levels'

const PADDING = 24

/** The operations-centre palette (design reference "Dashboard · Centro de Operações"). */
export const PALETTE = {
  livre: '#3DBE7A',
  moderado: '#F5D04E',
  intenso: '#F59544',
  critico: '#F0565B',
  semDado: '#5B6676',
  accent: '#7FB5FF',
} as const

const COLORS = {
  background: '#0F151C',
  street: '#06090C',
  /** Streets beyond the monitored grid. */
  outside: '#151D27',
  selection: '#E6EAF0',
  lightRing: '#0B0F14',
}

/** How a lane is painted: the colour of its density level (AD-047), or neutral with the layer off. */
export function laneStyle(nivel: Nivel, density = true): { color: string; dash: number[] } {
  if (!density) return { color: NEUTRAL_LANE, dash: [] }
  return { color: NIVEIS[nivel].color, dash: nivel === 'sem dado' ? [6, 5] : [] }
}

/** What the page adds to a frame. */
export interface SceneOverlay {
  /** The level of each segment; a segment missing here has no data. */
  segmentLevel?: Record<string, Nivel>
  selectedSegment?: string
  /** The "Densidade" layer: off paints every lane neutral. */
  density?: boolean
  view?: MapView
}

/** Zoom (1 = the whole grid) and the map point at the centre of the canvas, metres. */
export interface MapView {
  zoom: number
  center: Point
}

export const ZOOM_STEPS = [1, 1.5, 2, 3] as const

const PHASE_COLORS: Record<Exclude<Phase, 'piscante'>, string> = {
  verde: PALETTE.livre,
  amarelo: PALETTE.moderado,
  vermelho: PALETTE.critico,
}

/** Flashing yellow: lit for half of every second of simulated time. */
export function phaseColor(phase: Phase, timeMs: number): string {
  if (phase !== 'piscante') return PHASE_COLORS[phase]
  return Math.floor(timeMs / 500) % 2 === 0 ? PALETTE.moderado : COLORS.street
}

/**
 * The schematic grid: each block of the real grid is cut into two triangles, and each triangle is
 * mapped affinely onto its place in a regular grid of columns and rows (1-4). Every corner lands
 * exactly on its column and row, so alamedas run horizontal and ruas vertical as in the prototype's
 * map; points outside the grid use the nearest triangle. The coordinates stay the real ones.
 */
interface Triangle {
  real: [Point, Point, Point]
  grid: [Point, Point, Point]
}

const grids = new WeakMap<RoadNetwork, Triangle[]>()

function triangles(network: RoadNetwork): Triangle[] {
  const cached = grids.get(network)
  if (cached) return cached
  const at = new Map(network.intersections.map((i) => [`${i.row},${i.col}`, i.position]))
  const out: Triangle[] = []
  for (let r = 1; r < 4; r++) {
    for (let c = 1; c < 4; c++) {
      const A = at.get(`${r},${c}`)
      const B = at.get(`${r},${c + 1}`)
      const C = at.get(`${r + 1},${c + 1}`)
      const D = at.get(`${r + 1},${c}`)
      if (!A || !B || !C || !D) continue
      const g = (col: number, row: number) => ({ x: col, y: row })
      out.push({ real: [A, B, C], grid: [g(c, r), g(c + 1, r), g(c + 1, r + 1)] })
      out.push({ real: [A, C, D], grid: [g(c, r), g(c + 1, r + 1), g(c, r + 1)] })
    }
  }
  grids.set(network, out)
  return out
}

/** Barycentric weights of p in triangle t. */
function weights(p: Point, t: readonly [Point, Point, Point]): [number, number, number] {
  const [a, b, c] = t
  const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y) || 1
  const w0 = ((b.y - c.y) * (p.x - c.x) + (c.x - b.x) * (p.y - c.y)) / det
  const w1 = ((c.y - a.y) * (p.x - c.x) + (a.x - c.x) * (p.y - c.y)) / det
  return [w0, w1, 1 - w0 - w1]
}

/** Maps p from one side of the triangles to the other: the containing triangle, else the nearest. */
function through(tris: readonly Triangle[], p: Point, from: 'real' | 'grid'): Point {
  const to = from === 'real' ? 'grid' : 'real'
  let best: { t: Triangle; w: [number, number, number]; worst: number } | null = null
  for (const t of tris) {
    const w = weights(p, t[from])
    const worst = Math.min(...w)
    if (!best || worst > best.worst) best = { t, w, worst }
    if (worst >= -1e-9) break
  }
  if (!best) return p
  const [a, b, c] = best.t[to]
  const [w0, w1, w2] = best.w
  return { x: w0 * a.x + w1 * b.x + w2 * c.x, y: w0 * a.y + w1 * b.y + w2 * c.y }
}

/** The centre of the grid: the map point the schematic grid puts at column and row 2.5. */
export function gridCenter(network: RoadNetwork): Point {
  const tris = triangles(network)
  if (tris.length === 0) {
    const { minX, minY, maxX, maxY } = network.bounds
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  }
  return through(tris, { x: 2.5, y: 2.5 }, 'grid')
}

/** Where a map point sits on the schematic grid: column and row, 1-4 inside the grid. */
export function gridOf(network: RoadNetwork, p: Point): Point {
  return through(triangles(network), p, 'real')
}

/** Keeps the view's centre inside the grid, columns and rows 1-4 (AC 48); at 1× it is the grid's centre. */
export function clampView(network: RoadNetwork, view: MapView): MapView {
  if (view.zoom <= 1) return { zoom: 1, center: gridCenter(network) }
  const g = gridOf(network, view.center)
  const inside = { x: Math.min(4, Math.max(1, g.x)), y: Math.min(4, Math.max(1, g.y)) }
  if (inside.x === g.x && inside.y === g.y) return view
  return { zoom: view.zoom, center: through(triangles(network), inside, 'grid') }
}

/** Margin around the outer streets in the drawing, in blocks: the streets run on to the edge. */
const MARGIN_BLOCKS = 0.32

/** Mean length of a block along the alamedas (dx) and along the ruas (dy), metres. */
function blockSize(network: RoadNetwork): Point {
  const at = new Map(network.intersections.map((i) => [`${i.row},${i.col}`, i.position]))
  let h = 0
  let v = 0
  let nh = 0
  let nv = 0
  for (const i of network.intersections) {
    const right = at.get(`${i.row},${i.col + 1}`)
    const below = at.get(`${i.row + 1},${i.col}`)
    if (right) {
      h += Math.hypot(right.x - i.position.x, right.y - i.position.y)
      nh += 1
    }
    if (below) {
      v += Math.hypot(below.x - i.position.x, below.y - i.position.y)
      nv += 1
    }
  }
  return { x: nh ? h / nh : 1, y: nv ? v / nv : 1 }
}

/**
 * Fits the schematic grid into the canvas, centred and stretched to fill it like the prototype's
 * map, then applies the view's zoom and centre. `scale` is about the smaller of the two axes' px
 * per metre.
 */
export function fitTransform(network: RoadNetwork, width: number, height: number, view?: MapView) {
  const tris = triangles(network)
  const span = 3 + MARGIN_BLOCKS * 2
  const zoom = view?.zoom ?? 1
  const sx = Math.max(0, (width - PADDING * 2) / span) * zoom
  const sy = Math.max(0, (height - PADDING * 2) / span) * zoom
  const block = blockSize(network)
  const scale = Math.min(sx / block.x, sy / block.y)
  const centerMap = view?.center ?? gridCenter(network)
  const center = through(tris, centerMap, 'real')
  const map = (p: Point): Point => {
    const g = through(tris, p, 'real')
    return { x: width / 2 + (g.x - center.x) * sx, y: height / 2 + (g.y - center.y) * sy }
  }
  const unmap = (p: Point): Point => through(tris, { x: (p.x - width / 2) / (sx || 1) + center.x, y: (p.y - height / 2) / (sy || 1) + center.y }, 'grid')
  return {
    scale,
    map,
    unmap,
    /** The map point that comes to the canvas centre when the map is dragged by (dx, dy) px. */
    dragCenter: (dx: number, dy: number): Point => unmap({ x: width / 2 - dx, y: height / 2 - dy }),
  }
}

/** Screen distance (px) within which a click picks a road segment. */
export const ROUTE_PICK_PX = 10

/** Screen distance (px) within which a click in "Semáforo" mode picks a corner. */
export const CORNER_PICK_PX = 18

/** Distance from p to segment ab. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
}

/** Screen radius (px) within which a click hits an accident marker. */
export const BLOCKAGE_PICK_PX = 14

/** Screen radius (px) within which a press grabs a unit. */
export function cameraGrabRadius(scale: number): number {
  return Math.max(15, 12 * scale)
}

const unit = (a: Point, b: Point) => {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
}

/**
 * Draws one frame of the clean map: streets with each direction as its own lane coloured by its
 * density level, and the lights. Street labels, unit icons and incident markers are drawn by the
 * page on top. No cars, no background map. Coordinates are CSS pixels; `dpr` scales them onto the
 * backing store.
 */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  state: SimulationState,
  width: number,
  height: number,
  dpr = 1,
  overlay: SceneOverlay = {},
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, width, height)

  const { network } = state
  const { scale, map } = fitTransform(network, width, height, overlay.view)
  if (scale === 0) return
  const at = new Map(network.intersections.map((i) => [i.id, i]))

  const line = (points: Point[]) => {
    ctx.beginPath()
    points.forEach((p, i) => {
      const q = map(p)
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
  }

  // Streets: they run on past the grid to the edge of the map, like the prototype's...
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.setLineDash([])
  /** From p along d to where it leaves the canvas (p itself when it is already outside). */
  const toEdge = (p: Point, d: Point): Point => {
    let t = Infinity
    if (d.x > 1e-9) t = Math.min(t, (width - p.x) / d.x)
    else if (d.x < -1e-9) t = Math.min(t, -p.x / d.x)
    if (d.y > 1e-9) t = Math.min(t, (height - p.y) / d.y)
    else if (d.y < -1e-9) t = Math.min(t, -p.y / d.y)
    const k = Number.isFinite(t) ? Math.max(0, t) : 0
    return { x: p.x + d.x * k, y: p.y + d.y * k }
  }
  const runOn = (a: Point, b: Point) => {
    const pa = map(a)
    const pb = map(b)
    const d = unit(pa, pb)
    const from = toEdge(pa, { x: -d.x, y: -d.y })
    const to = toEdge(pb, d)
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.strokeStyle = COLORS.outside
    ctx.lineWidth = Math.max(10, 18 * scale)
    ctx.stroke()
  }
  for (let k = 1; k <= 4; k++) {
    runOn(at.get(`I${k}1`)!.position, at.get(`I${k}4`)!.position)
    runOn(at.get(`I1${k}`)!.position, at.get(`I4${k}`)!.position)
  }
  // ...and one dark casing per block of the grid, under both lanes.
  for (const s of state.segments) {
    if (s.from > s.to) continue
    line([at.get(s.from)!.position, at.get(s.to)!.position])
    ctx.strokeStyle = COLORS.street
    ctx.lineWidth = Math.max(10, 18 * scale)
    ctx.stroke()
  }

  const selected = state.segments.find((s) => s.id === overlay.selectedSegment)
  if (selected) {
    line(selected.points)
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = Math.max(8, 9 * scale)
    ctx.stroke()
  }

  // Lanes: each direction in the colour of its level.
  ctx.lineCap = 'butt'
  for (const s of state.segments) {
    line(s.points)
    const style = laneStyle(overlay.segmentLevel?.[s.id] ?? 'sem dado', overlay.density ?? true)
    ctx.strokeStyle = style.color
    ctx.setLineDash(style.dash)
    ctx.lineWidth = Math.max(4, 4.5 * scale)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Traffic lights: at each corner, a dot along the alameda for phase H and one along the rua for V.
  const h = unit(map(at.get('I11')!.position), map(at.get('I12')!.position))
  const v = unit(map(at.get('I11')!.position), map(at.get('I21')!.position))
  const lights = new Map(state.lights.map((l) => [l.intersectionId, l]))
  const r = Math.max(3.5, 4 * scale)
  const off = Math.max(8, 9 * scale)
  for (const i of network.intersections) {
    const light = lights.get(i.id)
    const c = map(i.position)
    for (const [dir, phase] of [
      [h, light?.h],
      [v, light?.v],
    ] as const) {
      ctx.beginPath()
      ctx.arc(c.x - dir.x * off, c.y - dir.y * off, r, 0, Math.PI * 2)
      ctx.fillStyle = phase ? phaseColor(phase, state.timeMs) : COLORS.street
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = COLORS.lightRing
      ctx.stroke()
    }
  }
}
