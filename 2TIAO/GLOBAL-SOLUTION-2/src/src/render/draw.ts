import { positionOnRoute } from '../sim/car'
import type { SimulationState } from '../sim/SimulationEngine'
import type { Point } from '../sim/types'

const PADDING = 24

const ROUTE_COLORS: Record<string, string> = {
  norte: '#3b82f6',
  central: '#f59e0b',
  sul: '#10b981',
}

const COLORS = {
  background: '#0f172a',
  road: '#334155',
  laneMark: '#cbd5e1',
  intersectionFill: '#1e293b',
  intersectionStroke: '#94a3b8',
  endpoint: '#e2e8f0',
  label: '#e2e8f0',
}

/** Fits the network's logical space into the canvas, centred, without cropping. */
function fit(state: SimulationState, width: number, height: number) {
  const { network } = state
  const scale = Math.max(
    0,
    Math.min((width - PADDING * 2) / network.width, (height - PADDING * 2) / network.height),
  )
  const offsetX = (width - network.width * scale) / 2
  const offsetY = (height - network.height * scale) / 2
  return {
    scale,
    map: (p: Point): Point => ({ x: offsetX + p.x * scale, y: offsetY + p.y * scale }),
  }
}

/** Draws one frame. Coordinates are CSS pixels; `dpr` scales them onto the backing store. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  state: SimulationState,
  width: number,
  height: number,
  dpr = 1,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = COLORS.background
  ctx.fillRect(0, 0, width, height)

  const { network, cars } = state
  const { scale, map } = fit(state, width, height)
  if (scale === 0) return

  const tracePath = (points: Point[]) => {
    ctx.beginPath()
    points.forEach((p, i) => {
      const q = map(p)
      if (i === 0) ctx.moveTo(q.x, q.y)
      else ctx.lineTo(q.x, q.y)
    })
  }

  // Roads: asphalt, then a dashed lane mark on top.
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const route of network.routes) {
    tracePath(route.points)
    ctx.strokeStyle = COLORS.road
    ctx.lineWidth = Math.max(4, 22 * scale)
    ctx.setLineDash([])
    ctx.stroke()
  }
  for (const route of network.routes) {
    tracePath(route.points)
    ctx.strokeStyle = COLORS.laneMark
    ctx.lineWidth = Math.max(1, 1.5 * scale)
    ctx.setLineDash([8 * scale, 10 * scale])
    ctx.stroke()
  }
  ctx.setLineDash([])

  // Intersections: fixed points where traffic lights will sit (no state colour yet).
  const radius = Math.max(4, 13 * scale)
  for (const intersection of network.intersections) {
    const c = map(intersection.position)
    ctx.beginPath()
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = COLORS.intersectionFill
    ctx.fill()
    ctx.lineWidth = Math.max(1, 2 * scale)
    ctx.strokeStyle = COLORS.intersectionStroke
    ctx.stroke()
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

  // Cars.
  const routes = new Map(network.routes.map((r) => [r.id, r]))
  const carRadius = Math.max(2.5, 7 * scale)
  for (const car of cars) {
    const route = routes.get(car.routeId)
    if (!route) continue
    const c = map(positionOnRoute(route, car.distance))
    ctx.beginPath()
    ctx.arc(c.x, c.y, carRadius, 0, Math.PI * 2)
    ctx.fillStyle = ROUTE_COLORS[car.routeId] ?? '#f8fafc'
    ctx.fill()
  }
}
