import type { Segment } from '../sensors/segments'

/**
 * Cheapest path from corner `from` to corner `to` as a list of segment ids (Dijkstra). `cost`
 * defaults to length in metres; segments in `avoid` are not used. null when there is none;
 * [] when from === to. Ties break by segment id, so the result is deterministic.
 */
export function shortestPath(
  segments: readonly Segment[],
  from: string,
  to: string,
  cost: (s: Segment) => number = (s) => s.length,
  avoid: ReadonlySet<string> = new Set(),
): string[] | null {
  if (from === to) return []
  const out = new Map<string, Segment[]>()
  for (const s of segments) {
    if (avoid.has(s.id)) continue
    const list = out.get(s.from)
    if (list) list.push(s)
    else out.set(s.from, [s])
  }
  for (const list of out.values()) list.sort((a, b) => a.id.localeCompare(b.id))
  const dist = new Map<string, number>([[from, 0]])
  const via = new Map<string, Segment>()
  const done = new Set<string>()
  for (;;) {
    let node: string | null = null
    let best = Infinity
    for (const [n, d] of dist) {
      if (!done.has(n) && (d < best || (d === best && node !== null && n < node))) {
        node = n
        best = d
      }
    }
    if (node === null) return null
    if (node === to) break
    done.add(node)
    for (const s of out.get(node) ?? []) {
      const d = best + cost(s)
      if (d < (dist.get(s.to) ?? Infinity) - 1e-9) {
        dist.set(s.to, d)
        via.set(s.to, s)
      }
    }
  }
  const path: string[] = []
  for (let n = to; n !== from; ) {
    const s = via.get(n)!
    path.push(s.id)
    n = s.from
  }
  return path.reverse()
}
