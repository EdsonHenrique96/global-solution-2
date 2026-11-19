import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import { sector } from '@turf/sector'
import type { Feature, Polygon } from 'geojson'
import type { Point } from '../sim/types'
import { toLngLat } from './geo'

/** A fixed camera on a pole: its cone is its field of view (kept for the vision of V4). */
export interface FixedCamera {
  id: string
  position: Point
  /** Degrees, 0 = north (up the map), clockwise. */
  heading: number
  /** Camera field of view, degrees. */
  fov: number
  /** Camera range, metres. */
  range: number
}

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

export function insidePolygon(p: Point, polygon: Feature<Polygon>): boolean {
  return booleanPointInPolygon(point(toLngLat(p)), polygon)
}

/** Camera fov and range of the plate cameras: one block. */
export const UNIT_FOV = 40
export const UNIT_RANGE = 130

/**
 * The 12 monitored segments (AD-068): each gets an entry and an exit plate camera. The other 36
 * segments are left without a pair ("estimado", AD-023).
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
