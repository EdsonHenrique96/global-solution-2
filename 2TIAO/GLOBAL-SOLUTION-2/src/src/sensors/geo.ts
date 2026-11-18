import type { Point } from '../sim/types'

/** The projection's origin: the corner Al. Santos × R. da Consolação (I11). */
export const ORIGIN_LAT = -23.55652
export const ORIGIN_LNG = -46.66405
const M_PER_DEG_LAT = 110_574
const M_PER_DEG_LNG = 111_320 * Math.cos((ORIGIN_LAT * Math.PI) / 180)

/** Local equirectangular projection: metres from I11, x east, y south (north up on screen). */
export function project(lat: number, lng: number): Point {
  return { x: (lng - ORIGIN_LNG) * M_PER_DEG_LNG, y: (ORIGIN_LAT - lat) * M_PER_DEG_LAT }
}

/** Map metres -> [lng, lat] (GeoJSON order), for Turf. */
export function toLngLat(p: Point): [number, number] {
  return [ORIGIN_LNG + p.x / M_PER_DEG_LNG, ORIGIN_LAT - p.y / M_PER_DEG_LAT]
}

export function fromLngLat([lng, lat]: number[]): Point {
  return project(lat, lng)
}
