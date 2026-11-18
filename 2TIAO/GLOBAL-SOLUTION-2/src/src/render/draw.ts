import type { RouteStatus } from '../capacity/CapacityModel'
import { cameraPolygon, radarPolygon } from '../sensors/camera'
import { fromLngLat } from '../sensors/geo'
import { pointOnSegment } from '../sensors/segments'
import { ALAMEDAS, RUAS } from '../sim/cityNetwork'
import type { SimulationState } from '../sim/SimulationEngine'
import type { Phase } from '../sim/trafficLight'
import type { Point, RoadNetwork } from '../sim/types'

const PADDING = 24

const COLORS = {
  background: '#0f172a',
  street: '#1e293b',
  selection: '#f8fafc',
  blockage: '#dc2626',
  blockageMark: '#ffffff',
  label: '#cbd5e1',
  lightRing: '#0f172a',
  cameraArea: 'rgba(56, 189, 248, 0.10)',
  cameraEdge: 'rgba(56, 189, 248, 0.55)',
  cameraBody: '#38bdf8',
  radarArea: 'rgba(251, 191, 36, 0.28)',
  radarEdge: 'rgba(251, 191, 36, 0.8)',
}

/** How a segment is painted by its fused state (AC 14). */
export function segmentStyle(estado: RouteStatus): { color: string; dash: number[] } {
  switch (estado) {
    case 'fluindo':
      return { color: '#22c55e', dash: [] }
    case 'carregado':
      return { color: '#facc15', dash: [] }
    case 'congestionado':
      return { color: '#ef4444', dash: [] }
    default:
      return { color: '#94a3b8', dash: [6, 5] }
  }
}

/** What the page adds to a frame: the state of each segment and the selection. */
export interface SceneOverlay {
  segmentStatus?: Record<string, RouteStatus>
  selectedSegment?: string
  /** Which colours the segments take: their state (default) or their camera coverage. */
  layer?: 'estado' | 'cobertura'
  /** Best camera coverage of each segment, 0..1. */
  segmentCoverage?: Record<string, number>
}

export type CoverageBand = 'sem cobertura' | 'baixa' | 'parcial' | 'total'

/** 0 -> none; below 0.3 (the reading cut-off) -> low; below 0.8 -> partial; else full. */
export function coverageBand(cobertura: number): CoverageBand {
  if (cobertura <= 0) return 'sem cobertura'
  if (cobertura < 0.3) return 'baixa'
  if (cobertura < 0.8) return 'parcial'
  return 'total'
}

const BAND_COLORS: Record<CoverageBand, string> = {
  'sem cobertura': '#ef4444',
  baixa: '#f97316',
  parcial: '#facc15',
  total: '#22c55e',
}

const PHASE_COLORS: Record<Phase, string> = {
  verde: '#22c55e',
  amarelo: '#facc15',
  vermelho: '#ef4444',
}

/** Fits the network's bounds into the canvas, centred, without cropping. */
export function fitTransform(network: RoadNetwork, width: number, height: number) {
  const { minX, minY, maxX, maxY } = network.bounds
  const w = maxX - minX
  const h = maxY - minY
  const scale = Math.max(0, Math.min((width - PADDING * 2) / w, (height - PADDING * 2) / h))
  const offsetX = (width - w * scale) / 2
  const offsetY = (height - h * scale) / 2
  return {
    scale,
    map: (p: Point): Point => ({ x: offsetX + (p.x - minX) * scale, y: offsetY + (p.y - minY) * scale }),
    unmap: (p: Point): Point => ({ x: (p.x - offsetX) / scale + minX, y: (p.y - offsetY) / scale + minY }),
  }
}

/** Screen distance (px) within which a click picks a road segment. */
export const ROUTE_PICK_PX = 10

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
  return Math.max(10, 12 * scale)
}

const unit = (a: Point, b: Point) => {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
}

