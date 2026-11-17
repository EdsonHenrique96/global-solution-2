import type { RoadNetwork } from './types'

/**
 * Fixed synthetic neighbourhood: one origin (west), one destination (east), three routes
 * (north, central, south) and four intersections. Deterministic: no randomness.
 */
export function buildRoadNetwork(): RoadNetwork {
  const origin = { x: 60, y: 300 }
  const destination = { x: 940, y: 300 }
  return {
    width: 1000,
    height: 600,
    origin: { ...origin },
    destination: { ...destination },
    intersections: [
      { id: 'I1', position: { x: 300, y: 300 } },
      { id: 'I2', position: { x: 700, y: 300 } },
      { id: 'I3', position: { x: 500, y: 120 } },
      { id: 'I4', position: { x: 500, y: 480 } },
    ],
    routes: [
      {
        id: 'norte',
        points: [{ ...origin }, { x: 180, y: 300 }, { x: 300, y: 120 }, { x: 700, y: 120 }, { x: 820, y: 300 }, { ...destination }],
        intersectionIds: ['I3'],
      },
      {
        id: 'central',
        points: [{ ...origin }, { x: 300, y: 300 }, { x: 700, y: 300 }, { ...destination }],
        intersectionIds: ['I1', 'I2'],
      },
      {
        id: 'sul',
        points: [{ ...origin }, { x: 180, y: 300 }, { x: 300, y: 480 }, { x: 700, y: 480 }, { x: 820, y: 300 }, { ...destination }],
        intersectionIds: ['I4'],
      },
    ],
  }
}
