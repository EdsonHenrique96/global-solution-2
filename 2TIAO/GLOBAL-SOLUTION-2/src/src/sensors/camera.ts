import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon'
import { point } from '@turf/helpers'
import { sector } from '@turf/sector'
import type { Feature, Polygon } from 'geojson'
import type { Point } from '../sim/types'
import { toLngLat } from './geo'

/** A fixed camera: the always-on base layer of sensors (AD-021, AD-025). */
export interface FixedCamera {
  id: string
  position: Point
  /** Degrees, 0 = up the map (north), clockwise. */
  heading: number
  /** Field of view, degrees. */
  fov: number
  /** Range, metres. */
  range: number
}

export const SECTOR_STEPS = 32

export const DEFAULT_CAMERAS: readonly FixedCamera[] = [
  { id: 'C1', position: { x: 480, y: 150 }, heading: 90, fov: 70, range: 260 },
  { id: 'C2', position: { x: 420, y: 330 }, heading: 90, fov: 70, range: 260 },
  { id: 'C3', position: { x: 480, y: 450 }, heading: 90, fov: 70, range: 260 },
]

/** The area a camera sees: a GeoJSON sector (lon/lat, see geo.ts). */
export function cameraPolygon(camera: FixedCamera): Feature<Polygon> {
  return sector(
    point(toLngLat(camera.position)),
    camera.range,
    camera.heading - camera.fov / 2,
    camera.heading + camera.fov / 2,
    { units: 'meters', steps: SECTOR_STEPS },
  )
}

export function insidePolygon(p: Point, polygon: Feature<Polygon>): boolean {
  return booleanPointInPolygon(point(toLngLat(p)), polygon)
}
