import type { Car, Point, Route } from './types'

function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function routeLength(route: Route): number {
  let total = 0
  for (let i = 1; i < route.points.length; i++) {
    total += segmentLength(route.points[i - 1], route.points[i])
  }
  return total
}

/** Point at `distance` along the route's polyline, clamped to its ends. */
export function positionOnRoute(route: Route, distance: number): Point {
  const { points } = route
  if (distance <= 0) return { ...points[0] }
  let remaining = distance
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const len = segmentLength(a, b)
    if (remaining <= len) {
      const t = len === 0 ? 0 : remaining / len
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    remaining -= len
  }
  return { ...points[points.length - 1] }
}

/** Free-flow movement: constant speed, no interaction with other cars. */
export function advanceCar(car: Car, dtMs: number): Car {
  return { ...car, distance: car.distance + car.speed * (dtMs / 1000) }
}
