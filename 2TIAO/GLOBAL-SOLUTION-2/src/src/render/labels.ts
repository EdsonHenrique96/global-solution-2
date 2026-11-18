import type { Point } from '../sim/types'

const ALAMEDA_ROW: Record<string, number> = { 'Al. Santos': 1, 'Al. Jaú': 2, 'Al. Itu': 3, 'Al. Franca': 4 }
const RUA_COL: Record<string, number> = { 'R. da Consolação': 1, 'R. Bela Cintra': 2, 'R. Haddock Lobo': 3, 'R. Augusta': 4 }

/** A street's three blocks as corner pairs, the middle one first. */
function blocksOf(rua: string): [string, string][] {
  const r = ALAMEDA_ROW[rua]
  const c = RUA_COL[rua]
  const pairs: [string, string][] = r ? [1, 2, 3].map((i) => [`I${r}${i}`, `I${r}${i + 1}`]) : [1, 2, 3].map((i) => [`I${i}${c}`, `I${i + 1}${c}`])
  return [pairs[1], pairs[0], pairs[2]]
}

const LABEL_W = 166
const LABEL_H = 60

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const NOTE_W = 240
const NOTE_H = 92

const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/** A street label's box around its centre, px. */
export const labelRect = (c: Point): Rect => ({ x: c.x - LABEL_W / 2, y: c.y - LABEL_H / 2, w: LABEL_W, h: LABEL_H })


/**
 * Where each street label goes, as a map point: laid out on the whole-grid view, beside one of its blocks, on either side, the first
 * spot that overlaps no label placed before it and stays inside the map; else beside the middle block.
 */
export function placeLabels(
  streets: readonly string[],
  corners: Record<string, Point>,
  base: { map: (p: Point) => Point; unmap: (p: Point) => Point },
  width: number,
  height: number,
  /** Boxes on the 1x view the labels keep clear of (incident notes and markers), px. */
  obstacles: readonly Rect[] = [],
): Record<string, Point> {
  const map = base.map
  const placed: { x: number; y: number }[] = []
  const out: Record<string, Point> = {}
  const free = (x: number, y: number) =>
    x - LABEL_W / 2 >= 4 &&
    y - LABEL_H / 2 >= 4 &&
    x + LABEL_W / 2 <= width - 4 &&
    y + LABEL_H / 2 <= height - 4 &&
    placed.every((q) => Math.abs(q.x - x) > LABEL_W + 6 || Math.abs(q.y - y) > LABEL_H + 6) &&
    obstacles.every((o) => overlap(labelRect({ x, y }), o) === 0)
  // the least covered spot when no spot is free: other labels, obstacles, leaving the map
  const cost = (x: number, y: number) => {
    const r = labelRect({ x, y })
    const outside = Math.max(0, 4 - r.x) + Math.max(0, 4 - r.y) + Math.max(0, r.x + r.w - width + 4) + Math.max(0, r.y + r.h - height + 4)
    return placed.reduce((sum, q) => sum + overlap(r, labelRect(q)), 0) + obstacles.reduce((sum, o) => sum + overlap(r, o), 0) + outside * 200
  }
  for (const rua of streets) {
    let chosen: Point | null = null
    let fallback: { p: Point; cost: number } | null = null
    for (const [a, b] of blocksOf(rua)) {
      const pa = map(corners[a])
      const pb = map(corners[b])
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1
      const nx = -(pb.y - pa.y) / len
      const ny = (pb.x - pa.x) / len
      // far enough from the street that the box clears it, sliding along the block if needed
      const off = Math.abs(nx) * (LABEL_W / 2) + Math.abs(ny) * (LABEL_H / 2) + 14
      const ux = (pb.x - pa.x) / len
      const uy = (pb.y - pa.y) / len
      for (const along of [0, -0.25, 0.25]) {
        for (const side of [1, -1]) {
          const p = { x: mid.x + ux * len * along + nx * off * side, y: mid.y + uy * len * along + ny * off * side }
          if (free(p.x, p.y)) {
            chosen = p
            break
          }
          const c = cost(p.x, p.y)
          if (!fallback || c < fallback.cost) fallback = { p, cost: c }
        }
        if (chosen) break
      }
      if (chosen) break
    }
    const spot = chosen ?? fallback!.p
    placed.push(spot)
    out[rua] = base.unmap(spot)
  }
  return out
}

/**
 * Where each incident's note goes (its top-left, px): of the spots around its marker, the one that
 * stays inside the map and covers the least of the street labels, unit icons, markers and the notes
 * placed before it.
 */
export function placeNotes(markers: readonly { key: string; at: Point }[], avoid: readonly Rect[], width: number, height: number): Record<string, Point> {
  const taken: Rect[] = [...avoid, ...markers.map((m) => ({ x: m.at.x - 16, y: m.at.y - 16, w: 32, h: 32 }))]
  const out: Record<string, Point> = {}
  for (const { key, at } of markers) {
    const spots: Point[] = []
    for (const far of [0, 70, 140]) {
      spots.push(
        { x: at.x + 20 + far, y: at.y - NOTE_H + 10 },
        { x: at.x + 20 + far, y: at.y - 10 },
        { x: at.x - NOTE_W - 20 - far, y: at.y - NOTE_H + 10 },
        { x: at.x - NOTE_W - 20 - far, y: at.y - 10 },
        { x: at.x - NOTE_W / 2, y: at.y - NOTE_H - 22 - far },
        { x: at.x - NOTE_W / 2, y: at.y + 22 + far },
      )
    }
    let best = { cost: Infinity, p: spots[0] }
    for (const raw of spots) {
      // slid back inside the map
      const p = { x: Math.min(Math.max(4, raw.x), Math.max(4, width - NOTE_W - 4)), y: Math.min(Math.max(4, raw.y), Math.max(4, height - NOTE_H - 4)) }
      const r = { x: p.x, y: p.y, w: NOTE_W, h: NOTE_H }
      // a note slid over its own marker hides it
      const cost = taken.reduce((sum, t) => sum + overlap(r, t), 0) + Math.hypot(p.x - raw.x, p.y - raw.y)
      if (cost < best.cost) best = { cost, p }
    }
    out[key] = best.p
    taken.push({ x: best.p.x, y: best.p.y, w: NOTE_W, h: NOTE_H })
  }
  return out
}
