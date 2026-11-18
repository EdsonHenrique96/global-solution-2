import { ALAMEDAS, RUAS } from '../sim/cityNetwork'
import type { Axis, Point, RoadNetwork } from '../sim/types'

/** Each direction is drawn and measured this far to the right of the street's centre line. */
export const LANE_OFFSET_M = 4

/** A directed road segment between two neighbouring corners: the unit of decision (AD-022). */
export interface Segment {
  /** `<de>><para>`, e.g. `I11>I12` (door 1). */
  id: string
  from: string
  to: string
  /** The street it runs along. */
  rua: string
  axis: Axis
  /** Its lane: start and end, offset to the right of travel. */
  points: Point[]
  /** Corner to corner, metres. */
  length: number
  lanes: number
}

/** Every pair of neighbouring corners, both directions: 24 blocks × 2 = 48 segments. */
export function buildSegments(network: RoadNetwork): Segment[] {
  const at = new Map(network.intersections.map((i) => [`${i.row},${i.col}`, i]))
  const segments: Segment[] = []
  const add = (a: RoadNetwork['intersections'][number], b: RoadNetwork['intersections'][number], axis: Axis) => {
    for (const [p, q] of [
      [a, b],
      [b, a],
    ]) {
      const dx = q.position.x - p.position.x
      const dy = q.position.y - p.position.y
      const length = Math.hypot(dx, dy)
      // right of travel, with y pointing south: (-dy, dx) / length
      const ox = (-dy / length) * LANE_OFFSET_M
      const oy = (dx / length) * LANE_OFFSET_M
      segments.push({
        id: `${p.id}>${q.id}`,
        from: p.id,
        to: q.id,
        rua: axis === 'H' ? ALAMEDAS[p.row - 1] : RUAS[p.col - 1],
        axis,
        points: [
          { x: p.position.x + ox, y: p.position.y + oy },
          { x: q.position.x + ox, y: q.position.y + oy },
        ],
        length,
        lanes: 1,
      })
    }
  }
  for (const i of network.intersections) {
    const right = at.get(`${i.row},${i.col + 1}`)
    const below = at.get(`${i.row + 1},${i.col}`)
    if (right) add(i, right, 'H')
    if (below) add(i, below, 'V')
  }
  return segments
}

/** Point `d` metres along a segment's lane, clamped to its ends. */
export function pointOnSegment(segment: Segment, d: number): Point {
  const [a, b] = segment.points
  const t = segment.length === 0 ? 0 : Math.min(1, Math.max(0, d / segment.length))
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

const parse = (id: string) => {
  const m = /^I(\d)(\d)>I(\d)(\d)$/.exec(id)
  return m ? { r1: +m[1], c1: +m[2], r2: +m[3], c2: +m[4] } : null
}

/** "I14>I13" -> "Al. Santos, R. Augusta → R. Haddock Lobo"; "I12>I22" -> "R. Bela Cintra, Al. Santos → Al. Jaú". */
export function segmentName(id: string): string {
  const p = parse(id)
  if (!p) return id
  if (p.r1 === p.r2) return `${ALAMEDAS[p.r1 - 1]}, ${RUAS[p.c1 - 1]} → ${RUAS[p.c2 - 1]}`
  return `${RUAS[p.c1 - 1]}, ${ALAMEDAS[p.r1 - 1]} → ${ALAMEDAS[p.r2 - 1]}`
}

/** Street names of a path, consecutive repeats merged: ["Al. Santos", "R. Augusta"]. */
export function pathStreets(ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const p = parse(id)
    if (!p) continue
    const rua = p.r1 === p.r2 ? ALAMEDAS[p.r1 - 1] : RUAS[p.c1 - 1]
    if (out[out.length - 1] !== rua) out.push(rua)
  }
  return out
}
