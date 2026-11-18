import { distanceAlongRoute, positionOnRoute, routeLength } from '../sim/car'
import type { Point, RoadNetwork, Route } from '../sim/types'

/** Length of each route's entrance lane and of the shared arrival stretch, metres. */
export const SHARED_M = 120

/** A road segment between two nodes of the network: the unit of decision (AD-022). */
export interface Segment {
  id: string
  /** Routes that drive along it. */
  routeIds: string[]
  /** Where it starts and ends along each of those routes, metres. */
  from: Record<string, number>
  to: Record<string, number>
  points: Point[]
  length: number
  lanes: number
}

/** The part of a route's polyline between two distances along it. */
export function slicePolyline(route: Route, d0: number, d1: number): Point[] {
  const out: Point[] = [positionOnRoute(route, d0)]
  let walked = 0
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1]
    const b = route.points[i]
    walked += Math.hypot(b.x - a.x, b.y - a.y)
    if (walked > d0 + 1e-9 && walked < d1 - 1e-9) out.push({ ...b })
  }
  out.push(positionOnRoute(route, d1))
  return out
}

/**
 * The network's segments: each route's entrance lane (origin -> fork), its middle stretches cut
 * at its traffic lights, and the arrival stretch (junction -> destination) all routes share.
 */
export function buildSegments(network: RoadNetwork): Segment[] {
  const positions = new Map(network.intersections.map((i) => [i.id, i.position]))
  const segments: Segment[] = []
  for (const route of network.routes) {
    const L = routeLength(route)
    const lights = route.intersectionIds
      .map((id) => ({ id, at: distanceAlongRoute(route, positions.get(id)!) }))
      .sort((a, b) => a.at - b.at)
    const nodes = [
      { name: 'F', at: SHARED_M },
      ...lights.map((l) => ({ name: l.id, at: l.at })),
      { name: 'M', at: L - SHARED_M },
    ]
    const add = (id: string, d0: number, d1: number) =>
      segments.push({
        id,
        routeIds: [route.id],
        from: { [route.id]: d0 },
        to: { [route.id]: d1 },
        points: slicePolyline(route, d0, d1),
        length: d1 - d0,
        lanes: 1,
      })
    add(`${route.id}-entrada`, 0, SHARED_M)
    for (let i = 1; i < nodes.length; i++) add(`${route.id}-${nodes[i - 1].name}-${nodes[i].name}`, nodes[i - 1].at, nodes[i].at)
  }
  // the arrival stretch is one physical segment for every route
  const first = network.routes[0]
  const L0 = routeLength(first)
  segments.push({
    id: 'chegada',
    routeIds: network.routes.map((r) => r.id),
    from: Object.fromEntries(network.routes.map((r) => [r.id, routeLength(r) - SHARED_M])),
    to: Object.fromEntries(network.routes.map((r) => [r.id, routeLength(r)])),
    points: slicePolyline(first, L0 - SHARED_M, L0),
    length: SHARED_M,
    lanes: 1,
  })
  return segments
}

/** The segment a car is on, given its route and distance along it. */
export function segmentAt(segments: readonly Segment[], routeId: string, distance: number): Segment | undefined {
  return segments.find(
    (s) => s.routeIds.includes(routeId) && distance >= s.from[routeId] - 1e-9 && distance < s.to[routeId] + 1e-9,
  )
}

const SEGMENT_ROUTE_NAMES: Record<string, string> = { central: 'Central', norte: 'Norte', sul: 'Sul' }

/** "central-I1-I2" -> "Central I1→I2"; "norte-entrada" -> "Norte entrada"; "chegada" -> "Chegada". */
export function segmentName(id: string): string {
  if (id === 'chegada') return 'Chegada'
  const [route, ...rest] = id.split('-')
  const name = SEGMENT_ROUTE_NAMES[route] ?? route
  if (rest.length === 1) return `${name} ${rest[0]}`
  return `${name} ${rest.join('→')}`
}

