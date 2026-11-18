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
): Record<string, Point> {
  const map = base.map
  const placed: { x: number; y: number }[] = []
  const out: Record<string, Point> = {}
  const free = (x: number, y: number) =>
    x - LABEL_W / 2 >= 4 &&
    y - LABEL_H / 2 >= 4 &&
    x + LABEL_W / 2 <= width - 4 &&
    y + LABEL_H / 2 <= height - 4 &&
    placed.every((q) => Math.abs(q.x - x) > LABEL_W + 6 || Math.abs(q.y - y) > LABEL_H + 6)
  for (const rua of streets) {
    let chosen: Point | null = null
    let fallback: Point | null = null
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
          fallback ??= p
          if (free(p.x, p.y)) {
            chosen = p
            break
          }
        }
        if (chosen) break
      }
      if (chosen) break
    }
    const spot = chosen ?? fallback!
    placed.push(spot)
    out[rua] = base.unmap(spot)
  }
  return out
}