/**
 * Draws one frame of the clean map (AC 13): streets with each direction as its own lane coloured
 * by state, street names, the lights, the camera+radar units and the blockages. No cars, no trip
 * ends, no background map. Coordinates are CSS pixels; `dpr` scales them onto the backing store.
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
  const { scale, map } = fitTransform(network, width, height)
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

  // Streets: one dark casing per block, under both lanes.
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.setLineDash([])
  for (const s of state.segments) {
    if (s.from > s.to) continue
    line([at.get(s.from)!.position, at.get(s.to)!.position])
    ctx.strokeStyle = COLORS.street
    ctx.lineWidth = Math.max(8, 16 * scale)
    ctx.stroke()
  }

  const selected = state.segments.find((s) => s.id === overlay.selectedSegment)
  if (selected) {
    line(selected.points)
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = Math.max(6, 8 * scale)
    ctx.stroke()
  }

  // Lanes: each direction in the colour of its state, or of its coverage.
  ctx.lineCap = 'butt'
  for (const s of state.segments) {
    line(s.points)
    if (overlay.layer === 'cobertura') {
      const band = coverageBand(overlay.segmentCoverage?.[s.id] ?? 0)
      ctx.strokeStyle = BAND_COLORS[band]
      ctx.setLineDash(band === 'sem cobertura' ? [6, 5] : [])
    } else {
      const style = segmentStyle(overlay.segmentStatus?.[s.id] ?? 'sem dados')
      ctx.strokeStyle = style.color
      ctx.setLineDash(style.dash)
    }
    ctx.lineWidth = Math.max(2, 3 * scale)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Camera cones and radar beams, under the markers.
  const ring = (coords: number[][], fill: string, edge: string, dashed: boolean) => {
    ctx.beginPath()
    coords.forEach((c, i) => {
      const q = map(fromLngLat(c))
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
    ctx.closePath()
    ctx.fillStyle = fill
    ctx.fill()
    ctx.lineWidth = 1
    ctx.strokeStyle = edge
    ctx.setLineDash(dashed ? [4, 4] : [])
    ctx.stroke()
    ctx.setLineDash([])
  }
  for (const camera of state.cameras) {
    ring(cameraPolygon(camera).geometry.coordinates[0], COLORS.cameraArea, COLORS.cameraEdge, true)
    ring(radarPolygon(camera).geometry.coordinates[0], COLORS.radarArea, COLORS.radarEdge, false)
  }

  // Street names: each alameda and rua once, along its first block.
  ctx.fillStyle = COLORS.label
  ctx.font = `600 ${Math.max(10, Math.round(11 * Math.min(1.4, scale)))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  const label = (text: string, a: Point, b: Point) => {
    const p = map({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    const q = map(b)
    const pa = map(a)
    let angle = Math.atan2(q.y - pa.y, q.x - pa.x)
    if (angle > Math.PI / 2) angle -= Math.PI
    if (angle < -Math.PI / 2) angle += Math.PI
    ctx.save()
    ctx.translate(p.x, p.y)
    ctx.rotate(angle)
    ctx.fillText(text, 0, -Math.max(7, 10 * scale))
    ctx.restore()
  }
  ALAMEDAS.forEach((name, r) => label(name, at.get(`I${r + 1}1`)!.position, at.get(`I${r + 1}2`)!.position))
  RUAS.forEach((name, c) => label(name, at.get(`I3${c + 1}`)!.position, at.get(`I4${c + 1}`)!.position))

  // Traffic lights: at each corner, a dot along the alameda for phase H and one along the rua for V.
  const h = unit(at.get('I11')!.position, at.get('I12')!.position)
  const v = unit(at.get('I11')!.position, at.get('I21')!.position)
  const lights = new Map(state.lights.map((l) => [l.intersectionId, l]))
  const r = Math.max(3, 4 * scale)
  const off = Math.max(5, 7 * scale)
  for (const i of network.intersections) {
    const light = lights.get(i.id)
    const c = map(i.position)
    for (const [dir, phase] of [
      [h, light?.h],
      [v, light?.v],
    ] as const) {
      ctx.beginPath()
      ctx.arc(c.x - dir.x * off, c.y - dir.y * off, r, 0, Math.PI * 2)
      ctx.fillStyle = phase ? PHASE_COLORS[phase] : COLORS.street
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = COLORS.lightRing
      ctx.stroke()
    }
  }

  // Accidents: a red square with a cross where the segment is blocked.
  const blockSize = Math.max(10, 12 * scale)
  for (const b of state.blockages ?? []) {
    const s = state.segments.find((x) => x.id === b.segmentId)
    if (!s) continue
    const c = map(pointOnSegment(s, b.distance))
    ctx.fillStyle = COLORS.blockage
    ctx.fillRect(c.x - blockSize / 2, c.y - blockSize / 2, blockSize, blockSize)
    ctx.fillStyle = COLORS.blockageMark
    ctx.font = `700 ${Math.round(blockSize * 0.8)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('✕', c.x, c.y)
  }

  // Unit bodies and ids on top, so they stay grabbable.
  const body = Math.max(7, 9 * scale)
  ctx.font = `700 ${Math.max(9, Math.round(10 * Math.min(1.4, scale)))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  for (const camera of state.cameras) {
    const c = map(camera.position)
    ctx.fillStyle = COLORS.cameraBody
    ctx.fillRect(c.x - body / 2, c.y - body / 2, body, body)
    // the id a little way into its own cone: two units on one corner keep their labels apart
    const h = (camera.heading * Math.PI) / 180
    const reach = Math.max(18, 22 * scale)
    ctx.fillStyle = COLORS.label
    ctx.fillText(camera.id, c.x + Math.sin(h) * reach, c.y - Math.cos(h) * reach + 4)
  }
}
