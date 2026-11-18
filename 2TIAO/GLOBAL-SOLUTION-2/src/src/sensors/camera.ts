import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import { sector } from '@turf/sector'
import type { Feature, Polygon } from 'geojson'
import type { Point } from '../sim/types'
import { toLngLat } from './geo'

/**
 * A camera+radar unit on one pole (AD-035): the camera counts cars in its cone (computer vision),
 * the radar measures the speed of the cars in its narrow beam, pointing the same way.
 */
export interface FixedCamera {
  id: string
  position: Point
  /** Degrees, 0 = north (up the map), clockwise. Camera and radar share it. */
  heading: number
  /** Camera field of view, degrees. */
  fov: number
  /** Camera range, metres. */
  range: number
}

/** The radar beam: fixed on every unit. */
export const RADAR = { fov: 12, range: 150 } as const

export const SECTOR_STEPS = 32

/** Bearing from a to b in map metres (y south): degrees, 0 = north, clockwise. */
export function bearing(a: Point, b: Point): number {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI
  return Math.round(((deg % 360) + 360) % 360)
}

const sectorOf = (position: Point, heading: number, fov: number, range: number): Feature<Polygon> =>
  sector(point(toLngLat(position)), range, heading - fov / 2, heading + fov / 2, { units: 'meters', steps: SECTOR_STEPS })

/** The area the camera sees: a GeoJSON sector. */
export function cameraPolygon(camera: FixedCamera): Feature<Polygon> {
  return sectorOf(camera.position, camera.heading, camera.fov, camera.range)
}

/** The area the radar measures: a narrow sector with the camera's heading. */
export function radarPolygon(camera: FixedCamera): Feature<Polygon> {
  return sectorOf(camera.position, camera.heading, RADAR.fov, RADAR.range)
}

export function insidePolygon(p: Point, polygon: Feature<Polygon>): boolean {
  return booleanPointInPolygon(point(toLngLat(p)), polygon)
}

/** Camera fov and range of the default units: one block, both directions of the street. */
export const UNIT_FOV = 40
export const UNIT_RANGE = 130

/**
 * The 12 units installed at the start (AD-039): each on a corner, looking down one block. Half of
 * the 48 segments are left without a camera ("estimado", AD-023).
 */
export const DEFAULT_UNIT_BLOCKS: readonly [string, string][] = [
  ['I11', 'I12'],
  ['I12', 'I13'],
  ['I22', 'I23'],
  ['I31', 'I32'],
  ['I33', 'I34'],
  ['I42', 'I43'],
  ['I11', 'I21'],
  ['I31', 'I41'],
  ['I22', 'I32'],
  ['I13', 'I23'],
  ['I33', 'I43'],
  ['I24', 'I34'],
]

export const unitId = (n: number) => `U${String(n).padStart(2, '0')}`

/** The default units for a set of corner positions. */
export function defaultUnits(positions: ReadonlyMap<string, Point>): FixedCamera[] {
  return DEFAULT_UNIT_BLOCKS.map(([a, b], i) => {
    const pa = positions.get(a)!
    const pb = positions.get(b)!
    return { id: unitId(i + 1), position: { ...pa }, heading: bearing(pa, pb), fov: UNIT_FOV, range: UNIT_RANGE }
  })
}
