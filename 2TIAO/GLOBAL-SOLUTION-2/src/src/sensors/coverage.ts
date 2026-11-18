import { along } from '@turf/along'
import { bbox } from '@turf/bbox'
import { lineString } from '@turf/helpers'
import { length } from '@turf/length'
import { lineSplit } from '@turf/line-split'
import type { Feature, Polygon } from 'geojson'
import RBush from 'rbush'
import type { Point } from '../sim/types'
import { cameraPolygon, insidePolygon, radarPolygon, type FixedCamera } from './camera'
import { fromLngLat, toLngLat } from './geo'
import type { Segment } from './segments'

/** Below this coverage a sensor's reading of a segment is dropped. */
export const COVERAGE_MIN = 0.3

export interface CoverageEntry {
  sensorId: string
  tipo: 'camera+radar'
  cobertura: number
}

/** Share of a polyline (map metres) inside a polygon: length inside / total length. */
export function segmentCoverage(points: readonly Point[], polygon: Feature<Polygon>): number {
  const line = lineString(points.map(toLngLat))
  const total = length(line, { units: 'meters' })
  if (total === 0) return 0
  const pieces = lineSplit(line, polygon).features
  const parts = pieces.length ? pieces : [line]
  let inside = 0
  for (const piece of parts) {
    const len = length(piece, { units: 'meters' })
    if (len === 0) continue
    const mid = fromLngLat(along(piece, len / 2, { units: 'meters' }).geometry.coordinates)
    if (insidePolygon(mid, polygon)) inside += len
  }
  return Math.min(1, inside / total)
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
  segment: Segment
}

const sameCamera = (a: FixedCamera, b: FixedCamera) =>
  a.position.x === b.position.x &&
  a.position.y === b.position.y &&
  a.heading === b.heading &&
  a.fov === b.fov &&
  a.range === b.range

/**
 * segmentId -> camera+radar units covering it, with the camera's coverage. An R-tree of segment bounding boxes finds the
 * candidates for each camera polygon. Rebuilt only when a camera changes, never per tick.
 */
export class CoverageIndex {
  private readonly tree = new RBush<Box>()
  private cameras = new Map<string, FixedCamera>()
  private polygons = new Map<string, Feature<Polygon>>()
  private beams = new Map<string, Feature<Polygon>>()
  private index = new Map<string, CoverageEntry[]>()
  private readonly lengths: Map<string, number>
  rebuilds = 0

  constructor(segments: readonly Segment[]) {
    this.lengths = new Map(segments.map((s) => [s.id, s.length]))
    this.tree.load(
      segments.map((segment) => {
        const [minX, minY, maxX, maxY] = bbox(lineString(segment.points.map(toLngLat)))
        return { minX, minY, maxX, maxY, segment }
      }),
    )
  }

  setCameras(cameras: readonly FixedCamera[]): void {
    this.cameras = new Map(cameras.map((c) => [c.id, { ...c, position: { ...c.position } }]))
    this.rebuild()
  }

  /** Applies a camera's new settings; rebuilds only if something actually changed. */
  updateCamera(camera: FixedCamera): void {
    const current = this.cameras.get(camera.id)
    if (current && sameCamera(current, camera)) return
    this.cameras.set(camera.id, { ...camera, position: { ...camera.position } })
    this.rebuild()
  }

  polygon(cameraId: string): Feature<Polygon> | undefined {
    return this.polygons.get(cameraId)
  }

  /** The unit's radar beam. */
  beam(cameraId: string): Feature<Polygon> | undefined {
    return this.beams.get(cameraId)
  }

  lengthOf(segmentId: string): number {
    return this.lengths.get(segmentId) ?? 0
  }

  /** Segments a camera covers, with coverage. */
  coveredBy(cameraId: string): { segmentId: string; cobertura: number }[] {
    const out: { segmentId: string; cobertura: number }[] = []
    for (const [segmentId, list] of this.index) {
      const e = list.find((x) => x.sensorId === cameraId)
      if (e) out.push({ segmentId, cobertura: e.cobertura })
    }
    return out.sort((a, b) => a.segmentId.localeCompare(b.segmentId))
  }

  entries(segmentId: string): CoverageEntry[] {
    return this.index.get(segmentId) ?? []
  }

  private rebuild(): void {
    this.rebuilds += 1
    this.polygons = new Map()
    this.beams = new Map()
    this.index = new Map()
    for (const camera of this.cameras.values()) {
      const polygon = cameraPolygon(camera)
      this.polygons.set(camera.id, polygon)
      this.beams.set(camera.id, radarPolygon(camera))
      const [minX, minY, maxX, maxY] = bbox(polygon)
      for (const { segment } of this.tree.search({ minX, minY, maxX, maxY })) {
        const cobertura = segmentCoverage(segment.points, polygon)
        if (cobertura <= 0) continue
        const list = this.index.get(segment.id) ?? []
        list.push({ sensorId: camera.id, tipo: 'camera+radar', cobertura })
        this.index.set(segment.id, list)
      }
    }
  }
}
