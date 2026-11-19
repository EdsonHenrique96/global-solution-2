import { describe, expect, it } from 'vitest'
import { cameraPolygon, insidePolygon, type FixedCamera } from './camera'

const cam = (id: string, x: number, y: number, heading = 90, fov = 90, range = 100): FixedCamera => ({
  id,
  position: { x, y },
  heading,
  fov,
  range,
})

describe('sensors', () => {
  describe('camera', () => {
    it('builds a GeoJSON sector from position heading FOV and range', () => {
      const poly = cameraPolygon(cam('X', 0, 0, 90, 90, 100))
      expect(poly.type).toBe('Feature')
      expect(poly.geometry.type).toBe('Polygon')
      expect(insidePolygon({ x: 50, y: 0 }, poly)).toBe(true)
      expect(insidePolygon({ x: -50, y: 0 }, poly)).toBe(false)
      expect(insidePolygon({ x: 50, y: 60 }, poly)).toBe(false)
      expect(insidePolygon({ x: 120, y: 0 }, poly)).toBe(false)
      // heading 0 looks up the map (smaller y)
      const up = cameraPolygon(cam('U', 0, 0, 0, 60, 100))
      expect(insidePolygon({ x: 0, y: -50 }, up)).toBe(true)
      expect(insidePolygon({ x: 0, y: 50 }, up)).toBe(false)
    })
  })
})
