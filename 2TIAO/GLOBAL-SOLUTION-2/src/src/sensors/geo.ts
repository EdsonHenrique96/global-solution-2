import type { Point } from '../sim/types'

/** Map metres -> lon/lat near the equator, where 1 degree ~ 111,320 m in both axes. */
export const METERS_PER_DEGREE = 111_320

/** Map coordinates are metres with y growing down the screen; north is up. */
export function toLngLat(p: Point): [number, number] {
  return [p.x / METERS_PER_DEGREE, -p.y / METERS_PER_DEGREE]
}

export function fromLngLat([lng, lat]: number[]): Point {
  return { x: lng * METERS_PER_DEGREE, y: -lat * METERS_PER_DEGREE }
}
