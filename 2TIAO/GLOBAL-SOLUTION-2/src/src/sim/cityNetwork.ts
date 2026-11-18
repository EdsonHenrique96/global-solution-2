import { project } from '../sensors/geo'
import type { Intersection, RoadNetwork } from './types'

/** Alamedas, top to bottom of the grid (rows 1-4). */
export const ALAMEDAS = ['Al. Santos', 'Al. Jaú', 'Al. Itu', 'Al. Franca'] as const
/** Ruas, left to right of the grid (columns 1-4). */
export const RUAS = ['R. da Consolação', 'R. Bela Cintra', 'R. Haddock Lobo', 'R. Augusta'] as const

/**
 * The 16 corners, lat/lng from OpenStreetMap (shared node of both ways, 2026-11-18), Jardins /
 * Cerqueira César, São Paulo.
 */
const CORNERS: Record<string, [number, number]> = {
  I11: [-23.55652, -46.66405],
  I12: [-23.55742, -46.66299],
  I13: [-23.55825, -46.66204],
  I14: [-23.55904, -46.66116],
  I21: [-23.55743, -46.66485],
  I22: [-23.55829, -46.66388],
  I23: [-23.55912, -46.66294],
  I24: [-23.55989, -46.66206],
  I31: [-23.55831, -46.66577],
  I32: [-23.55917, -46.6648],
  I33: [-23.56, -46.66386],
  I34: [-23.56077, -46.66299],
  I41: [-23.5592, -46.6667],
  I42: [-23.56007, -46.66572],
  I43: [-23.56088, -46.66479],
  I44: [-23.56165, -46.66392],
}

/** Margin around the corners in the drawing, metres. */
const MARGIN_M = 60

/** The 4×4 grid of real streets (AD-039, AD-043). Deterministic. */
export function buildCityNetwork(): RoadNetwork {
  const intersections: Intersection[] = []
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 4; col++) {
      const id = `I${row}${col}`
      const [lat, lng] = CORNERS[id]
      intersections.push({ id, nome: `${ALAMEDAS[row - 1]} × ${RUAS[col - 1]}`, lat, lng, position: project(lat, lng), row, col })
    }
  }
  const xs = intersections.map((i) => i.position.x)
  const ys = intersections.map((i) => i.position.y)
  return {
    intersections,
    bounds: {
      minX: Math.min(...xs) - MARGIN_M,
      minY: Math.min(...ys) - MARGIN_M,
      maxX: Math.max(...xs) + MARGIN_M,
      maxY: Math.max(...ys) + MARGIN_M,
    },
  }
}

/** Corners on the edge of the grid: where simulated trips start and end. */
export function borderIds(network: RoadNetwork): string[] {
  return network.intersections.filter((i) => i.row === 1 || i.row === 4 || i.col === 1 || i.col === 4).map((i) => i.id)
}
