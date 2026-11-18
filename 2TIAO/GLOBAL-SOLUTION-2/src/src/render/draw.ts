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

/** The centre of the grid. */
export function gridCenter(network: RoadNetwork): Point {
  const { minX, minY, maxX, maxY } = network.bounds
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/** Keeps the view's centre inside the grid (AC 48); at 1× it is the grid's centre. */
export function clampView(network: RoadNetwork, view: MapView): MapView {
  if (view.zoom <= 1) return { zoom: 1, center: gridCenter(network) }
  const { minX, minY, maxX, maxY } = network.bounds
  return { zoom: view.zoom, center: { x: Math.min(maxX, Math.max(minX, view.center.x)), y: Math.min(maxY, Math.max(minY, view.center.y)) } }
}

/** Margin around the corners in the drawing, metres. */
const MARGIN_M = 60

/** The angle the alamedas run at (Al. Santos, west to east): the drawing turns by minus this so they lie horizontal. */
export function gridAngle(network: RoadNetwork): number {
  const at = (id: string) => network.intersections.find((i) => i.id === id)?.position
  const a = at('I11')
  const b = at('I14')
  return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0
}

const turn = (v: Point, angle: number): Point => ({ x: v.x * Math.cos(angle) - v.y * Math.sin(angle), y: v.x * Math.sin(angle) + v.y * Math.cos(angle) })

/**
 * Fits the grid into the canvas, centred, turned so the alamedas lie horizontal and stretched to
 * fill the canvas like the prototype's schematic map; then applies the view's zoom and centre.
 * `scale` is the smaller of the two axes' px per metre; `turnScreen` takes a vector on the screen
 * (px) to map metres.
 */
export function fitTransform(network: RoadNetwork, width: number, height: number, view?: MapView) {
  const angle = -gridAngle(network)
  const c = gridCenter(network)
  const turned = network.intersections.map((i) => turn({ x: i.position.x - c.x, y: i.position.y - c.y }, angle))
  const w = Math.max(...turned.map((p) => p.x)) - Math.min(...turned.map((p) => p.x)) + MARGIN_M * 2
  const h = Math.max(...turned.map((p) => p.y)) - Math.min(...turned.map((p) => p.y)) + MARGIN_M * 2
  const zoom = view?.zoom ?? 1
  const sx = Math.max(0, (width - PADDING * 2) / w) * zoom
  const sy = Math.max(0, (height - PADDING * 2) / h) * zoom
  const scale = Math.min(sx, sy)
  const center = view?.center ?? c
  return {
    scale,
    map: (p: Point): Point => {
      const q = turn({ x: p.x - center.x, y: p.y - center.y }, angle)
      return { x: width / 2 + q.x * sx, y: height / 2 + q.y * sy }
    },
    unmap: (p: Point): Point => {
      const q = turn({ x: (p.x - width / 2) / (sx || 1), y: (p.y - height / 2) / (sy || 1) }, -angle)
      return { x: q.x + center.x, y: q.y + center.y }
    },
    turnScreen: (v: Point): Point => turn({ x: v.x / (sx || 1), y: v.y / (sy || 1) }, -angle),
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
