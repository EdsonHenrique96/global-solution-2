import type { SimulationState } from '../sim/SimulationEngine'
import type { RouteStatus } from '../capacity/CapacityModel'
import type { Phase } from '../sim/trafficLight'
import type { Point, RoadNetwork } from '../sim/types'

const PADDING = 24

const COLORS = {
  background: '#0f172a',
  road: '#334155',
  selection: '#f8fafc',
  intersectionFill: '#1e293b',
  intersectionStroke: '#94a3b8',
  endpoint: '#e2e8f0',
  label: '#e2e8f0',
  lightText: '#0f172a',
  droneArea: 'rgba(56, 189, 248, 0.10)',
  droneEdge: 'rgba(56, 189, 248, 0.55)',
  droneBody: '#38bdf8',
}

const STATUS_COLORS: Record<RouteStatus, string> = {
  fluindo: '#22c55e',
  carregado: '#facc15',
  congestionado: '#ef4444',
  'sem dados': '#94a3b8',
}

/** What the capacity layer adds to a frame. */
export interface SceneOverlay {
  routeStatus?: Record<string, RouteStatus>
  selectedRoute?: string
}

const PHASE_COLORS: Record<Phase, string> = {
  verde: '#22c55e',
  amarelo: '#facc15',
  vermelho: '#ef4444',
}

/** Fits the network's logical space into the canvas, centred, without cropping. */
export function fitTransform(network: RoadNetwork, width: number, height: number) {
  const scale = Math.max(
    0,
    Math.min((width - PADDING * 2) / network.width, (height - PADDING * 2) / network.height),
  )
  const offsetX = (width - network.width * scale) / 2
  const offsetY = (height - network.height * scale) / 2
  return {
    scale,
    map: (p: Point): Point => ({ x: offsetX + p.x * scale, y: offsetY + p.y * scale }),
    unmap: (p: Point): Point => ({ x: (p.x - offsetX) / scale, y: (p.y - offsetY) / scale }),
  }
}

/** Screen distance (px) within which a click picks a route. */
export const ROUTE_PICK_PX = 14

/** Distance from p to segment ab. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
}

/** Screen radius (px) within which a press grabs a drone. */
export function droneGrabRadius(scale: number): number {
  return Math.max(14, 22 * scale)
}

/** Draws one frame. Coordinates are CSS pixels; `dpr` scales them onto the backing store. */
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

  const tracePath = (points: Point[]) => {
    ctx.beginPath()
    points.forEach((p, i) => {
      const q = map(p)
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
  }

  // Roads: the selected one gets a light halo, then asphalt, then a centre line in the
  // colour of the route's state (grey without data).
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.setLineDash([])
  const selected = network.routes.find((r) => r.id === overlay.selectedRoute)
  if (selected) {
    tracePath(selected.points)
    ctx.strokeStyle = COLORS.selection
    ctx.lineWidth = Math.max(8, 32 * scale)
    ctx.stroke()
  }
  for (const route of network.routes) {
    tracePath(route.points)
    ctx.strokeStyle = COLORS.road
    ctx.lineWidth = Math.max(4, 22 * scale)
    ctx.stroke()
  }
  // central last, so the shared stretches near origin and destination show its colour
  const byLayer = [...network.routes].sort((a, b) => Number(a.id === 'central') - Number(b.id === 'central'))
  for (const route of byLayer) {
    tracePath(route.points)
    ctx.strokeStyle = STATUS_COLORS[overlay.routeStatus?.[route.id] ?? 'sem dados']
    ctx.lineWidth = Math.max(2, 5 * scale)
    ctx.stroke()
  }

  // Drones: vision area under everything else that moves.
  for (const drone of state.drones) {
    const c = map(drone.position)
    ctx.beginPath()
    ctx.arc(c.x, c.y, drone.radius * scale, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.droneArea
    ctx.fill()
    ctx.lineWidth = Math.max(1, 1.5 * scale)
    ctx.strokeStyle = COLORS.droneEdge
    ctx.setLineDash([6 * scale, 6 * scale])
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Traffic lights: one per intersection, coloured by phase, with the seconds left.
  const radius = Math.max(6, 13 * scale)
  const lights = new Map(state.lights.map((l) => [l.intersectionId, l]))
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${Math.max(9, Math.round(11 * scale))}px system-ui, sans-serif`
  for (const intersection of network.intersections) {
    const c = map(intersection.position)
    const light = lights.get(intersection.id)
    ctx.beginPath()
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = light ? PHASE_COLORS[light.phase] : COLORS.intersectionFill
    ctx.fill()
    ctx.lineWidth = Math.max(1, 2 * scale)
    ctx.strokeStyle = COLORS.intersectionStroke
    ctx.stroke()
    if (light && Number.isFinite(light.remainingS)) {
      ctx.fillStyle = COLORS.lightText
      ctx.fillText(`${Math.ceil(light.remainingS)}s`, c.x, c.y)
    }
  }

  // Origin and destination markers with labels.
  const marker = Math.max(8, 26 * scale)
  const fontSize = Math.max(10, Math.round(16 * scale))
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  for (const [point, label] of [
    [network.origin, 'Origem'],
    [network.destination, 'Destino'],
  ] as const) {
    const c = map(point)
    ctx.fillStyle = COLORS.endpoint
    ctx.fillRect(c.x - marker / 2, c.y - marker / 2, marker, marker)
    ctx.fillStyle = COLORS.label
    ctx.fillText(label, c.x, c.y + marker / 2 + 4)
  }

  // Cars are simulated but not drawn (AD-013): the map shows the roads' state, not each car.

  // Drone bodies and labels on top, so they stay grabbable.
  const body = Math.max(8, 16 * scale)
  ctx.font = `700 ${Math.max(10, Math.round(13 * scale))}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  for (const drone of state.drones) {
    const c = map(drone.position)
    ctx.fillStyle = COLORS.droneBody
    ctx.fillRect(c.x - body / 2, c.y - body / 2, body, body)
    ctx.fillStyle = COLORS.label
    ctx.fillText(drone.id, c.x, c.y - body / 2 - 2)
  }
}
